/**
 * The transport layer every resource module sits on top of.
 *
 * Responsibilities, in rough order of how much they matter in practice:
 *
 *  1. Turn Substack's HTML 404 pages into small, typed errors. Substack has no
 *     documented API and no JSON error envelope; a wrong id or a renamed route
 *     returns ~68 KB of the marketing site. Detecting that early is the single
 *     highest-value thing this file does.
 *  2. Keep our request rate polite. Substack publishes no rate limits and did
 *     not throttle 600 concurrent reads in testing, but a bounded concurrency
 *     and an optional inter-request delay keep us from looking like an attack.
 *  3. Validate against Zod schemas without making validation a failure mode.
 *     The upstream is undocumented and mutates without notice, so the default
 *     mode logs mismatches and hands back the data anyway.
 *  4. Attach the session cookie when there is one, and never require it.
 */

import type { ZodType } from 'zod';
import {
  SubstackHttpError,
  SubstackParseError,
  SubstackTimeoutError,
  SubstackValidationError,
  looksLikeHtml,
  previewBody,
} from './errors.js';
import { resolveConfig, type ResolvedConfig, type SubstackClientConfig } from './config.js';

/** A value that can appear in a query string. Arrays become repeated keys. */
export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export interface RequestOptions<T = unknown> {
  /** Query parameters. `undefined` and `null` values are dropped. */
  query?: Record<string, QueryValue>;
  /**
   * Zod schema to validate the response against. Behaviour depends on the
   * client's `validate` mode; see {@link SubstackClientConfig.validate}.
   */
  schema?: ZodType<T>;
  /**
   * Override the base URL for this one call. Used for publication-scoped
   * endpoints that live on `https://{subdomain}.substack.com`.
   */
  baseUrl?: string;
  /**
   * Per-request cookie override. Lets the REST gateway serve callers who each
   * bring their own cookie without constructing a new client per request.
   * Pass `null` to explicitly send no cookie even when one is configured.
   */
  cookie?: string | null;
  /** HTTP method. Defaults to GET; every public read endpoint is a GET. */
  method?: 'GET' | 'POST';
  /** JSON body, for the rare POST. */
  body?: unknown;
  /**
   * Redirect handling. Defaults to `'follow'`. Use `'manual'` when the redirect
   * itself is the information you want — see {@link SubstackHttp.resolveRedirect}.
   */
  redirect?: 'follow' | 'manual';
  /** AbortSignal from the caller, combined with the internal timeout. */
  signal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bounded-concurrency gate. Keeps N requests in flight and queues the rest. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

/** Statuses worth retrying: transient throttling and server-side faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class SubstackHttp {
  readonly config: ResolvedConfig;
  private readonly gate: Semaphore;
  private lastRequestStart = 0;
  /** Dedupes lenient-mode validation warnings so one bad field cannot flood stderr. */
  private readonly warned = new Set<string>();

  constructor(config: SubstackClientConfig = {}) {
    this.config = resolveConfig(config);
    this.gate = new Semaphore(this.config.concurrency);
  }

  /** True when a session cookie is configured. Handy for conditional logic. */
  get hasCookie(): boolean {
    return this.config.cookie !== null;
  }

  /**
   * Perform a request and return the parsed (and optionally validated) body.
   *
   * @param path Absolute URL, or a path like `/api/v1/categories` which is
   *             appended to `baseUrl`.
   */
  async request<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const url = this.buildUrl(path, options);
    const data = await this.fetchJson(url, options);
    return this.validate(url, data, options.schema);
  }

  /** Same as {@link request} but skips validation and returns the raw payload. */
  async requestRaw(path: string, options: Omit<RequestOptions, 'schema'> = {}): Promise<unknown> {
    return this.fetchJson(this.buildUrl(path, options), options);
  }

  /**
   * Issue a request without following redirects and return the `Location` header.
   *
   * This exists for one specific and load-bearing case. Substack has no endpoint
   * mapping a numeric user id to a handle, and a handle is the only key
   * `public_profile` accepts. But `GET /profile/{userId}` responds `301` with
   * `Location: /@{handle}` — so the redirect target *is* the lookup.
   *
   * That matters because note reactors identify people by numeric id and carry
   * no handle. Without this bridge there is no route from "who liked my note" to
   * "what does that person subscribe to", which is the entire point of the
   * targeting workflow.
   *
   * Returns null when the response was not a 3xx.
   */
  async resolveRedirect(
    path: string,
    options: Omit<RequestOptions, 'schema' | 'redirect'> = {},
  ): Promise<string | null> {
    const url = this.buildUrl(path, options);
    const release = await this.gate.acquire();
    try {
      await this.pace();
      const response = await this.fetchOnce(url, { ...options, redirect: 'manual' });
      // Drain the body even though we only want the header, so the connection
      // can be reused rather than held open by undici.
      await response.arrayBuffer().catch(() => undefined);
      if (this.config.debug) {
        process.stderr.write(`[substack] GET ${response.status} (redirect probe) ${url}\n`);
      }
      if (response.status < 300 || response.status >= 400) return null;
      return response.headers.get('location');
    } finally {
      release();
    }
  }

  // -- internals ------------------------------------------------------------

  private buildUrl(path: string, options: Pick<RequestOptions, 'query' | 'baseUrl'>): string {
    const base = options.baseUrl?.replace(/\/+$/, '') ?? this.config.baseUrl;
    const url = new URL(/^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // Substack uses repeated-key arrays, e.g. ?types[]=note&types[]=comment
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  private resolveCookie(options: Pick<RequestOptions, 'cookie'>): string | null {
    // An explicit `null` means "send nothing", which is different from omitted.
    if (options.cookie === null) return null;
    if (options.cookie !== undefined) {
      return options.cookie.includes('=') ? options.cookie : `substack.sid=${options.cookie}`;
    }
    return this.config.cookie;
  }

  private async fetchJson(url: string, options: RequestOptions<unknown>): Promise<unknown> {
    const release = await this.gate.acquire();
    try {
      await this.pace();
      return await this.attemptWithRetries(url, options);
    } finally {
      release();
    }
  }

  /** Enforce `minDelayMs` between request starts. */
  private async pace(): Promise<void> {
    const { minDelayMs } = this.config;
    if (minDelayMs <= 0) return;
    const now = Date.now();
    const earliest = this.lastRequestStart + minDelayMs;
    // Claim our slot synchronously so concurrent callers stagger correctly.
    this.lastRequestStart = earliest > now ? earliest : now;
    if (earliest > now) await sleep(earliest - now);
  }

  private async attemptWithRetries(url: string, options: RequestOptions<unknown>): Promise<unknown> {
    const { retries, debug } = this.config;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const isLast = attempt === retries;
      try {
        const started = Date.now();
        const response = await this.fetchOnce(url, options);
        const body = await response.text();

        if (debug) {
          process.stderr.write(
            `[substack] ${options.method ?? 'GET'} ${response.status} ${Date.now() - started}ms ${url}\n`,
          );
        }

        if (!response.ok) {
          const contentType = response.headers.get('content-type');
          const error = new SubstackHttpError(
            response.status,
            response.statusText,
            url,
            previewBody(body),
            looksLikeHtml(body, contentType),
          );
          if (isRetryableStatus(response.status) && !isLast) {
            await sleep(this.backoffMs(attempt, response.headers.get('retry-after')));
            lastError = error;
            continue;
          }
          throw error;
        }

        return this.parseJson(url, body, response.headers.get('content-type'));
      } catch (error) {
        // Never retry our own deterministic errors.
        if (
          error instanceof SubstackHttpError ||
          error instanceof SubstackParseError ||
          error instanceof SubstackValidationError
        ) {
          throw error;
        }
        lastError = error;
        if (isLast) break;
        await sleep(this.backoffMs(attempt, null));
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error(`Request to ${url} failed: ${String(lastError)}`);
  }

  private async fetchOnce(url: string, options: RequestOptions<unknown>): Promise<Response> {
    const { timeoutMs, userAgent, fetchImpl } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    const onCallerAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'user-agent': userAgent,
    };
    const cookie = this.resolveCookie(options);
    if (cookie) headers['cookie'] = cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    try {
      return await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: options.redirect ?? 'follow',
      });
    } catch (error) {
      // An abort we caused is a timeout; an abort the caller caused propagates.
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new SubstackTimeoutError(url, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private parseJson(url: string, body: string, contentType: string | null): unknown {
    if (looksLikeHtml(body, contentType)) {
      throw new SubstackParseError(url, previewBody(body, 200), contentType);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new SubstackParseError(url, previewBody(body, 200), contentType);
    }
  }

  /** Exponential backoff with jitter, honouring `Retry-After` when present. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    }
    const base = Math.min(500 * 2 ** attempt, 8_000);
    return base + Math.floor(Math.random() * 250);
  }

  private validate<T>(url: string, data: unknown, schema?: ZodType<T>): T {
    if (!schema || this.config.validate === 'off') return data as T;

    const result = schema.safeParse(data);
    if (result.success) return result.data;

    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

    if (this.config.validate === 'strict') {
      throw new SubstackValidationError(url, issues, data);
    }

    // Lenient: the data is probably still usable. Warn once per distinct shape
    // of problem, then hand it back. Substack adding a field must not break
    // a caller mid-run.
    const key = `${new URL(url).pathname}|${issues[0] ?? ''}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      process.stderr.write(
        `[substack] schema drift at ${new URL(url).pathname} (returning raw data):\n` +
          issues.map((i) => `  - ${i}`).join('\n') +
          '\n',
      );
    }
    return data as T;
  }
}
