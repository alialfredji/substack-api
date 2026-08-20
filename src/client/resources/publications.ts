/**
 * Newsletters: search, archive, single posts, comments, and the
 * recommendation graph.
 *
 * Everything here that is scoped to one newsletter (`archive`, `getPost`,
 * `comments`, `recommendations`) lives on that publication's own subdomain
 * (`https://{subdomain}.substack.com`), via {@link publicationBaseUrl}. Only
 * `search` and `searchPosts` hit the root `substack.com` host, because
 * search is a cross-publication index Substack only exposes there.
 */

import type { SubstackHttp } from '../http.js';
import { publicationBaseUrl } from '../config.js';
import type { CallOptions, PaginateOptions } from '../types.js';
import {
  PublicationSearchResponseSchema,
  PostSearchResponseSchema,
  RecommendationsResponseSchema,
  type PublicationSearchResponse,
  type PostSearchResponse,
  type Recommendation,
  type RelatedPublication,
} from '../../schemas/publication.js';
import {
  ArchiveResponseSchema,
  PostSchema,
  CommentsEnvelopeSchema,
  type Post,
  type CommentsEnvelope,
  type Comment,
  type Commenter,
} from '../../schemas/post.js';
import type { Publication } from '../../schemas/common.js';

/** Options for walking a publication archive with offset pagination. */
export interface ArchiveAllOptions extends PaginateOptions {
  /** Number of posts requested per upstream page. Default 50. */
  pageSize?: number;
  /** Archive ordering forwarded to Substack. Default `new`. */
  sort?: string;
}

/**
 * Flatten a comment tree into deduplicated commenters, iteratively.
 *
 * Deliberately a stack-based walk rather than recursion: real threads on
 * high-traffic publications nest arbitrarily deep (Astral Codex Ten posts
 * regularly exceed 500 comments with long reply chains), and a recursive
 * `children.forEach` over that would risk blowing the call stack on the
 * pathological case. A plain array-as-stack has no such limit.
 */
function flattenCommenters(comments: Comment[]): Commenter[] {
  const seen = new Set<number>();
  const out: Commenter[] = [];
  const stack: Comment[] = [...comments];

  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const comment = stack.pop()!;
    if (typeof comment.user_id === 'number' && !seen.has(comment.user_id)) {
      seen.add(comment.user_id);
      out.push({
        userId: comment.user_id,
        name: comment.name ?? null,
        handle: comment.handle ?? null,
        photoUrl: comment.photo_url ?? null,
      });
    }
    if (Array.isArray(comment.children) && comment.children.length > 0) {
      stack.push(...comment.children);
    }
  }

  return out;
}

export class PublicationsResource {
  constructor(private readonly http: SubstackHttp) {}

