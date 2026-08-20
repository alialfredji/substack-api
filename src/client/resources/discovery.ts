/**
 * Categories and leaderboards — the entry point for finding publications
 * adjacent to a given niche.
 *
 * `src/schemas/discovery.ts` carries the full record of what was probed live
 * and what came back negative (slugs in the leaderboard path, the
 * top/rising/bestsellers/discover/explore/trending endpoints, the `type` and
 * `limit` query params). Read that first if a method here looks like it is
 * leaving an obvious feature on the table — it probably tried it and it did
 * not work.
 */

import type { SubstackHttp } from '../http.js';
import type { CallOptions, PaginateOptions } from '../types.js';
import {
  CategorySchema,
  LeaderboardPageSchema,
  type Category,
  type CategoryId,
  type CategoryTreeNode,
  type LeaderboardPage,
} from '../../schemas/discovery.js';
import type { Publication } from '../../schemas/common.js';

/** Params for {@link DiscoveryResource.leaderboard}. */
export interface LeaderboardParams {
  /** Zero-based page index. Default 0. Upstream page size is a fixed 25. */
  page?: number;
  /**
   * Forwarded to upstream as-is. Verified to have **no effect**: `paid`,
   * `free`, `newsletter` and a garbage value all returned the identical
   * publication id list for category 4 (Technology). Kept only in case
   * Substack turns filtering on later without a path change.
   */
  type?: string;
}

const NUMERIC = /^\d+$/;

export class DiscoveryResource {
  /**
   * Flattened (parents + their nested subcategories) category list, cached
   * as a single in-flight/resolved promise so concurrent lookups before the
   * first response also share one request. Lives for the lifetime of this
   * `DiscoveryResource` instance (i.e. of the client that owns it) — there
   * is no TTL or invalidation. Construct a new client if you need to pick up
   * a taxonomy change.
   */
  private categoriesCache: Promise<Category[]> | null = null;

  constructor(private readonly http: SubstackHttp) {}

