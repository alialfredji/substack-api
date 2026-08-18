/**
 * Shared call-level types.
 *
 * Every resource method takes an optional trailing {@link CallOptions}. That is
 * what makes "cookie or no cookie" a per-call decision rather than a per-client
 * one, which the REST gateway relies on: one long-lived client can serve many
 * callers who each bring their own cookie (or none).
 */

export interface CallOptions {
  /**
   * Cookie for this single call.
   *   - omitted    -> use whatever the client was constructed with
   *   - a string   -> use this instead (bare sid value or full cookie header)
   *   - `null`     -> send no cookie, even if the client has one
   */
  cookie?: string | null;
  /** Abort this call from the outside. */
  signal?: AbortSignal;
}

/** Options for methods that walk a paginated endpoint to completion. */
export interface PaginateOptions extends CallOptions {
  /** Stop after this many items. Default 100. Guards against runaway loops. */
  limit?: number;
  /** Stop after this many pages regardless of item count. Default 20. */
  maxPages?: number;
}
