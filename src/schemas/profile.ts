/**
 * Schemas for Substack people ("profiles").
 *
 * Ground truth verified live against `GET /api/v1/user/{handle}/public_profile`
 * (handle `alialfredji`, id `86433889`) and `GET /api/v1/profile/search?query=&page=`
 * (query `ai engineer`). See {@link ProfileSchema} and {@link SubscriptionSchema}
 * for the exact fields confirmed present, and the bottom of this file for
 * endpoint shape notes that did not fit anywhere else.
 */

import { z } from 'zod';
import { MaybeBoolean, MaybeNumber, MaybeString, PublicationSchema, ThemeSchema, UserStatusSchema, searchEnvelope } from './common.js';

/**
 * One entry of a profile's `subscriptions[]` array.
 *
 * Verified on live data (9 entries on `aiebysdr`, 6 on `systemdesignone`, 87 on
 * `aiengineeringinsider`): every entry carried all seven keys below, so `id`,
 * `user_id` and `publication` are required; the rest are enum-shaped strings we
 * have only seen populated but keep nullish out of caution — an undocumented
 * API can always emit a null for a field it has never nulled before.
 *
 * `publication` reuses {@link PublicationSchema} verbatim: the nested object
 * matched it field-for-field, plus a few extras (`homepage_type`, `logo_url_wide`,
 * `theme`, `author`) that `looseObject` preserves without us needing to type them.
 */
export const SubscriptionSchema = z
  .looseObject({
    id: z.number(),
    user_id: z.number(),
    publication: PublicationSchema,
    /** e.g. `"public"`. */
    visibility: MaybeString,
    /** e.g. `"subscribed"`, `"free_signup"`. */
    membership_state: MaybeString,
    /** e.g. `"paid"`, `"free"`, `"comp"`. */
    type: MaybeString,
    is_founding: MaybeBoolean,
  })
  .describe('A single publication subscription entry on a profile.');
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** The two public relationship lists exposed on a profile page. */
export const SubscriberListKindSchema = z.enum(['subscribers', 'followers']);
export type SubscriberListKind = z.infer<typeof SubscriberListKindSchema>;

/**
 * A person returned by `/api/v1/user/{userId}/subscriber-lists`.
 *
 * This is close to a note reactor, but additionally carries the profile
 * `handle` and a few profile metadata fields. The two relationship booleans
 * are viewer-relative; enumeration itself works anonymously.
 */
export const SubscriberListUserSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    handle: z.string(),
    previous_name: MaybeString,
    photo_url: MaybeString,
    bio: MaybeString,
    profile_set_up_at: MaybeString,
    reader_installed_at: MaybeString,
    primary_publication: PublicationSchema.nullish(),
    bestseller_tier: MaybeNumber,
    status: UserStatusSchema.nullish(),
    /** Viewer-relative; anonymous calls return `false`. */
    is_subscribed: MaybeBoolean,
    /** Viewer-relative; anonymous calls return `false`. */
    is_following: MaybeBoolean,
    /** Free-text "writes {publication name}" string shown under the name. */
    writes: MaybeString,
  })
  .describe('A person in a profile subscriber or follower list.');
export type SubscriberListUser = z.infer<typeof SubscriberListUserSchema>;

export const SubscriberListGroupSchema = z
  .looseObject({
    /** Viewer-dependent grouping label; `null` for the follower list. */
    name: MaybeString,
    users: z.array(SubscriberListUserSchema),
  })
  .describe('One display group within a subscriber or follower list.');
export type SubscriberListGroup = z.infer<typeof SubscriberListGroupSchema>;

export const SubscriberListSchema = z
  .looseObject({
    id: SubscriberListKindSchema,
    name: z.string(),
    groups: z.array(SubscriberListGroupSchema),
  })
  .describe('One requested subscriber or follower list, preserving Substack display groups.');
export type SubscriberList = z.infer<typeof SubscriberListSchema>;

export const SubscriberListsResponseSchema = z
  .looseObject({
    subscriberLists: z.array(SubscriberListSchema),
  })
  .describe('Grouped subscriber and/or follower lists for a profile.');
export type SubscriberListsResponse = z.infer<typeof SubscriberListsResponseSchema>;

/**
 * A Substack person ("profile"). Returned by both `GET /user/{handle}/public_profile`
 * and as each entry of `GET /profile/search`'s `results[]` — identical shape in
 * both places, which is why {@link ProfileSearchResultSchema} just wraps this.
 *
 * Only `id`, `name` and `handle` are required: every other field is present on
 * some responses and absent, null, or empty on others (e.g. `subscriptions` is
 * `[]` for accounts with none, and `subdomainUrl` / `isPersonalEligible` showed
 * up on `public_profile` but were absent from a `profile/search` result for the
 * same shape of account).
 *
 * Viewer-relative fields — see the trio below — read `false` for everyone when
 * the request has no cookie, and only resolve correctly for the caller's own
 * relationship to this profile when a session cookie is sent. This was verified
 * live: an anonymous call to `alialfredji`'s own profile came back with
 * `isSubscribed: false, isFollowing: false, followsViewer: false` even though
 * that call was inherently "self".
 */