  /**
   * The full category list: 32 top-level categories, each with its
   * `subcategories` nested. See the schema module for exactly which fields
   * are verified vs. best-effort.
   */
  async categories(opts?: CallOptions): Promise<Category[]> {
    return this.http.request('/api/v1/categories', {
      schema: CategorySchema.array(),
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Resolve a human-friendly identifier to a {@link Category} — a top-level
   * category or a subcategory, both of which live in the same id space and
   * both of which work as leaderboard ids.
   *
   * Numeric input (a `number`, or a string that parses cleanly as one) is
   * matched against `id`. Anything else is matched case-insensitively
   * against `slug` first (what shows up in Substack's own URLs), then
   * `name` as the friendlier fallback.
   *
   * Throws when nothing matches rather than guessing, because the
   * leaderboard endpoint itself will not tell you an id was wrong — an
   * unknown numeric id just comes back as an empty page (see schema module),
   * which is a far more confusing failure to debug than a clear error here.
   */
  async findCategory(idOrSlugOrName: string | number, opts?: CallOptions): Promise<Category> {
    const flat = await this.flattenedCategories(opts);

    if (typeof idOrSlugOrName === 'number') {
      const byId = flat.find((c) => c.id === idOrSlugOrName);
      if (byId) return byId;
    } else {
      const trimmed = idOrSlugOrName.trim();
      if (NUMERIC.test(trimmed)) {
        const byId = flat.find((c) => c.id === Number(trimmed));
        if (byId) return byId;
      }
      const needle = trimmed.toLowerCase();
      const bySlug = flat.find((c) => c.slug.toLowerCase() === needle);
      if (bySlug) return bySlug;
      const byName = flat.find((c) => c.name.toLowerCase() === needle);
      if (byName) return byName;
    }

    throw new Error(
      `No Substack discovery category matches ${JSON.stringify(idOrSlugOrName)}. ` +
        `Call categories() to see every valid id, slug and name.`,
    );
  }

  /**
   * One page of a category (or subcategory) leaderboard.
   *
   * `category` accepts an id, a slug, or a name. Non-numeric input is
   * resolved through {@link findCategory} first (one extra request on the
   * first call, cached after that); numeric input skips resolution entirely
   * and is sent straight to upstream, which is deliberate — see
   * {@link findCategory}'s doc on why a bad numeric id is left for upstream
   * to no-op on rather than validated here.
   */
  async leaderboard(
    category: string | number,
    params?: LeaderboardParams,
    opts?: CallOptions,
  ): Promise<LeaderboardPage> {
    const id = await this.resolveId(category, opts);
    return this.http.request(`/api/v1/category/public/${id}/all`, {
      query: { page: params?.page ?? 0, type: params?.type },
      schema: LeaderboardPageSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Walk the leaderboard to completion, or to `limit`/`maxPages` — whichever
   * comes first — and return the flattened publication list.
   *
   * This has to be bounded on our side: probing category `4` (Technology)
   * showed `more: true` for 15 straight pages (375 unique publications, zero
   * repeats) with no sign of stopping, so a popular category could otherwise
   * page for a very long time. `limit` defaults to 100, `maxPages` to 20 —
   * combined with the fixed upstream page size of 25, that is at most 20
   * requests no matter how large `limit` is set.
   */
  async leaderboardAll(category: string | number, opts?: PaginateOptions): Promise<Publication[]> {
    const id = await this.resolveId(category, opts);
    const limit = opts?.limit ?? 100;
    const maxPages = opts?.maxPages ?? 20;

    const publications = new Map<number, Publication>();
    const seenPages = new Set<string>();
    let page = 0;
    let more = true;

    while (more && page < maxPages && publications.size < limit) {
      const result = await this.http.request<LeaderboardPage>(`/api/v1/category/public/${id}/all`, {
        query: { page },
        schema: LeaderboardPageSchema,
        cookie: opts?.cookie,
        signal: opts?.signal,
      });
      const signature = result.publications.map((publication) => publication.id).join(',');
      if (seenPages.has(signature)) break;
      seenPages.add(signature);

      for (const publication of result.publications) {
        if (!publications.has(publication.id)) publications.set(publication.id, publication);
        if (publications.size >= limit) break;
      }
      more = result.more === true;
      if (result.publications.length === 0) break;
      page += 1;
    }

    return [...publications.values()].slice(0, limit);
  }

  /**
   * Group the taxonomy into parent/child pairs, built by grouping on
   * `parent_tag_id` rather than by trusting the upstream nesting.
   *
   * Confirmed real: every one of the 32 top-level categories has
   * `parent_tag_id: null`, and every subcategory's `parent_tag_id` points
   * back to its parent's `id`. The upstream response already nests
   * subcategories under each parent, so this method is not strictly
   * necessary to reach the data — it exists so that grouping still works if
   * Substack ever starts delivering the taxonomy flat instead of pre-nested.
   */
  async categoryTree(opts?: CallOptions): Promise<CategoryTreeNode[]> {
    const categories = await this.categories(opts);
    const byParent = new Map<CategoryId, Category[]>();
    for (const category of categories) {
      for (const child of category.subcategories ?? []) {
        const parentId = child.parent_tag_id ?? category.id;
        const bucket = byParent.get(parentId) ?? [];
        bucket.push(child);
        byParent.set(parentId, bucket);
      }
    }

    return categories
      .filter((c) => c.parent_tag_id === null || c.parent_tag_id === undefined)
      .map((category) => ({ category, children: byParent.get(category.id) ?? [] }));
  }

  // -- internals ------------------------------------------------------------

  /**
   * Numeric input goes straight to upstream; anything else resolves through
   * {@link findCategory}.
   *
   * Returns {@link CategoryId} rather than `number` because resolution can
   * legitimately land on a string id — `"podcast"` is a working leaderboard id.
   * A slug like `"technology"` is *not*, which is exactly why non-numeric input
   * is resolved to a real category first instead of being passed through.
   */
  private async resolveId(category: string | number, opts?: CallOptions): Promise<CategoryId> {
    if (typeof category === 'number') return category;
    const trimmed = category.trim();
    if (NUMERIC.test(trimmed)) return Number(trimmed);
    const resolved = await this.findCategory(category, opts);
    return resolved.id;
  }

  /** Flatten parents + their nested subcategories into one searchable array, fetched once and cached. */
  private flattenedCategories(opts?: CallOptions): Promise<Category[]> {
    if (!this.categoriesCache) {
      this.categoriesCache = this.categories(opts).then((categories) =>
        categories.flatMap((category) => [category, ...(category.subcategories ?? [])]),
      );
    }
    return this.categoriesCache;
  }
}
