/**
 * Schemas for Substack Notes.
 *
 * Ground truth verified live against four endpoints (fixtures: user id
 * `86433889` / handle `alialfredji`, note id `314595743`):
 *
 *   - `GET /api/v1/comment/{noteId}/reactors`               — bare array
 *   - `GET /api/v1/reader/comment/{noteId}`                 — `{ item }`
 *   - `GET /api/v1/reader/feed/profile/{userId}?types[]=...`— cursor envelope
 *   - `GET /api/v1/reader/feed?types[]=...`                 — cursor envelope + trackingParameters
 *
 * See the bottom of this file for endpoint-shape notes (pagination, `types[]`
 * variants, the restacks 404) that did not fit as a doc comment on one schema.
 */

import { z } from 'zod';
import {
  MaybeBoolean,
  MaybeNumber,
  MaybeString,
  PublicationSchema,
  UserStatusSchema,
  cursorEnvelope,
} from './common.js';

/**
 * A person who reacted to (liked) a note.
 *
 * Verified on the `314595743` fixture (5 elements, see the pagination note at
 * the bottom of this file for why that is *fewer* than the note's
 * `reaction_count` of 6). Every element carried all nine keys, so `id` and
 * `name` are required; the rest stay nullish per project convention.
 *
 * `is_subscribed` and `is_following` are **viewer-relative**: anonymous calls
 * returned `false` for all five reactors here, including the one account
 * (`86433889`, this project's own fixture) that the caller unambiguously
 * knows is not "unsubscribed" in any meaningful sense — the field just isn't
 * resolved without a session cookie. This is the entire reason
 * {@link NoteFeedItemSchema} and the cookie plumbing in `SubstackHttp` exist:
 * it is what lets `unsubscribedReactors` mean something.
 */
export const ReactorSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    photo_url: MaybeString,
    primary_publication: PublicationSchema.nullish(),
    bestseller_tier: MaybeNumber,
    status: UserStatusSchema.nullish(),
    /** Viewer-relative. Always `false` on an anonymous call — see class doc. */
    is_subscribed: MaybeBoolean,
    /** Viewer-relative. Always `false` on an anonymous call — see class doc. */
    is_following: MaybeBoolean,
    /** Free-text "writes {publication name}" string shown under the name. */
    writes: MaybeString,
  })
  .describe('A person who reacted to a note.');
export type Reactor = z.infer<typeof ReactorSchema>;

/** `GET /comment/{noteId}/reactors` returns this bare array, not an envelope. */
export const ReactorListSchema = z.array(ReactorSchema);

/**
 * A user surfaced inside `item.context.users` — the account(s) that caused a
 * feed item to be shown (e.g. "X liked this" / "X and 2 others restacked").
 *
 * Verified live on the anonymous suggested feed (`/reader/feed?types[]=note`),
 * where every one of 6 items carried exactly one context user with all 11
 * keys below. On a profile's *own* feed (`/reader/feed/profile/{id}`) this
 * array was consistently empty — context users appear to be a
 * suggestion-surface signal, not something every feed item carries.
 */
export const NoteContextUserSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    handle: MaybeString,
    previous_name: MaybeString,
    photo_url: MaybeString,
    bio: MaybeString,
    profile_set_up_at: MaybeString,
    reader_installed_at: MaybeString,
    bestseller_tier: MaybeNumber,
    status: UserStatusSchema.nullish(),
    primary_publication: PublicationSchema.nullish(),
  })
  .describe('An account that caused a feed item to surface (the "suggested by" signal).');
export type NoteContextUser = z.infer<typeof NoteContextUserSchema>;

/**
 * Why/how a feed item surfaced.
 *
 * `type` and `timestamp` were present on every item observed across both feed
 * endpoints, so they are required; everything else is nullish. `users` was
 * seen both empty (`[]`, on a profile's own feed) and populated (on the
 * suggested feed) — treat an absent/empty array as "no attribution", not as
 * missing data.
 */
