/**
 * Posts and comments.
 *
 * Two live shapes feed `PostSchema`: the array returned by `GET /api/v1/archive`
 * and the single object returned by `GET /api/v1/posts/{slug}`. They overlap
 * heavily but are not identical — the archive listing carries `body_json`,
 * the single-post view carries `body_html` and a `comments` preview instead.
 * Rather than two near-duplicate schemas, this is one loose schema with the
 * union of fields verified on either response; only the fields present on
 * *both* (id, publication_id, slug, title, type) are required.
 */

import { z } from 'zod';
import { MaybeBoolean, MaybeNumber, MaybeString, UserStatusSchema } from './common.js';

/** A byline entry on `Post.publishedBylines`. Same author shape as elsewhere. */
export const PublishedBylineSchema = z.looseObject({
  id: MaybeNumber,
  name: MaybeString,
  handle: MaybeString,
  previous_name: MaybeString,
  photo_url: MaybeString,
});
export type PublishedByline = z.infer<typeof PublishedBylineSchema>;

/**
 * A post (newsletter issue).
 *
 * Verified live on `aieworks`: `GET /api/v1/archive?sort=new` and
 * `GET /api/v1/posts/{slug}` both return this shape; `sort=top` and an
 * (accepted, effect unconfirmed) `sort=community` also 200. `offset` on the
 * archive endpoint does shift the window — a second page with `offset=3`
 * returned three different post ids than the first three.
 *
 * Negative results, so nobody re-discovers them:
 *   - `GET /api/v1/post/{id}` -> 404 (HTML). No numeric-id lookup exists.
 *   - `GET /api/v1/posts/id/{id}` -> 404 (HTML). Same story.
 *   - `GET /api/v1/posts/{numericId}` -> 404 unless the numeric string
 *     happens to equal a real slug, which it never does in practice.
 *   The only working single-post lookup is by **slug**.
 */
export const PostSchema = z.looseObject({
  id: z.number(),
  publication_id: z.number(),
  slug: z.string(),
  title: MaybeString,
  type: MaybeString,
  post_date: MaybeString,
  updated_at: MaybeString,
  audience: MaybeString,
  subtitle: MaybeString,
  description: MaybeString,
  canonical_url: MaybeString,
  cover_image: MaybeString,
  cover_image_is_square: MaybeBoolean,
  section_id: MaybeNumber,
  section_name: MaybeString,
  section_slug: MaybeString,
  is_published: MaybeBoolean,
  editor_v2: MaybeBoolean,
  wordcount: MaybeNumber,
  language: MaybeString,
  write_comment_permissions: MaybeString,
  default_comment_sort: MaybeString,
  should_send_free_preview: MaybeBoolean,
  free_unlock_required: MaybeBoolean,
  podcast_url: MaybeString,
  podcast_duration: MaybeNumber,
  has_voiceover: MaybeBoolean,
  has_dynamic_content: MaybeBoolean,
  truncated_body_text: MaybeString,
  /** Present on the single-post response; absent (replaced by `body_json`) on archive listings. */
  body_html: MaybeString,
  /** Present on archive listings; not observed on the single-post response. */
  body_json: z.unknown().nullish(),
  reaction_count: MaybeNumber,
  reactions: z.unknown().nullish(),
  restacks: MaybeNumber,
  comment_count: MaybeNumber,
  child_comment_count: MaybeNumber,
  postTags: z.array(z.unknown()).nullish(),
  publishedBylines: z.array(PublishedBylineSchema).nullish(),
  previous_post_slug: MaybeString,
  next_post_slug: MaybeString,
  is_geoblocked: MaybeBoolean,
  hasCashtag: MaybeBoolean,
});
export type Post = z.infer<typeof PostSchema>;

/** `GET /api/v1/archive` response: a bare array of {@link Post}. */
export const ArchiveResponseSchema = z.array(PostSchema);
export type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>;

