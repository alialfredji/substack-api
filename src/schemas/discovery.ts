/**
 * Category taxonomy and leaderboard shapes.
 *
 * Ground truth below was probed live against `https://substack.com` on
 * 2026-08-17. Read this before touching `DiscoveryResource` — most of what
 * looks like a missing feature there is a verified negative result, not an
 * oversight.
 *
 * **`GET /api/v1/categories`**
 *  - Returns a flat array of the **32 top-level categories** (every element
 *    has `parent_tag_id: null`). Each element carries its own
 *    `subcategories` array (sometimes empty, sometimes several entries), so
 *    the two-level hierarchy the leaderboard UI implies is real, and it is
 *    delivered pre-nested — no flat-to-tree reconstruction is required.
 *  - Fields verified present on every top-level element: `id`, `created_at`,
 *    `updated_at`, `name`, `canonical_name`, `active`, `rank`,
 *    `parent_tag_id`, `slug`, `emoji`, `leaderboard_description`,
 *    `deprecated`, `type` (always `"category"`), `subcategories`.
 *  - Subcategories share the same field set minus `subcategories` itself.
 *    Every subcategory observed has `active: false`; `emoji` and
 *    `leaderboard_description` are usually (not always) `null` on them.
 *  - Subcategory ids work as leaderboard ids too — verified with id `76966`
 *    ("Emerging Tech", child of Technology/`4`), which returned
 *    `{ title: "Top in Emerging Tech", publications: [], more: false }`.
 *
 * **`GET /api/v1/category/public/{id}/all?page={n}`**
 *  - Returns `{ publications: Publication[], more: boolean, title?: string }`.
 *  - `id` must be **numeric**. A slug 400s:
 *    `GET .../category/public/technology/all` ->
 *    `{"errors":[{"location":"params","param":"id","value":"technology","msg":"Invalid value"}]}`.
 *    Slug/name -> id resolution therefore happens client-side; see
 *    {@link Category} and `DiscoveryResource.findCategory`.
 *  - `type=paid` / `type=free` / `type=newsletter` / an arbitrary garbage
 *    value were all sent against category `4` (Technology) and diffed by
 *    publication id: **identical results every time**. The param has no
 *    observable effect. Kept on the query shape only for forward
 *    compatibility in case Substack wires it up later.
 *  - `limit` is likewise accepted and ignored. Page size is a fixed **25**
 *    regardless of `limit=5` or `limit=100`.
 *  - The path segment after the id — `all`, `top`, `rising`, `bestsellers`,
 *    or a literal `totally-random-garbage-xyz` — is **not validated at
 *    all**; every variant returned byte-identical output. There is no
 *    separate top/rising/bestsellers endpoint. `all` is kept as the
 *    convention because it is what Substack's own product UI uses.
 *  - Omitting the trailing segment 404s: `/category/public/{id}` and
 *    `/category/public/{id}/` both 404 (HTML body). So does
 *    `/api/v1/category/{id}` (missing `public`). A segment is required;
 *    its content is not checked.
 *  - `page` defaults to `0` when omitted.
 *  - A numeric id that matches no category returns **200**, not 404:
 *    `{ publications: [], more: false }` — no `title` key at all. Hence
 *    `title` is nullish below rather than required.
 *  - Pagination is real and deep, not a shallow cap dressed up as one:
 *    category `4` (Technology) returned `more: true` across 15 consecutive
 *    pages (375 unique publication ids, zero repeats) with no sign of
 *    stopping. `leaderboardAll` bounds itself; nothing upstream will.
 *
 * **Endpoints that do not exist** (all confirmed 404 with an HTML body):
 * `/api/v1/discover`, `/api/v1/explore`, `/api/v1/trending`,
 * `/api/v1/leaderboard` (the bare noun). `category/public/{id}/all` is the
 * entire discovery surface; there is no separate "explore" endpoint.
 */

import { z } from 'zod';
import { MaybeBoolean, MaybeNumber, MaybeString, PublicationSchema } from './common.js';

/**
 * A Substack discovery category or subcategory.
 *
 * Modelled as recursive (`subcategories: Category[]`) even though every
 * observed subcategory has none of its own — one real level of nesting plus
 * a schema that would not need to change if Substack ever added a third.
 * `id`, `name` and `slug` are the only fields verified non-null on every one
 * of the 32 top-level entries and every subcategory encountered.
 */