export const NoteContextSchema = z
  .looseObject({
    /** e.g. `"note"`, `"post"`. */
    type: z.string(),
    timestamp: z.string(),
    /** Accounts responsible for this item surfacing. See {@link NoteContextUserSchema}. */
    users: z.array(NoteContextUserSchema).nullish(),
    fallbackReason: MaybeString,
    fallbackUrl: MaybeString,
    isFresh: MaybeBoolean,
    /** e.g. `"generated-db"`, `"model"`, `"db-like"`, `"db-restack"`. */
    source: MaybeString,
    page: MaybeNumber,
    page_rank: MaybeNumber,
  })
  .describe('Attribution/ranking metadata for why a feed item was shown.');
export type NoteContext = z.infer<typeof NoteContextSchema>;

/**
 * The note text itself, embedded on a feed item as `item.comment`.
 *
 * Verified live via `/reader/comment/{noteId}`. `id`, `body`, `name`, `handle`
 * and `date` were present on the fixture; everything else (edit metadata,
 * attachments, media clips) is situational and stays nullish.
 *
 * `reactions` is a map of emoji to count (e.g. `{"❤":6}`), not a list of
 * reactors — there is no per-user reaction data here. For "who", call
 * {@link ReactorSchema}'s endpoint. `reaction_count` is the aggregate total
 * and, per the fixture, is **not guaranteed to equal `reactors().length`** —
 * see the note at the bottom of this file.
 */
export const NoteCommentSchema = z
  .looseObject({
    id: z.number(),
    body: z.string(),
    name: z.string(),
    handle: z.string(),
    date: z.string(),
    body_json: z.unknown().nullish(),
    photo_url: MaybeString,
    bio: MaybeString,
    publication_id: MaybeNumber,
    post_id: MaybeNumber,
    user_id: MaybeNumber,
    /** e.g. `"comment"`. */
    type: MaybeString,
    edited_at: MaybeString,
    ancestor_path: MaybeString,
    reply_minimum_role: MaybeString,
    media_clip_id: MaybeString,
    reaction_count: MaybeNumber,
    /** Emoji -> count map, e.g. `{"❤": 6}`. No per-user breakdown; use {@link ReactorSchema}. */
    reactions: z.record(z.string(), z.number()).nullish(),
    restacks: MaybeNumber,
    restacked: MaybeBoolean,
    children_count: MaybeNumber,
    attachments: z.array(z.unknown()).nullish(),
    user_bestseller_tier: MaybeNumber,
    userStatus: UserStatusSchema.nullish(),
    user_primary_publication: PublicationSchema.nullish(),
    language: MaybeString,
    autotranslate_to: MaybeString,
    is_ai_generated_text: MaybeBoolean,
  })
  .describe('The text and metadata of a single note.');
export type NoteComment = z.infer<typeof NoteCommentSchema>;

/**
 * Cross-endpoint tracking/analytics bag. Appears at the top level of the
 * suggested feed (`/reader/feed`) and, per ground truth, on individual feed
 * items too. Purely descriptive telemetry — nothing here is required for any
 * client behaviour, so every field is nullish.
 */
export const TrackingParametersSchema = z
  .looseObject({
    feed_session_id: MaybeString,
    top_note_impression_id: MaybeString,
    tab_id: MaybeString,
    top_note_entity_key: MaybeString,
    top_note_source: MaybeString,
    top_note_context_user_ids: z.array(z.unknown()).nullish(),
    top_note_context_type: MaybeString,
    is_following: MaybeBoolean,
    followed_user_count: MaybeNumber,
    subscribed_publication_count: MaybeNumber,
  })
  .describe('Analytics/session telemetry attached to a feed response or item.');
export type TrackingParameters = z.infer<typeof TrackingParametersSchema>;

/**
 * One entry of a feed's `items[]` array — a note, or (when `types[]` includes
 * `post`/`like`/`restack`) a post, like, or restack activity record wearing
 * the same envelope. `entity_key`, `type` and `context` were present on every
 * item across every `types[]` variant tried; `comment` and `post` are
 * mutually situational (a note-shaped item has `comment` and a null `post`;
 * a post-type item has the reverse), so both stay nullish.
 */