/**
 * A comment on a post, including nested replies under `children`.
 *
 * Verified live against `platformer.substack.com` post 140489606 (39
 * comments, at least one two-deep reply thread) after several higher-traffic
 * publications (`astralcodexten`, `noahpinion`, `slowboring`) returned an
 * *empty* `comments` array despite non-zero `comment_count` on the archive
 * listing — reading comments on those posts appears to be gated (likely
 * paywalled or subscriber-only) even though the count is public. `platformer`
 * posts are free, and their comments came back in full with no cookie.
 *
 * `children` nests same-shaped comment objects; `ancestor_path` on a nested
 * reply is its parent's id as a string. `userStatus` reuses the badge/tier
 * shape from `common.ts` — same object as on note reactors.
 *
 * Recursive schema: TypeScript cannot infer the type of a self-referential
 * `z.lazy()`, so the type is declared explicitly and the schema is typed
 * against it (the standard Zod recursive-schema pattern).
 */
export interface Comment {
  id: number;
  body?: string | null;
  body_json?: unknown;
  publication_id?: number | null;
  post_id?: number | null;
  user_id?: number | null;
  ancestor_path?: string | null;
  type?: string | null;
  deleted?: boolean | null;
  date?: string | null;
  edited_at?: string | null;
  status?: string | null;
  pinned_by_user_id?: number | null;
  restacks?: number | null;
  name?: string | null;
  photo_url?: string | null;
  handle?: string | null;
  reactor_names?: unknown[] | null;
  reaction?: string | null;
  /** Map of emoji -> reaction count, e.g. `{ "❤": 53 }`. */
  reactions?: Record<string, number> | null;
  reaction_count?: number | null;
  children?: Comment[] | null;
  children_count?: number | null;
  bans?: unknown[] | null;
  suppressed?: boolean | null;
  user_banned?: boolean | null;
  user_banned_for_comment?: boolean | null;
  user_slug?: string | null;
  metadata?: unknown;
  user_bestseller_tier?: number | null;
  can_dm?: boolean | null;
  userStatus?: unknown;
  score?: number | null;
  reported_by_user?: boolean | null;
  restacked?: boolean | null;
}

export const CommentSchema: z.ZodType<Comment> = z.lazy(() =>
  z.looseObject({
    id: z.number(),
    body: MaybeString,
    body_json: z.unknown().nullish(),
    publication_id: MaybeNumber,
    post_id: MaybeNumber,
    user_id: MaybeNumber,
    ancestor_path: MaybeString,
    type: MaybeString,
    deleted: MaybeBoolean,
    date: MaybeString,
    edited_at: MaybeString,
    status: MaybeString,
    pinned_by_user_id: MaybeNumber,
    restacks: MaybeNumber,
    name: MaybeString,
    photo_url: MaybeString,
    handle: MaybeString,
    reactor_names: z.array(z.unknown()).nullish(),
    reaction: MaybeString,
    reactions: z.record(z.string(), z.number()).nullish(),
    reaction_count: MaybeNumber,
    children: z.array(CommentSchema).nullish(),
    children_count: MaybeNumber,
    bans: z.array(z.unknown()).nullish(),
    suppressed: MaybeBoolean,
    user_banned: MaybeBoolean,
    user_banned_for_comment: MaybeBoolean,
    user_slug: MaybeString,
    metadata: z.unknown().nullish(),
    user_bestseller_tier: MaybeNumber,
    can_dm: MaybeBoolean,
    userStatus: UserStatusSchema.nullish(),
    score: MaybeNumber,
    reported_by_user: MaybeBoolean,
    restacked: MaybeBoolean,
  }),
);

/** `GET /api/v1/post/{postId}/comments` response envelope. */
export const CommentsEnvelopeSchema = z.looseObject({
  comments: z.array(CommentSchema),
  /** Comments automod held back. Always observed as `[]`; shape otherwise unverified. */
  automod_hidden_comments: z.array(z.unknown()).nullish(),
});
export type CommentsEnvelope = z.infer<typeof CommentsEnvelopeSchema>;

/**
 * A person harvested from a comment thread, deduplicated by `user_id`.
 * Not an upstream shape — this is what
 * {@link PublicationsResource.commenters} flattens a comment tree into.
 */
export const CommenterSchema = z.object({
  userId: z.number(),
  name: z.string().nullish(),
  handle: z.string().nullish(),
  photoUrl: z.string().nullish(),
});
export type Commenter = z.infer<typeof CommenterSchema>;
