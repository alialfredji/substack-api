/**
 * People: profile lookup, keyword search, and the subscription-graph helpers
 * built on top of them.
 *
 * The reason this resource exists at all is `subscriptions[]`. It ships on
 * every {@link Profile}, including every entry of a search result, so a single
 * `search()` call returns not just a list of people but the newsletters each
 * one reads. That is what makes {@link ProfilesResource.subscriptionOverlap}
 * possible without an extra round trip per person.
 */

import type { SubstackHttp } from '../http.js';
import type { CallOptions, PaginateOptions } from '../types.js';
import {
  ProfileSchema,
  ProfileSearchResultSchema,
  type Profile,
  type ProfileSearchResult,
  type Subscription,
} from '../../schemas/profile.js';
import type { Publication } from '../../schemas/common.js';

/**
 * Result of comparing two people's subscription graphs.
 *
 * Not an upstream shape — this is computed client-side from two
 * {@link ProfilesResource.getSubscriptions} calls, so it has no Zod schema.
 * `score` is a Jaccard index (overlap / union) over publication ids: `0` means
 * no shared subscriptions, `1` means identical reading lists. Using the union
 * as the denominator (rather than, say, the smaller list) avoids rewarding a
 * person who subscribes to almost nothing just because everything they read
 * happens to overlap.
 */
export interface SubscriptionOverlap {
  handleA: string;
  handleB: string;
  subscriptionCountA: number;
  subscriptionCountB: number;
  /** Publications both accounts subscribe to, deduped by publication id. */
  overlap: Publication[];
  overlapCount: number;
  /** Jaccard index over publication ids: `overlapCount / |A ∪ B|`. `0` when both sets are empty. */
  score: number;
}

/** Substack person search and profile lookup, plus subscription-graph comparison. */
export class ProfilesResource {
  /**
   * Numeric user id -> handle. Lives for the lifetime of this client instance,
   * not durably persisted. Exists because a targeting run typically resolves
   * the same reactor ids repeatedly (e.g. the same person liking several of
   * your notes), and each resolution otherwise costs a full redirect probe.
   * Handles are stable in practice but Substack does allow renames, so this is
   * deliberately a per-run cache, not a source of truth to keep across runs.
   */
  private readonly handleCache = new Map<number, string>();

  constructor(private readonly http: SubstackHttp) {}

