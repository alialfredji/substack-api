/**
 * Configuration resolution and cookie handling.
 *
 * Design rule: the cookie is always optional, at every layer. Nothing in this
 * project requires authentication to function. A cookie only ever *upgrades*
 * a response (it makes viewer-relative fields resolve correctly). That keeps
 * the read surface anonymous by default, which is both the safer posture and
 * the one with no account attached to it.
 */

/** How strictly to check upstream payloads against our Zod schemas. */
export type ValidationMode = 'lenient' | 'strict' | 'off';

export interface SubstackClientConfig {
  /**
   * Optional session cookie. Accepts either form:
   *   - the bare `substack.sid` value:  `'s%3AabC123...'`
   *   - a full cookie header:          `'substack.sid=s%3Aab...; substack.lli=1'`
   *
   * Enables viewer-relative fields, most importantly `is_subscribed` and
   * `is_following` on note reactors.
   */
  cookie?: string | undefined;
  /** Root API host. Default `https://substack.com`. */
  baseUrl?: string;
  /** Sent as the User-Agent header. Default is a normal desktop Chrome UA. */
  userAgent?: string;
  /** Max simultaneous in-flight upstream requests. Default 4. */
  concurrency?: number;
  /** Minimum milliseconds between two request starts. Default 0. */
  minDelayMs?: number;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Retry attempts after the first try, for 429/5xx/network errors. Default 2. */
  retries?: number;
  /** Schema validation strictness. Default 'lenient'. */
  validate?: ValidationMode;
  /** Log each upstream request to stderr. Default false. */
  debug?: boolean;
  /** Injectable fetch, for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Fully-resolved config with no optional fields, used internally. */
export interface ResolvedConfig {
  cookie: string | null;
  baseUrl: string;
  userAgent: string;
  concurrency: number;
  minDelayMs: number;
  timeoutMs: number;
  retries: number;
  validate: ValidationMode;
  debug: boolean;
  fetchImpl: typeof fetch;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Turn whatever the user gave us into a valid `Cookie` header value.
 *
 * People reliably paste just the `substack.sid` value out of DevTools, so we
 * accept that and wrap it. If the string already contains `=` we assume it is
 * a complete cookie header and pass it through untouched.
 *
 * Returns null for empty/whitespace input, which is the "no cookie" case.
 */
export function normalizeCookie(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  // Already a cookie header (contains at least one name=value pair).
  if (value.includes('=')) return value;
  // A bare sid value.
  return `substack.sid=${value}`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envValidationMode(name: string, fallback: ValidationMode): ValidationMode {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === 'strict' || raw === 'lenient' || raw === 'off' ? raw : fallback;
}

/**
 * Merge explicit options over environment variables over built-in defaults.
 *
 * Precedence, highest first: the `overrides` argument, then `process.env`,
 * then the defaults documented on {@link SubstackClientConfig}.
 */
export function resolveConfig(overrides: SubstackClientConfig = {}): ResolvedConfig {
  return {
    cookie: normalizeCookie(overrides.cookie ?? process.env['SUBSTACK_COOKIE']),
    baseUrl: (overrides.baseUrl ?? process.env['SUBSTACK_BASE_URL'] ?? 'https://substack.com').replace(
      /\/+$/,
      '',
    ),
    userAgent: overrides.userAgent ?? process.env['SUBSTACK_USER_AGENT'] ?? DEFAULT_UA,
    concurrency: Math.max(1, overrides.concurrency ?? envNumber('SUBSTACK_CONCURRENCY', 4)),
    minDelayMs: overrides.minDelayMs ?? envNumber('SUBSTACK_MIN_DELAY_MS', 0),
    timeoutMs: overrides.timeoutMs ?? envNumber('SUBSTACK_TIMEOUT_MS', 15_000),
    retries: overrides.retries ?? envNumber('SUBSTACK_RETRIES', 2),
    validate: overrides.validate ?? envValidationMode('SUBSTACK_VALIDATE', 'lenient'),
    debug: overrides.debug ?? process.env['SUBSTACK_DEBUG'] === '1',
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
  };
}

/** Build the base URL for a publication-scoped call: `https://{subdomain}.substack.com`. */
export function publicationBaseUrl(subdomain: string): string {
  if (!/^[a-z0-9-]+$/i.test(subdomain)) {
    throw new Error(
      `Invalid publication subdomain ${JSON.stringify(subdomain)}. ` +
        `Expected something like "aieworks" (letters, digits, hyphens).`,
    );
  }
  return `https://${subdomain}.substack.com`;
}
