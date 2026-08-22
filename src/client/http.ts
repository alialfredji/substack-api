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
 *     throttle sustained collection in practice, so conservative defaults,
 *     coordinated cooldowns, and bounded retries keep collectors polite.
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Request aborted'));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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
  /** Lazily-created browser-fingerprinted session for Cloudflare-protected list reads. */
  private protectedSessionPromise: Promise<import('wreq-js').Session> | null = null;
  private lastRequestStart = 0;
  /** A 429 pauses later queued requests too, rather than only the request that hit it. */
  private cooldownUntil = 0;
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

  /** Release the optional native transport session. Safe to call more than once. */
  async close(): Promise<void> {
    await this.resetProtectedSession();
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
      await this.pace(options.signal);
      const response = await this.attemptRedirectWithRetries(url, {
        ...options,
        redirect: 'manual',
      });
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
      await this.pace(options.signal);
      return await this.attemptWithRetries(url, options);
    } finally {
      release();
    }
  }

  /** Enforce `minDelayMs` between request starts. */
  private async pace(signal?: AbortSignal): Promise<void> {
    const { minDelayMs } = this.config;
    const now = Date.now();
    const earliest = Math.max(this.lastRequestStart + minDelayMs, this.cooldownUntil);
    // Claim our slot synchronously so concurrent callers stagger correctly.
    this.lastRequestStart = earliest > now ? earliest : now;
    if (earliest > now) await sleep(earliest - now, signal);
  }

  private async attemptWithRetries(url: string, options: RequestOptions<unknown>): Promise<unknown> {
    const { retries, debug } = this.config;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await this.pace(options.signal);
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
            await this.waitBeforeRetry(
              attempt,
              response.headers.get('retry-after'),
              response.status,
              options.signal,
            );
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
        if (options.signal?.aborted) throw error;
        if (isLast) break;
        await this.waitBeforeRetry(attempt, null, null, options.signal);
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error(`Request to ${url} failed: ${String(lastError)}`);
  }

  private async attemptRedirectWithRetries(
    url: string,
    options: RequestOptions<unknown>,
  ): Promise<Response> {
    const { retries, debug } = this.config;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await this.pace(options.signal);
      const isLast = attempt === retries;
      try {
        const started = Date.now();
        const response = await this.fetchOnce(url, options);
        const body = await response.text();

        if (debug) {
          process.stderr.write(
            `[substack] GET ${response.status} ${Date.now() - started}ms (redirect probe) ${url}\n`,
          );
        }

        if (isRetryableStatus(response.status)) {
          const error = new SubstackHttpError(
            response.status,
            response.statusText,
            url,
            previewBody(body),
            looksLikeHtml(body, response.headers.get('content-type')),
          );
          if (!isLast) {
            await this.waitBeforeRetry(
              attempt,
              response.headers.get('retry-after'),
              response.status,
              options.signal,
            );
            lastError = error;
            continue;
          }
          throw error;
        }

        return response;
      } catch (error) {
        if (error instanceof SubstackHttpError) throw error;
        lastError = error;
        if (options.signal?.aborted) throw error;
        if (isLast) break;
        await this.waitBeforeRetry(attempt, null, null, options.signal);
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error(`Redirect probe to ${url} failed: ${String(lastError)}`);
  }

  private async fetchOnce(url: string, options: RequestOptions<unknown>): Promise<Response> {
    const { timeoutMs, userAgent, fetchImpl } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    const onCallerAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const protectedRequest = this.shouldUseProtectedTransport(url);
    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
    // The protected transport supplies a User-Agent matching its TLS/HTTP2
    // browser profile. Overriding it with the normal Node transport UA would
    // create the exact fingerprint mismatch Cloudflare is checking for.
    if (!protectedRequest) headers['user-agent'] = userAgent;
    const cookie = this.resolveCookie(options);
    if (cookie) headers['cookie'] = cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    try {
      const init: RequestInit = {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: options.redirect ?? 'follow',
      };
      return protectedRequest
        ? await this.fetchWithProtectedTransport(url, init)
        : await fetchImpl(url, init);
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

  /**
   * Substack browser pages can read subscriber lists, while a cold Node TLS
   * client is challenged. A browser-fingerprinted session that first visits
   * the root page receives the ordinary edge cookies and can then make the
   * exact same JSON request. Keep this special case out of every other route.
   */
  private shouldUseProtectedTransport(url: string): boolean {
    if (this.config.fetchImpl !== globalThis.fetch) return false;
    const parsed = new URL(url);
    return (
      parsed.hostname === 'substack.com' &&
      /^\/api\/v1\/user\/\d+\/subscriber-lists$/.test(parsed.pathname)
    );
  }

  private async fetchWithProtectedTransport(url: string, init: RequestInit): Promise<Response> {
    let session = await this.getProtectedSession(init.signal);
    let response = await session.fetch(url, init);

    // Clearance can expire in a long-running gateway. Re-bootstrap once, then
    // let the normal HTTP error path report any persistent challenge.
    if (response.headers.get('cf-mitigated') === 'challenge') {
      await response.arrayBuffer();
      await this.resetProtectedSession(session);
      session = await this.getProtectedSession(init.signal);
      response = await session.fetch(url, init);
    }

    return response as unknown as Response;
  }

  private async getProtectedSession(signal?: AbortSignal | null): Promise<import('wreq-js').Session> {
    if (!this.protectedSessionPromise) {
      const pending = this.createProtectedSession(signal);
      this.protectedSessionPromise = pending;
      void pending.catch(() => {
        if (this.protectedSessionPromise === pending) this.protectedSessionPromise = null;
      });
    }
    return this.protectedSessionPromise;
  }

  private async createProtectedSession(signal?: AbortSignal | null): Promise<import('wreq-js').Session> {
    const { createSession } = await import('wreq-js');
    const session = await createSession({ browser: 'chrome', timeout: this.config.timeoutMs });
    try {
      const response = await session.fetch(`${this.config.baseUrl}/`, { signal });
      const body = await response.text();
      if (!response.ok) {
        throw new SubstackHttpError(
          response.status,
          response.statusText,
          `${this.config.baseUrl}/`,
          previewBody(body),
          looksLikeHtml(body, response.headers.get('content-type')),
        );
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private async resetProtectedSession(expected?: import('wreq-js').Session): Promise<void> {
    const pending = this.protectedSessionPromise;
    if (!pending) return;
    try {
      const session = await pending;
      // Another concurrent request may already have replaced the challenged
      // session. Never let a stale response close that newer session.
      if (expected && session !== expected) return;
      if (this.protectedSessionPromise === pending) this.protectedSessionPromise = null;
      if (!session.closed) await session.close();
    } catch {
      // Failed session creation already cleans up its native resources.
      if (this.protectedSessionPromise === pending) this.protectedSessionPromise = null;
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

  private async waitBeforeRetry(
    attempt: number,
    retryAfter: string | null,
    status: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = this.backoffMs(attempt, retryAfter);
    if (status === 429) {
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs);
    }
    if (this.config.debug) {
      process.stderr.write(
        `[substack] retry ${attempt + 1}/${this.config.retries} in ${delayMs}ms` +
          `${status === null ? '' : ` after HTTP ${status}`}\n`,
      );
    }
    await sleep(delayMs, signal);
  }

  /** Exponential backoff with jitter, honouring seconds or an HTTP date in Retry-After. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const { retryBaseDelayMs, retryMaxDelayMs } = this.config;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, retryMaxDelayMs);
      }
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        return Math.min(Math.max(0, dateMs - Date.now()), retryMaxDelayMs);
      }
    }
    const base = Math.min(retryBaseDelayMs * 2 ** attempt, retryMaxDelayMs);
    const jitterLimit = Math.min(250, Math.max(0, retryMaxDelayMs - base));
    return base + Math.floor(Math.random() * (jitterLimit + 1));
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