  /**
   * Fetch a single profile by handle (the `@name` in a profile URL).
   *
   * There is no numeric-id or slug variant of this endpoint — verified live:
   * `/api/v1/user/{numericId}/public_profile`, `/api/v1/profile/{slug}`, and
   * `/api/v1/user/{handle}/profile` all 404. Handle is the only key.
   */
  async getByHandle(handle: string, opts?: CallOptions): Promise<Profile> {
    return this.http.request(`/api/v1/user/${encodeURIComponent(handle)}/public_profile`, {
      schema: ProfileSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Search profiles by free-text query.
   *
   * `page` is required upstream — Substack returns a 400 if it is omitted —
   * so this method defaults it to `0` rather than making every caller learn
   * that the hard way. There is no working `limit` param: page size is a
   * fixed 20, confirmed by requesting the same page with no limit, `limit=3`,
   * and `limit=50` and getting back the identical 20 ids in the identical
   * order every time. Use {@link searchAll} if you want more than one page.
   */
  async search(params: { query: string; page?: number }, opts?: CallOptions): Promise<ProfileSearchResult> {
    return this.http.request('/api/v1/profile/search', {
      query: { query: params.query, page: params.page ?? 0 },
      schema: ProfileSearchResultSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Walk `search()` across pages until `more` is false, or a safety limit
   * is hit.
   *
   * Two independent stopping conditions, both required: `maxPages` bounds how
   * many upstream requests this makes regardless of result size (a broad query
   * can page for a long time — the `ai engineer` fixture alone was 5 pages for
   * 86 results, and a one-word query could be far larger), and `limit` bounds
   * how many items get returned to the caller. Without both, a query with
   * `more: true` on every page and a caller who forgot to bound it would loop
   * until Substack ran out of results, which is the runaway loop this project
   * explicitly refuses to risk (see {@link PaginateOptions}).
   */
  async searchAll(params: { query: string } & PaginateOptions): Promise<Profile[]> {
    const limit = params.limit ?? 100;
    const maxPages = params.maxPages ?? 20;
    const byId = new Map<number, Profile>();
    const seenPages = new Set<string>();

    for (let page = 0; page < maxPages && byId.size < limit; page += 1) {
      const result = await this.search(
        { query: params.query, page },
        { cookie: params.cookie, signal: params.signal },
      );
      const signature = result.results.map((profile) => profile.id).join(',');
      if (seenPages.has(signature)) break;
      seenPages.add(signature);

      for (const profile of result.results) {
        if (!byId.has(profile.id)) byId.set(profile.id, profile);
        if (byId.size >= limit) break;
      }
      if (!result.more || result.results.length === 0) break;
    }

    return [...byId.values()].slice(0, limit);
  }

  /**
   * Resolve a numeric user id to a handle.
   *
   * The bridge this whole targeting workflow depends on: note reactors
   * (`/api/v1/comment/{noteId}/reactors`) identify people by numeric `id`
   * only and carry no `handle`, but `public_profile` — the only place
   * `subscriptions[]` lives — accepts nothing but a handle. Substack has no
   * JSON endpoint for id -> handle, but `GET /profile/{userId}` (no `/api/v1`
   * prefix) responds `301` with `Location: https://substack.com/@{handle}`
   * (or a relative `/@{handle}`), so the redirect target *is* the lookup.
   * Verified live for two different accounts: `86433889 -> alialfredji` and
   * `491472156 -> sandytidereadings`; an invalid id (e.g. `1`) 404s with no
   * `Location` at all, which is the case that throws below.
   *
   * Parses defensively: matches `/@([^/?#]+)/` anywhere in the location
   * rather than assuming an absolute URL or a fixed prefix, since Substack
   * could serve either an absolute or relative `Location`, and URL-decodes
   * the captured segment.
   */
  async resolveHandle(userId: number, opts?: CallOptions): Promise<string> {
    const cached = this.handleCache.get(userId);
    if (cached) return cached;

    const location = await this.http.resolveRedirect(`/profile/${userId}`, {
      cookie: opts?.cookie,
      signal: opts?.signal,
    });

    const match = location ? /\/@([^/?#]+)/.exec(location) : null;
    if (!match) {
      throw new Error(
        `Could not resolve a handle for user id ${userId}: expected a redirect to "/@{handle}", got ` +
          `${location ? `a redirect to "${location}"` : 'no redirect at all (not a 3xx response)'}. ` +
          'The id most likely belongs to a deleted, deactivated, or invalid account.',
      );
    }

    const handle = decodeURIComponent(match[1] ?? '');
    this.handleCache.set(userId, handle);
    return handle;
  }

  /**
   * Fetch a profile by numeric user id instead of handle.
   *
   * Costs **two** upstream requests — {@link resolveHandle} then
   * {@link getByHandle} — unless this id was already resolved earlier in the
   * client's lifetime, in which case the id->handle step is free. Callers
   * batching many note reactors should expect that real cost (or resolve
   * handles once up front and call `getByHandle` themselves) rather than
   * assume this is a single round trip.
   */
  async getByUserId(userId: number, opts?: CallOptions): Promise<Profile> {
    const handle = await this.resolveHandle(userId, opts);
    return this.getByHandle(handle, opts);
  }

  /**
   * Convenience accessor for a profile's `subscriptions[]`.
   *
   * There is no dedicated subscriptions endpoint — the only place this data
   * lives is embedded on the profile object itself — so this is `getByHandle`
   * plus a field pluck, not a second upstream call.
   */
  async getSubscriptions(handle: string, opts?: CallOptions): Promise<Subscription[]> {
    const profile = await this.getByHandle(handle, opts);
    return profile.subscriptions ?? [];
  }

  /**
   * Compare two people's subscription graphs. This is the actual use case
   * this resource was built for: ranking a stranger (say, a search result or
   * a note reactor) by how much their reading overlaps with someone's own.
   *
   * Both subscription lists are fetched with the same `opts` (so both benefit
   * from the same cookie, if any — though subscriptions are not viewer-relative,
   * unlike `isSubscribed`/`isFollowing` on the profile itself). Publications are
   * matched by `id`, not `subdomain`, because `id` is the one field guaranteed
   * present on every {@link Publication}.
   */
  async subscriptionOverlap(handleA: string, handleB: string, opts?: CallOptions): Promise<SubscriptionOverlap> {
    const [subsA, subsB] = await Promise.all([
      this.getSubscriptions(handleA, opts),
      this.getSubscriptions(handleB, opts),
    ]);

    const byIdA = new Map(subsA.map((s) => [s.publication.id, s.publication]));
    const byIdB = new Map(subsB.map((s) => [s.publication.id, s.publication]));

    const overlap: Publication[] = [];
    for (const [id, pub] of byIdA) {
      if (byIdB.has(id)) overlap.push(pub);
    }

    const unionSize = new Set([...byIdA.keys(), ...byIdB.keys()]).size;

    return {
      handleA,
      handleB,
      subscriptionCountA: byIdA.size,
      subscriptionCountB: byIdB.size,
      overlap,
      overlapCount: overlap.length,
      score: unionSize === 0 ? 0 : overlap.length / unionSize,
    };
  }
}
