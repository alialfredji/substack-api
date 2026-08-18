/**
 * The composed client. This is the main entry point for library consumers.
 *
 * ```ts
 * import { createSubstackClient } from 'substack-api';
 *
 * // No cookie: everything works, viewer-relative fields read false.
 * const substack = createSubstackClient();
 *
 * // With a cookie: is_subscribed / is_following resolve correctly.
 * const authed = createSubstackClient({ cookie: process.env.SUBSTACK_COOKIE });
 * ```
 */

import { SubstackHttp } from './http.js';
import type { SubstackClientConfig } from './config.js';
import { ProfilesResource } from './resources/profiles.js';
import { NotesResource } from './resources/notes.js';
import { PublicationsResource } from './resources/publications.js';
import { DiscoveryResource } from './resources/discovery.js';

export class SubstackClient {
  /** The transport. Exposed so you can make raw calls to endpoints we have not wrapped. */
  readonly http: SubstackHttp;

  /** People: profile lookup, profile search, subscription graphs. */
  readonly profiles: ProfilesResource;
  /** Notes: feeds, single notes, and who reacted to them. */
  readonly notes: NotesResource;
  /** Newsletters: search, archive, posts, comments, recommendations. */
  readonly publications: PublicationsResource;
  /** Categories and leaderboards. */
  readonly discovery: DiscoveryResource;

  constructor(config: SubstackClientConfig = {}) {
    this.http = new SubstackHttp(config);
    this.profiles = new ProfilesResource(this.http);
    this.notes = new NotesResource(this.http);
    this.publications = new PublicationsResource(this.http);
    this.discovery = new DiscoveryResource(this.http);
  }

  /** True when this client was given a session cookie. */
  get authenticated(): boolean {
    return this.http.hasCookie;
  }
}

/** Create a client. All configuration is optional; see {@link SubstackClientConfig}. */
export function createSubstackClient(config: SubstackClientConfig = {}): SubstackClient {
  return new SubstackClient(config);
}
