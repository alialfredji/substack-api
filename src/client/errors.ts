/**
 * Error types for the Substack client.
 *
 * A note on why these exist in this shape: Substack's undocumented API does
 * not return JSON errors. A miss returns a 404 with ~68 KB of the marketing
 * site's HTML. So the single most important job of this layer is to detect
 * "this was not JSON" and turn it into a small, readable error instead of
 * letting 68 KB of HTML propagate into a log line or a model's context.
 */

/** Base class for everything this client throws. */
export class SubstackError extends Error {
  override readonly name: string = 'SubstackError';

  constructor(
    message: string,
    /** The URL that was being requested when this failed. */
    readonly url?: string,
  ) {
    super(message);
  }
}

/**
 * Upstream returned a non-2xx status.
 *
 * `bodyPreview` is deliberately truncated. Substack's 404 page is enormous and
 * you never want the whole thing.
 */
export class SubstackHttpError extends SubstackError {
  override readonly name = 'SubstackHttpError';

  constructor(
    readonly status: number,
    readonly statusText: string,
    url: string,
    /** First ~400 chars of the response body, whitespace-collapsed. */
    readonly bodyPreview: string,
    /** True when the body looked like HTML rather than JSON. */
    readonly wasHtml: boolean,
  ) {
    super(
      `Substack responded ${status} ${statusText} for ${url}` +
        (wasHtml
          ? ' (HTML response - this endpoint or id most likely does not exist)'
          : bodyPreview
            ? `: ${bodyPreview}`
            : ''),
      url,
    );
  }

  /** 404 with an HTML body: the canonical "no such endpoint/resource" signal. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Upstream asked us to slow down. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Upstream returned 2xx but the body was not parseable JSON. */
export class SubstackParseError extends SubstackError {
  override readonly name = 'SubstackParseError';

  constructor(
    url: string,
    readonly bodyPreview: string,
    readonly contentType: string | null,
  ) {
    super(
      `Substack returned a non-JSON body for ${url} (content-type: ${contentType ?? 'none'}): ${bodyPreview}`,
      url,
    );
  }
}

/**
 * The response was valid JSON but did not match our Zod schema.
 *
 * Only thrown when validation mode is `strict`. In the default `lenient` mode
 * this is logged and the raw data is returned instead, because the upstream is
 * undocumented and can add or rename fields without notice. Breaking a user's
 * script because Substack added a field would be the wrong trade.
 */
export class SubstackValidationError extends SubstackError {
  override readonly name = 'SubstackValidationError';

  constructor(
    url: string,
    /** Human-readable list of the first few field-level problems. */
    readonly issues: string[],
    /** The raw payload, so callers can still recover the data. */
    readonly data: unknown,
  ) {
    super(
      `Substack response for ${url} did not match the expected schema:\n  - ${issues.join('\n  - ')}`,
      url,
    );
  }
}

/** The request exceeded the configured timeout. */
export class SubstackTimeoutError extends SubstackError {
  override readonly name = 'SubstackTimeoutError';

  constructor(url: string, readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`, url);
  }
}

/**
 * A cookie was required for this call but none was configured.
 *
 * Used by helpers whose entire purpose depends on viewer-relative fields,
 * so they fail loudly rather than silently returning `is_subscribed: false`
 * for everyone and quietly corrupting a targeting list.
 */
export class SubstackAuthRequiredError extends SubstackError {
  override readonly name = 'SubstackAuthRequiredError';

  constructor(what: string) {
    super(
      `${what} requires a Substack session cookie. Set SUBSTACK_COOKIE in your ` +
        `.env, pass { cookie } to createSubstackClient(), or send the ` +
        `x-substack-cookie header when calling the REST gateway.`,
    );
  }
}

/** Collapse a response body into something safe to put in an error message. */
export function previewBody(body: string, max = 400): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Heuristic: does this body look like an HTML page rather than an API payload? */
export function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (contentType?.includes('text/html')) return true;
  return /^\s*(<!doctype html|<html)/i.test(body);
}