  /**
   * Search publications by keyword.
   *
   * `limit` is accepted and forwarded, but verified live to have no observed
   * effect: values of 2, 5, 18 and 100 all returned the same ~18-19 item
   * batch with `more: true`. Use `page` to actually get more results.
   *
   * Also seen live: after sustained use in a short window this endpoint
   * degraded to `{ results: [] }` with no `more` key at all, for a query
   * that had real hits minutes before. Treat that exact shape (empty,
   * `more` missing rather than `false`) as "back off and retry", not as
   * "no matches" — see `schemas/publication.ts` for the full note.
   */
  async search(
    params: { query: string; limit?: number; page?: number },
    opts?: CallOptions,
  ): Promise<PublicationSearchResponse> {
    return this.http.request('/api/v1/publication/search', {
      query: { query: params.query, limit: params.limit, page: params.page },
      schema: PublicationSearchResponseSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Walk publication search pages with first-seen id deduplication.
   *
   * The endpoint sometimes degrades to `{ results: [] }` without a `more`
   * field. That exact shape is retried once; if it repeats, the result is
   * inconclusive and this method throws rather than silently reporting that
   * the search was exhausted.
   */
  async searchAll(params: { query: string } & PaginateOptions): Promise<Publication[]> {
    const limit = params.limit ?? 100;
    const maxPages = params.maxPages ?? 20;
    const byId = new Map<number, Publication>();
    const seenPages = new Set<string>();

    for (let page = 0; page < maxPages && byId.size < limit; page += 1) {
      let result = await this.search(
        { query: params.query, page },
        { cookie: params.cookie, signal: params.signal },
      );
      if (result.results.length === 0 && result.more === undefined) {
        result = await this.search(
          { query: params.query, page },
          { cookie: params.cookie, signal: params.signal },
        );
        if (result.results.length === 0 && result.more === undefined) {
          throw new Error(
            `Publication search for ${JSON.stringify(params.query)} returned an empty response without a ` +
              `'more' field twice on page ${page}; Substack may be throttling the search endpoint.`,
          );
        }
      }

      const signature = result.results.map((publication) => publication.id).join(',');
      if (seenPages.has(signature)) break;
      seenPages.add(signature);

      for (const publication of result.results) {
        if (!byId.has(publication.id)) byId.set(publication.id, publication);
        if (byId.size >= limit) break;
      }
      if (!result.more || result.results.length === 0) break;
    }

    return [...byId.values()].slice(0, limit);
  }

  /**
   * Search posts by keyword.
   *
   * Verified live: every query tried (nine distinct terms, see
   * `schemas/publication.ts`) returned empty arrays. The route is real (200,
   * correct envelope shape) but either the search index has nothing to
   * return anonymously or it is effectively decommissioned. Kept because the
   * route responds and the shape is documented; do not spend time debugging
   * "why are my results empty" without first confirming this yourself with a
   * fresh query.
   */
  async searchPosts(
    params: { query: string; limit?: number },
    opts?: CallOptions,
  ): Promise<PostSearchResponse> {
    return this.http.request('/api/v1/post/search', {
      query: { query: params.query, limit: params.limit },
      schema: PostSearchResponseSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * List a publication's posts, newest (or top, by engagement) first.
   *
   * Verified live on `aieworks`: `sort=new` and `sort=top` both 200 with
   * different orderings; `sort=community` also 200 (effect on ordering not
   * distinguishable from `new` in a 3-item sample — likely a valid value for
   * publications with community posts enabled, untested here). `offset`
   * genuinely pages: `offset=3` returned three post ids disjoint from the
   * first three.
   */
  async archive(
    subdomain: string,
    params: { limit?: number; offset?: number; sort?: string } = {},
    opts?: CallOptions,
  ): Promise<Post[]> {
    return this.http.request('/api/v1/archive', {
      baseUrl: publicationBaseUrl(subdomain),
      query: { sort: params.sort ?? 'new', limit: params.limit, offset: params.offset },
      schema: ArchiveResponseSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Walk a publication archive using `offset + limit`, deduplicating posts by
   * id and stopping on a short, empty, or repeated page.
   */
  async archiveAll(subdomain: string, params: ArchiveAllOptions = {}): Promise<Post[]> {
    const limit = params.limit ?? 100;
    const maxPages = params.maxPages ?? 20;
    const pageSize = params.pageSize ?? 50;
    const byId = new Map<number, Post>();
    const seenPages = new Set<string>();
    let offset = 0;

    for (let page = 0; page < maxPages && byId.size < limit; page += 1) {
      const requested = Math.min(pageSize, limit - byId.size);
      const result = await this.archive(
        subdomain,
        { limit: requested, offset, sort: params.sort },
        { cookie: params.cookie, signal: params.signal },
      );
      const signature = result.map((post) => post.id).join(',');
      if (seenPages.has(signature)) break;
      seenPages.add(signature);

      for (const post of result) {
        if (!byId.has(post.id)) byId.set(post.id, post);
        if (byId.size >= limit) break;
      }
      if (result.length === 0 || result.length < requested) break;
      offset += result.length;
    }

    return [...byId.values()].slice(0, limit);
  }

  /**
   * Fetch a single post by slug.
   *
   * Verified live: `GET /api/v1/posts/{slug}` 200s and returns the full post
   * body (`body_html`, `wordcount`, `publishedBylines`, etc). Confirmed
   * negative results, so this does not get re-probed later: `/api/v1/post/{id}`
   * and `/api/v1/posts/id/{id}` both 404. There is no numeric-id lookup on
   * this API — get the slug from {@link archive} or {@link search} first.
   * `slugOrId` accepts a number for callers who only have an id on hand, but
   * it will 404 unless that number happens to equal the real slug (it won't).
   */
  async getPost(subdomain: string, slugOrId: string | number, opts?: CallOptions): Promise<Post> {
    return this.http.request(`/api/v1/posts/${encodeURIComponent(String(slugOrId))}`, {
      baseUrl: publicationBaseUrl(subdomain),
      schema: PostSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Fetch a post's comments, including nested replies.
   *
   * Verified live: works with no cookie, but only on posts where comment
   * *viewing* is not gated. Several high-traffic publications
   * (`astralcodexten`, `noahpinion`, `slowboring`) returned an empty
   * `comments` array despite the post's archive listing showing
   * `comment_count` in the hundreds — the count is public, reading the
   * thread apparently is not (at least anonymously). `platformer` posts
   * (free, no paywall) returned full threads with nested `children`.
   * If you get an empty array back on a post with `comment_count > 0`,
   * that is very likely this gating, not a bug.
   */
  async comments(
    subdomain: string,
    postId: number,
    params: { sort?: string; allComments?: boolean } = {},
    opts?: CallOptions,
  ): Promise<CommentsEnvelope> {
    return this.http.request(`/api/v1/post/${postId}/comments`, {
      baseUrl: publicationBaseUrl(subdomain),
      query: { sort: params.sort ?? 'best_first', all_comments: params.allComments ?? true },
      schema: CommentsEnvelopeSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Which publications does `publicationId` recommend?
   *
   * Ground-truth correction: this only works on the publication's own
   * subdomain. `GET https://substack.com/api/v1/publication/{id}/recommendations`
   * (the root host) is a confirmed 404 — verified live, HTML body, not a
   * transient error. Substack simply does not expose this cross-publication
   * from the root API; you must know the subdomain.
   */
  async recommendations(subdomain: string, publicationId: number, opts?: CallOptions): Promise<Recommendation[]> {
    return this.http.request(`/api/v1/recommendations/from/${publicationId}`, {
      baseUrl: publicationBaseUrl(subdomain),
      schema: RecommendationsResponseSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Fetch a post's comments and flatten the whole tree (top-level and every
   * nested reply) into deduplicated commenters.
   *
   * This is the payoff of {@link comments}: engaged commenters on a niche
   * publication are some of the highest-signal real people you can find for
   * outreach or research, because leaving a comment is a much stronger
   * engagement signal than a like. See {@link flattenCommenters} for why the
   * flattening itself is iterative rather than recursive.
   */
  async commenters(subdomain: string, postId: number, opts?: CallOptions): Promise<Commenter[]> {
    const { comments } = await this.comments(subdomain, postId, { allComments: true }, opts);
    return flattenCommenters(comments);
  }

  /**
   * Walk the recommendation graph breadth-first from a starting publication
   * to find adjacent publications — the ones it recommends, the ones those
   * recommend, and so on.
   *
   * Not an upstream endpoint; Substack has no "publications like this one"
   * route, only the one-hop `recommendations` edge list. This composes that
   * into something useful: a bounded BFS with a visited-set (so a cycle in
   * the recommendation graph, which is common — publications often
   * recommend each other back) cannot loop forever, and two independent
   * caps (`limit` on total results, `maxPages` on BFS hops) so a densely
   * connected neighbourhood cannot turn into thousands of requests. A
   * publication that 404s or errors when queried (private, deleted, or just
   * has recommendations disabled) is skipped rather than aborting the walk.
   */
  async relatedPublications(
    subdomain: string,
    publicationId: number,
    opts: PaginateOptions = {},
  ): Promise<RelatedPublication[]> {
    const limit = opts.limit ?? 100;
    const maxHops = opts.maxPages ?? 20;

    const visited = new Set<number>([publicationId]);
    const out: RelatedPublication[] = [];
    let frontier: Array<{ subdomain: string; id: number; distance: number }> = [
      { subdomain, id: publicationId, distance: 0 },
    ];
    let hops = 0;

    while (frontier.length > 0 && out.length < limit && hops < maxHops) {
      hops += 1;
      const next: Array<{ subdomain: string; id: number; distance: number }> = [];

      for (const node of frontier) {
        if (out.length >= limit) break;

        let recs: Recommendation[];
        try {
          recs = await this.recommendations(node.subdomain, node.id, opts);
        } catch {
          continue; // dead end: private, deleted, or recommendations disabled. Skip, don't abort.
        }

        for (const rec of recs) {
          const pub = rec.recommendedPublication;
          if (!pub || visited.has(pub.id)) continue;
          visited.add(pub.id);
          out.push({ publication: pub, distance: node.distance + 1, viaRecommendationId: rec.id ?? null });
          if (pub.subdomain) next.push({ subdomain: pub.subdomain, id: pub.id, distance: node.distance + 1 });
          if (out.length >= limit) break;
        }
      }

      frontier = next;
    }

    return out;
  }
}
