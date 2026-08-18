/**
 * Publication-level shapes: search envelopes and the recommendation graph.
 *
 * `PublicationSchema` itself lives in `./common.js` and is reused everywhere
 * below — a publication object shows up nested in recommendation edges, in
 * post-search results, and as a bare search hit, and it is the same loose
 * shape in all three places (give or take a field Substack decided to omit).
 */

import { z } from 'zod';
import { MaybeBoolean, MaybeNumber, MaybeString, PublicationSchema, searchEnvelope } from './common.js';

/**
 * `GET /api/v1/publication/search` response.
 *
 * Verified live: `limit` does **not** control how many results come back —
 * every value tried (2, 5, 18, 100) returned the same ~18-19 item batch, and
 * `more` was `true` in every case tested. `page` *does* change the result
 * set (page 0 and page 1 returned disjoint publications), so pagination
 * works, but treat `limit` as advisory at best. Documented here so nobody
 * "fixes" a caller by tuning a `limit` that the upstream ignores.
 *
 * Reliability finding, also worth documenting here: after roughly a dozen
 * calls to this root-host search endpoint within a few minutes, it started
 * consistently returning `{ "results": [] }` with the `more` key **absent
 * entirely** (not `false` — missing), for a query that had returned 18+
 * real results minutes earlier from the same client. Waiting 20+ seconds did
 * not recover it within the test window. Subdomain-scoped endpoints
 * (`archive`, `comments`, `recommendations`) kept working normally the whole
 * time, so this looks like throttling specific to the search endpoint(s) on
 * `substack.com`, not a general outage. An empty `results` array with no
 * `more` key is a signal to back off and retry later, not "no matches."
 */
export const PublicationSearchResponseSchema = searchEnvelope(PublicationSchema);
export type PublicationSearchResponse = z.infer<typeof PublicationSearchResponseSchema>;

/**
 * One hit from `GET /api/v1/post/search`.
 *
 * Unverified: every query tried live (`ai`, `startup`, `writing`,
 * `productivity`, `money`, `the`, `newsletter`, `bitcoin`, `climate`,
 * `recipe`, `platformer`, `substack` — twelve distinct terms across two
 * sessions) returned empty `focused`/`results`/`publications` arrays with
 * `more: false`. The envelope shape is confirmed; the element shape is not.
 * This is left maximally loose (no required fields) on purpose — tightening
 * it would just be guessing. If you find a query that returns hits, that is
 * the moment to add required fields here. See also the reliability note on
 * {@link PublicationSearchResponseSchema} — `post/search` shares the same
 * root host and may be subject to the same throttling, which could explain
 * some of these empties independent of query relevance.
 */
export const PostSearchResultSchema = z
  .looseObject({})
  .describe('A post-search hit. Element shape unverified; see module doc.');
export type PostSearchResult = z.infer<typeof PostSearchResultSchema>;

/** `GET /api/v1/post/search` response envelope. */
export const PostSearchResponseSchema = z.looseObject({
  focused: z.array(PostSearchResultSchema),
  results: z.array(PostSearchResultSchema),
  /** Same hits as `results`, decorated with click-tracking query params. */
  resultsWithTrackingParams: z.array(PostSearchResultSchema),
  more: MaybeBoolean,
  /** Publications that own the matched posts, deduplicated. */
  publications: z.array(PublicationSchema),
});
export type PostSearchResponse = z.infer<typeof PostSearchResponseSchema>;

/**
 * One edge in the recommendation graph, as returned by
 * `GET /api/v1/recommendations/from/{publicationId}` on a publication's own
 * subdomain.
 *
 * Ground-truth correction: the elements are **not** bare publications. Each
 * one is a recommendation record (who recommended whom, when, with what
 * blurb) that *wraps* the target publication under `recommendedPublication`.
 * `subscribe_auth_token` is a short-lived signed JWT Substack's own frontend
 * uses to one-click-subscribe the viewer to the recommended publication; it
 * is read-only data to us (this client makes no write calls) but it is
 * still a token, so treat it as sensitive if you log responses.
 *
 * Also confirmed live: `GET /api/v1/publication/{id}/recommendations` on the
 * root `substack.com` host is a 404 (HTML body). Recommendations only exist
 * on the publication's own subdomain — there is no cross-publication way to
 * ask "what does publication X recommend" from the root API.
 */
export const RecommendationSchema = z.looseObject({
  id: z.number(),
  recommended_publication_id: MaybeNumber,
  recommending_publication_id: MaybeNumber,
  created_at: MaybeString,
  updated_at: MaybeString,
  blurb_active: MaybeBoolean,
  description: MaybeString,
  email_sent_at: MaybeString,
  recommendedPublication: PublicationSchema.nullish(),
  subscribe_auth_token: MaybeString,
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** `GET /api/v1/recommendations/from/{publicationId}` response: a bare array. */
export const RecommendationsResponseSchema = z.array(RecommendationSchema);
export type RecommendationsResponse = z.infer<typeof RecommendationsResponseSchema>;

/**
 * A publication found by walking the recommendation graph breadth-first from
 * a starting publication. Not an upstream shape — this is what
 * {@link PublicationsResource.relatedPublications} builds for you, since
 * "publications two recommendation-hops away" is not something Substack
 * exposes directly.
 */
export const RelatedPublicationSchema = z.object({
  publication: PublicationSchema,
  /** Recommendation hops from the starting publication. Direct recs are 1. */
  distance: z.number().int().min(1),
  /** The recommendation edge that first surfaced this publication, if any. */
  viaRecommendationId: z.number().nullish(),
});
export type RelatedPublication = z.infer<typeof RelatedPublicationSchema>;