export const ProfileSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    handle: z.string(),
    previous_name: MaybeString,
    photo_url: MaybeString,
    bio: MaybeString,
    profile_set_up_at: MaybeString,
    reader_installed_at: MaybeString,
    tos_accepted_at: MaybeString,
    profile_disabled: MaybeBoolean,
    /** Social links the user added to their profile. Shape not yet catalogued; passed through raw. */
    userLinks: z.array(z.unknown()).nullish(),
    /** Publications this person is a team member (author/admin) of. Shape not yet catalogued. */
    publicationUsers: z.array(z.unknown()).nullish(),
    theme: ThemeSchema.nullish(),
    /**
     * This person's subscriptions. The single most useful field in the whole
     * project: combined with {@link ProfileSearchResultSchema}, one search call
     * returns N people *and* N subscription graphs in one round trip.
     */
    subscriptions: z.array(SubscriptionSchema).nullish(),
    /** True when `subscriptions` was capped and does not list everything. */
    subscriptionsTruncated: MaybeBoolean,
    hasGuestPost: MaybeBoolean,
    primaryPublication: PublicationSchema.nullish(),
    max_pub_tier: MaybeNumber,
    hasPosts: MaybeBoolean,
    hasActivity: MaybeBoolean,
    hasLikes: MaybeBoolean,
    primaryPublicationPodcastTabInfo: z.unknown().nullish(),
    primaryPublicationChatEnabled: MaybeBoolean,
    /** "Reading lists" this person has published. Shape not yet catalogued. */
    lists: z.array(z.unknown()).nullish(),
    rough_num_free_subscribers_int: MaybeNumber,
    /** Human string bucket, e.g. `"Tens"`, `"Hundreds"`. */
    rough_num_free_subscribers: MaybeString,
    bestseller_badge_disabled: MaybeBoolean,
    bestseller_tier: MaybeNumber,
    subscriberCountString: MaybeString,
    subscriberCount: MaybeString,
    subscriberCountNumber: MaybeNumber,
    /** True when `publicationUsers` was filtered down (e.g. hidden collaborators). */
    hasHiddenPublicationUsers: MaybeBoolean,
    visibleSubscriptionsCount: MaybeNumber,
    followerCount: MaybeNumber,
    slug: MaybeString,
    previousSlug: MaybeString,
    primaryPublicationIsPledged: MaybeBoolean,
    primaryPublicationSubscriptionState: MaybeString,
    /** Viewer-relative. `false` when the request carries no session cookie. */
    isSubscribed: MaybeBoolean,
    /** Viewer-relative. `false` when the request carries no session cookie. */
    isFollowing: MaybeBoolean,
    /** Viewer-relative: does this profile follow *the caller*. Same caveat as `isFollowing`. */
    followsViewer: MaybeBoolean,
    can_dm: MaybeBoolean,
    subdomainUrl: MaybeString,
    isPersonalEligible: MaybeBoolean,
    status: UserStatusSchema.nullish(),
  })
  .describe('A Substack person (profile), with their publication and subscription graph.');
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * `GET /api/v1/profile/search` response envelope: `{ results: Profile[], more }`.
 *
 * Verified: `query` is required, and `page` is also required upstream — omitting
 * it returns `400 { "errors": [{ "location": "query", "param": "page", "msg":
 * "Invalid value" }] }`. A `limit` query param is silently ignored: requests with
 * `limit=3`, `limit=50`, and no `limit` at all returned the exact same 20 results
 * in the exact same order for the same page. Page size is a fixed 20 (confirmed
 * across 5 pages of the `ai engineer` fixture query, which had 86 total results —
 * pages 0-3 returned 20 each, page 4 returned the remaining 6 with `more: false`).
 */
export const ProfileSearchResultSchema = searchEnvelope(ProfileSchema);
export type ProfileSearchResult = z.infer<typeof ProfileSearchResultSchema>;

/**
 * Query params for `GET /profiles/search` as exposed by *this* gateway.
 * Upstream requires `page`; the gateway defaults it to `0` so callers do not
 * have to know that quirk. `limit` is intentionally not exposed — upstream
 * ignores it, so surfacing it would just be a lie callers could believe.
 */
export const ProfileSearchQuerySchema = z.object({
  query: z.string().min(1).describe('Free-text search query, e.g. "ai engineer".'),
  page: z.coerce.number().int().min(0).default(0).describe('Zero-based page index. Upstream requires this; defaulted to 0 here.'),
});
export type ProfileSearchQuery = z.infer<typeof ProfileSearchQuerySchema>;

// Endpoint variants probed and confirmed *absent* (all returned a plain 404,
// not an HTML page — so these paths are recognized-but-missing, not typos):
//
//   - GET /api/v1/user/{id}/public_profile  — no numeric-id variant; handle only.
//   - GET /api/v1/profile/{slug}            — does not exist.
//   - GET /api/v1/user/{handle}/profile     — does not exist (no "public_" prefix).
//
// `public_profile` by handle is the only read path for a single person.