export const NoteFeedItemSchema = z
  .looseObject({
    /** e.g. `"c-314595743"` for a note, `"p-210456417"` for a post. */
    entity_key: z.string(),
    /** Item kind: e.g. `"comment"`, `"post"`. */
    type: z.string(),
    context: NoteContextSchema,
    publication: PublicationSchema.nullish(),
    /** Shape not catalogued here — posts are another module's schema. Passed through raw. */
    post: z.unknown().nullish(),
    comment: NoteCommentSchema.nullish(),
    parentComments: z.array(z.unknown()).nullish(),
    canReply: MaybeBoolean,
    isMuted: MaybeBoolean,
    trackingParameters: TrackingParametersSchema.nullish(),
    canShowFollowUpsell: MaybeBoolean,
    canShowCommentReveal: MaybeBoolean,
  })
  .describe('A single feed item: a note, or another activity type sharing the same envelope.');
export type NoteFeedItem = z.infer<typeof NoteFeedItemSchema>;

/** `GET /reader/comment/{noteId}` response envelope: a single item wrapped in `{ item }`. */
export const SingleNoteResponseSchema = z.looseObject({ item: NoteFeedItemSchema });

/**
 * Cursor-paginated feed response, shared by `/reader/feed/profile/{userId}`
 * and `/reader/feed`. The latter additionally carries top-level
 * `trackingParameters` (verified: 10 keys, see {@link TrackingParametersSchema});
 * the profile feed does not, so it stays nullish rather than required.
 */
export const NoteFeedPageSchema = cursorEnvelope(NoteFeedItemSchema).extend({
  trackingParameters: TrackingParametersSchema.nullish(),
});
export type NoteFeedPage = z.infer<typeof NoteFeedPageSchema>;

// ---------------------------------------------------------------------------
// Endpoint-shape notes that didn't fit as a doc comment on one schema.
// ---------------------------------------------------------------------------
//
// Reactors pagination (`GET /comment/{noteId}/reactors`):
//   `limit`, `offset`, and `page` query params were all tried against the
//   `314595743` fixture and every one of them returned the identical 5
//   elements in the identical order. There is no working pagination on this
//   endpoint — it always returns its full (apparently uncapped-by-us) list in
//   one shot. The fixture's `reaction_count` is 6 but `reactors()` returns
//   only 5: the endpoint is not silently truncating (pagination params do
//   nothing), so the likely explanation is a reactor whose account is
//   deactivated/blocked/otherwise excluded from the list view while the
//   aggregate counter never decremented. Do not assume `reactors().length`
//   will equal `comment.reaction_count`; expose both and let the caller
//   decide which one they trust.
//
// `types[]` values on both feed endpoints — all five tried, all valid (never
// an error, always a well-formed cursor envelope):
//   - `note`    — the default. Notes authored/reacted to by the profile.
//   - `comment` — accepted but returned 0 items for the `alialfredji` fixture
//                 (this account has no post comments); the envelope shape was
//                 identical to `note`, just empty.
//   - `post`    — post-shaped items, `item.type === 'post'`, `item.post` populated.
//   - `like`    — like activity, `item.context.source === 'db-like'`.
//   - `restack` — restack activity, `item.context.source === 'db-restack'`.
//   Multiple values combine (tested `types[]=note&types[]=comment`) rather than
//   the last one winning.
//
// `cursor` round-trips correctly on the profile feed: passing back a
// `nextCursor` verbatim advanced to a genuinely new page (different items,
// `page_number` incremented inside the opaque token, `before_timestamp` held
// steady) rather than repeating page 1. Treat the cursor as opaque; the
// internal shape (a base64 JSON blob with `before_timestamp`, `entity_key`,
// `pinned_entity_keys`, `context_timestamp`, `prepended_post_ids`,
// `page_number`) is an implementation detail we should not depend on.
//
// Restackers endpoint: `GET /api/v1/comment/{noteId}/restacks` returns 404,
// confirmed live on the `314595743` fixture. There is no dedicated "who
// restacked this note" endpoint; `types[]=restack` on the profile feed is the
// closest available signal, and it is scoped to one profile's own restacking
// activity, not a given note's restackers.
