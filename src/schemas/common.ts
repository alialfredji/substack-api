/**
 * Schema building blocks shared by more than one resource.
 *
 * Two conventions run through every schema in this project:
 *
 *  1. **Everything is a `looseObject`.** Substack's API is undocumented and adds
 *     fields without notice. A strict object would silently drop data we did not
 *     know about; a loose one keeps it. You get types for the fields we have
 *     verified against the live API, and the rest survives on the object.
 *
 *  2. **Only fields verified present on live responses are required.** Anything
 *     observed as null, or observed on some responses but not others, is
 *     `.nullish()`. Being wrong in this direction produces a validation warning;
 *     being wrong in the other direction breaks a caller's script.
 */

import { z } from 'zod';

/** Loose string that tolerates the `null` Substack frequently returns. */
export const MaybeString = z.string().nullish();
/** Loose number that tolerates null. */
export const MaybeNumber = z.number().nullish();
/** Loose boolean that tolerates null. */
export const MaybeBoolean = z.boolean().nullish();

/**
 * Badge / tier metadata attached to a user.
 *
 * Verified keys on `public_profile.status`:
 * `bestsellerTier, subscriberTier, leaderboard, vip, badge, subscriber`.
 */
export const UserStatusSchema = z
  .looseObject({
    bestsellerTier: MaybeNumber,
    subscriberTier: z.unknown().nullish(),
    leaderboard: z.unknown().nullish(),
    vip: MaybeBoolean,
    badge: z.unknown().nullish(),
    subscriber: z.unknown().nullish(),
  })
  .describe('Badge and tier metadata for a user.');
export type UserStatus = z.infer<typeof UserStatusSchema>;

/**
 * A publication.
 *
 * This one object shows up in at least five different places (a profile's
 * `primaryPublication`, each entry of `subscriptions[].publication`, a reactor's
 * `primary_publication`, publication search results, leaderboard rows) and the
 * field set differs between them. Hence: `id`, `name` and `subdomain` required,
 * everything else optional.
 */
export const PublicationSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    subdomain: MaybeString,
    custom_domain: MaybeString,
    custom_domain_optional: MaybeBoolean,
    hero_text: MaybeString,
    logo_url: MaybeString,
    cover_photo_url: MaybeString,
    author_id: MaybeNumber,
    primary_user_id: MaybeNumber,
    user_id: MaybeNumber,
    created_at: MaybeString,
    language: MaybeString,
    email_from_name: MaybeString,
    copyright: MaybeString,
    founding_plan_name: MaybeString,
    community_enabled: MaybeBoolean,
    invite_only: MaybeBoolean,
    payments_state: MaybeString,
    pledges_enabled: MaybeBoolean,
    explicit: MaybeBoolean,
    is_personal_mode: MaybeBoolean,
    handles_enabled: MaybeBoolean,
    theme_var_background_pop: MaybeString,
    rough_num_free_subscribers_int: MaybeNumber,
    rough_num_free_subscribers: MaybeString,
  })
  .describe('A Substack publication (newsletter).');
export type Publication = z.infer<typeof PublicationSchema>;

/**
 * The canonical web URL for a publication, preferring a custom domain.
 * Not part of the upstream payload; a convenience for consumers.
 */
export function publicationUrl(pub: Pick<Publication, 'subdomain' | 'custom_domain'>): string | null {
  if (pub.custom_domain) return `https://${pub.custom_domain}`;
  if (pub.subdomain) return `https://${pub.subdomain}.substack.com`;
  return null;
}

/** Publication theme block on a profile. */
export const ThemeSchema = z
  .looseObject({
    colors: z.unknown().nullish(),
    fonts: z.unknown().nullish(),
    wordmark: z.unknown().nullish(),
  })
  .describe('Visual theme for a profile or publication.');
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Wrap an item schema in Substack's `{ results, more }` search envelope.
 * Used by `publication/search` and `profile/search`.
 */
export function searchEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({
    results: z.array(item),
    /** True when another page exists. Increment `page` to fetch it. */
    more: z.boolean().nullish(),
  });
}

/**
 * Wrap an item schema in Substack's cursor-paginated feed envelope.
 * Used by every `reader/feed*` endpoint.
 */
export function cursorEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({
    items: z.array(item),
    originalCursorTimestamp: MaybeString,
    /** Pass back as `cursor` to fetch the next page. Absent at end of feed. */
    nextCursor: MaybeString,
  });
}

/** Query shape for the two `page`-based search endpoints. */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0).describe('Zero-based page index.'),
});

/** Query shape for cursor-paginated feeds. */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional().describe('`nextCursor` from a previous response.'),
});
