/**
 * substack-api — public entry point.
 *
 * A typed, read-only client for Substack's undocumented public API.
 *
 * ```ts
 * import { createSubstackClient } from 'substack-api';
 *
 * const substack = createSubstackClient();               // anonymous
 * const profile = await substack.profiles.getByHandle('alialfredji');
 * console.log(profile.subscriptions?.length, 'subscriptions');
 * ```
 *
 * The REST gateway is a separate entry point so that library consumers do not
 * pull in Fastify:
 *
 * ```ts
 * import { buildApp } from 'substack-api/dist/server/app.js';
 * ```
 */

// -- client ------------------------------------------------------------------
export { SubstackClient, createSubstackClient } from './client/client.js';
export { SubstackHttp } from './client/http.js';
export type { RequestOptions, QueryValue } from './client/http.js';

// -- configuration -----------------------------------------------------------
export {
  resolveConfig,
  normalizeCookie,
  publicationBaseUrl,
  type SubstackClientConfig,
  type ResolvedConfig,
  type ValidationMode,
} from './client/config.js';
export type { CallOptions, PaginateOptions } from './client/types.js';

// -- errors ------------------------------------------------------------------
export {
  SubstackError,
  SubstackHttpError,
  SubstackParseError,
  SubstackValidationError,
  SubstackTimeoutError,
  SubstackAuthRequiredError,
} from './client/errors.js';

// -- resources (exported so they can be used or extended directly) -----------
export { ProfilesResource } from './client/resources/profiles.js';
export {
  NotesResource,
  type NoteFeedParams,
  type CollectNoteFeedOptions,
} from './client/resources/notes.js';
export {
  PublicationsResource,
  type ArchiveAllOptions,
} from './client/resources/publications.js';
export { DiscoveryResource } from './client/resources/discovery.js';

// -- schemas and types -------------------------------------------------------
export * from './schemas/index.js';