/**
 * A category id — usually a number, occasionally a string.
 *
 * Substack ships exactly one top-level category whose id is a string:
 * `{id: "podcast", name: "Podcasts", slug: "podcast", rank: 5.5}`. All 31 other
 * top-level entries and all 206 subcategories use numeric ids.
 *
 * This is not bad data to be defended against — `"podcast"` is a *working*
 * leaderboard id (`/api/v1/category/public/podcast/all` returns 200 with 25
 * publications). Contrast a genuine slug like `"technology"`, which returns
 * 400 `{"param":"id","msg":"Invalid value"}`. So the id space is "numbers plus
 * one blessed string", and the union is the honest model.
 *
 * Typing this as `number` is what broke serialisation initially: the reply
 * serialiser refused with `The value "podcast" cannot be converted to a number`
 * and every category route returned 500.
 */
export type CategoryId = number | string;

/** See {@link CategoryId}. */
export const CategoryIdSchema = z
  .union([z.number(), z.string()])
  .describe('Category id. Numeric for all but the "podcast" category, which uses a string id.');

export interface Category {
  id: CategoryId;
  name: string;
  slug: string;
  canonical_name?: string | null;
  active?: boolean | null;
  rank?: number | null;
  /**
   * `null` for the 32 top-level categories; the parent's `id` for a
   * subcategory. Absent entirely (not null) on the `podcast` category, which
   * ships a slimmer record than the rest.
   */
  parent_tag_id?: CategoryId | null;
  emoji?: string | null;
  leaderboard_description?: string | null;
  deprecated?: boolean | null;
  type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** Present (possibly `[]`) on top-level categories; absent on subcategories. */
  subcategories?: Category[] | null;
  [key: string]: unknown;
}

/** See {@link Category}. Recursive via `z.lazy`, cast because Zod cannot infer a self-referential shape. */
export const CategorySchema: z.ZodType<Category> = z.looseObject({
  id: CategoryIdSchema,
  name: z.string(),
  slug: z.string(),
  canonical_name: MaybeString,
  active: MaybeBoolean,
  rank: MaybeNumber,
  parent_tag_id: CategoryIdSchema.nullish(),
  emoji: MaybeString,
  leaderboard_description: MaybeString,
  deprecated: MaybeBoolean,
  type: MaybeString,
  created_at: MaybeString,
  updated_at: MaybeString,
  subcategories: z.lazy(() => z.array(CategorySchema)).nullish(),
}).describe('A Substack discovery category, with subcategories nested where the taxonomy has them.') as z.ZodType<Category>;

/**
 * One page of a category (or subcategory) leaderboard.
 *
 * `title` is absent — not null, missing entirely — when `id` matched no
 * category, so it is nullish rather than required. `more` and `publications`
 * were present on every response observed, including the empty/invalid-id
 * case, so both are required.
 */
export const LeaderboardPageSchema = z
  .looseObject({
    publications: z.array(PublicationSchema),
    more: z.boolean(),
    title: MaybeString,
  })
  .describe('One page of a category leaderboard.');
export type LeaderboardPage = z.infer<typeof LeaderboardPageSchema>;

/**
 * Query shape for the leaderboard route. `type` is accepted and forwarded
 * upstream purely for forward compatibility — see the module doc for how it
 * was confirmed to currently have zero effect. `limit` is deliberately not
 * exposed here: exposing a param that is silently ignored upstream would
 * just relocate the confusion onto our own callers.
 */
export const LeaderboardQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0).describe('Zero-based page index. Upstream page size is a fixed 25.'),
  type: z
    .string()
    .optional()
    .describe('Forwarded to upstream but verified to have no effect as of this writing (see schema source).'),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;

/** One parent category paired with its children, grouped explicitly by `parent_tag_id`. */
export const CategoryTreeNodeSchema = z
  .object({
    category: CategorySchema,
    children: z.array(CategorySchema),
  })
  .describe('A parent category and the subcategories grouped under it via parent_tag_id.');
export type CategoryTreeNode = z.infer<typeof CategoryTreeNodeSchema>;
