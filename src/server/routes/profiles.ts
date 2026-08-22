/**
 * REST routes for people: single profile, their subscriptions, keyword search,
 * and the subscription-overlap comparison between two profiles.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRoute, requestSchema, responseSchema, commonErrorResponses } from '../openapi.js';
import {
  ProfileSchema,
  ProfileSearchQuerySchema,
  ProfileSearchResultSchema,
  SubscriberListUserSchema,
  SubscriptionSchema,
} from '../../schemas/profile.js';
import { PublicationSchema } from '../../schemas/common.js';

const HandleParamsSchema = z.object({
  handle: z.string().min(1).describe('A profile handle, e.g. "alialfredji".'),
});

const OverlapParamsSchema = z.object({
  handle: z.string().min(1).describe('First profile handle.'),
  other: z.string().min(1).describe('Second profile handle to compare against.'),
});

const UserIdParamsSchema = z.object({
  userId: z.coerce.number().int().positive().describe('Numeric Substack user id, e.g. from a note reactor.'),
});

/** Response shape for the lightweight id -> handle route. */
const HandleResolutionSchema = z.object({
  userId: z.number(),
  handle: z.string(),
});

/**
 * Response shape for the overlap route. Mirrors {@link SubscriptionOverlap}
 * from `client/resources/profiles.ts` exactly; kept as a separate schema here
 * (rather than imported) because it is a computed, client-side shape with no
 * upstream endpoint behind it, and this file is the only place that needs it
 * for OpenAPI generation.
 */
const SubscriptionOverlapSchema = z.object({
  handleA: z.string(),
  handleB: z.string(),
  subscriptionCountA: z.number(),
  subscriptionCountB: z.number(),
  overlap: z.array(PublicationSchema),
  overlapCount: z.number(),
  score: z.number().describe('Jaccard index over publication ids: overlapCount / |A ∪ B|. 0..1.'),
});

export default async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/profiles/:handle',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Fetch a profile by handle',
        description: describeRoute(
          'Returns a person\'s public profile, including their `subscriptions[]` and `primaryPublication`.',
          [
            {
              title: 'Fetch a profile',
              curl: 'curl -s http://127.0.0.1:3000/profiles/alialfredji | jq',
              ts: `const profile = await substack.profiles.getByHandle('alialfredji');\nconsole.log(profile.name, profile.subscriptions?.length);`,
              upstream: 'GET https://substack.com/api/v1/user/{handle}/public_profile',
            },
          ],
          '`isSubscribed`, `isFollowing` and `followsViewer` are viewer-relative and read `false` ' +
            'for everyone when no cookie is sent. Send `x-substack-cookie` to resolve them for the caller.',
        ),
        params: requestSchema(HandleParamsSchema),
        security: [{ substackCookie: [] }],
        response: { 200: { description: 'The profile.', ...responseSchema(ProfileSchema) }, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };
      return app.substack.profiles.getByHandle(handle, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/:handle/subscriptions',
    {
      schema: {
        tags: ['profiles'],
        summary: "A profile's subscriptions",
        description: describeRoute(
          "Returns just the `subscriptions[]` array for a profile — the publications they subscribe to. " +
            'There is no dedicated upstream endpoint for this; it is extracted from the same profile object ' +
            'as `GET /profiles/:handle`.',
          [
            {
              title: 'List subscriptions',
              curl: 'curl -s http://127.0.0.1:3000/profiles/alialfredji/subscriptions | jq',
              ts: `const subs = await substack.profiles.getSubscriptions('alialfredji');\nconsole.log(subs.map((s) => s.publication.name));`,
            },
          ],
        ),
        params: requestSchema(HandleParamsSchema),
        response: {
          200: { description: 'Array of subscriptions.', ...responseSchema(z.array(SubscriptionSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };
      return app.substack.profiles.getSubscriptions(handle, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/:handle/subscribers',
    {
      schema: {
        tags: ['profiles'],
        summary: "A profile's subscribers",
        description: describeRoute(
          "Returns the people who subscribe to a profile's publication. Enumeration works anonymously; " +
            'a cookie only resolves viewer-relative fields and grouping. The handle costs one preliminary ' +
            'public-profile lookup because the upstream list endpoint requires a numeric user id.',
          [
            {
              title: 'List subscribers',
              curl: 'curl -s http://127.0.0.1:3000/profiles/fredriktunvall/subscribers | jq',
              ts: `const users = await substack.profiles.getSubscribers('fredriktunvall');\nconsole.log(users.map((user) => user.handle));`,
              upstream: 'GET https://substack.com/api/v1/user/{userId}/subscriber-lists?lists=subscribers',
            },
          ],
          'The upstream response is unpaginated and grouped. This convenience route flattens the groups and ' +
            'deduplicates users by numeric id; use `getSubscriberLists()` in the typed client to preserve groups. ' +
            'The gateway handles Substack\'s browser-fingerprint check transparently.',
        ),
        params: requestSchema(HandleParamsSchema),
        security: [{ substackCookie: [] }],
        response: {
          200: { description: 'Flat, deduplicated array of subscribers.', ...responseSchema(z.array(SubscriberListUserSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };
      return app.substack.profiles.getSubscribers(handle, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/:handle/followers',
    {
      schema: {
        tags: ['profiles'],
        summary: "A profile's followers",
        description: describeRoute(
          'Returns the people who follow a profile. Enumeration works anonymously; a cookie only resolves ' +
            'viewer-relative fields. The handle costs one preliminary public-profile lookup because the ' +
            'upstream list endpoint requires a numeric user id.',
          [
            {
              title: 'List followers',
              curl: 'curl -s http://127.0.0.1:3000/profiles/fredriktunvall/followers | jq',
              ts: `const users = await substack.profiles.getFollowers('fredriktunvall');\nconsole.log(users.map((user) => user.handle));`,
              upstream: 'GET https://substack.com/api/v1/user/{userId}/subscriber-lists?lists=followers',
            },
          ],
          'The upstream response is unpaginated and grouped. This convenience route flattens the groups and ' +
            'deduplicates users by numeric id; use `getSubscriberLists()` in the typed client to preserve groups. ' +
            'The gateway handles Substack\'s browser-fingerprint check transparently.',
        ),
        params: requestSchema(HandleParamsSchema),
        security: [{ substackCookie: [] }],
        response: {
          200: { description: 'Flat, deduplicated array of followers.', ...responseSchema(z.array(SubscriberListUserSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };
      return app.substack.profiles.getFollowers(handle, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/by-id/:userId',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Fetch a profile by numeric user id',
        description: describeRoute(
          'Fetch a profile the same way as `GET /profiles/:handle`, but keyed by numeric user id instead of ' +
            'handle. This route exists because note reactors — `/api/v1/comment/{noteId}/reactors` — identify ' +
            'people by numeric `id` only and carry no `handle`, and `public_profile` accepts nothing but a ' +
            'handle. Substack has no JSON endpoint for id -> handle; this bridges the gap via a redirect probe ' +
            '(`GET /profile/{userId}` 301s to `/@{handle}`).',
          [
            {
              title: 'Fetch a profile by user id',
              curl: 'curl -s http://127.0.0.1:3000/profiles/by-id/86433889 | jq',
              ts: `const profile = await substack.profiles.getByUserId(86433889);\nconsole.log(profile.handle, profile.name);`,
              upstream: 'GET https://substack.com/profile/{userId} (redirect probe), then GET https://substack.com/api/v1/user/{handle}/public_profile',
            },
          ],
          'Costs **two** upstream requests (the id->handle redirect probe, then the profile fetch) unless this ' +
            'id was already resolved earlier in the server process, in which case the first step is cached and free. ' +
            'Same viewer-relative caveats as `GET /profiles/:handle` apply to the returned profile.',
        ),
        params: requestSchema(UserIdParamsSchema),
        security: [{ substackCookie: [] }],
        response: { 200: { description: 'The profile.', ...responseSchema(ProfileSchema) }, ...commonErrorResponses },
      },
    },
    async (request) => {
      const { userId } = request.params as { userId: number };
      return app.substack.profiles.getByUserId(userId, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/by-id/:userId/handle',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Resolve a numeric user id to a handle',
        description: describeRoute(
          'Just the id -> handle mapping, for callers who only need the handle and want one upstream request ' +
            'instead of the two that `GET /profiles/by-id/:userId` costs. Use this when batch-resolving many ' +
            'note reactors before deciding which ones are worth a full profile fetch.',
          [
            {
              title: 'Resolve a handle',
              curl: 'curl -s http://127.0.0.1:3000/profiles/by-id/86433889/handle | jq',
              ts: `const handle = await substack.profiles.resolveHandle(86433889);\nconsole.log(handle); // "alialfredji"`,
              upstream: 'GET https://substack.com/profile/{userId} (redirect probe only)',
            },
          ],
          'Throws (surfaced as a 500 by this gateway) when the id belongs to a deleted, deactivated, or invalid ' +
            'account — the redirect probe gets a non-3xx response with no `Location` to parse a handle out of.',
        ),
        params: requestSchema(UserIdParamsSchema),
        response: {
          200: { description: 'The resolved handle.', ...responseSchema(HandleResolutionSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { userId } = request.params as { userId: number };
      const handle = await app.substack.profiles.resolveHandle(userId, { cookie: request.substackCookie });
      return { userId, handle };
    },
  );

  app.get(
    '/profiles/search',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Search profiles',
        description: describeRoute(
          'Free-text profile search. Each result is a full profile object, including `subscriptions[]` — ' +
            'the single most useful call in this gateway, since it returns people and their subscription ' +
            'graphs in one request.',
          [
            {
              title: 'Search for people',
              curl: 'curl -s "http://127.0.0.1:3000/profiles/search?query=ai%20engineer&page=0" | jq',
              ts: `const page = await substack.profiles.search({ query: 'ai engineer', page: 0 });\nconsole.log(page.results.length, page.more);`,
              upstream: 'GET https://substack.com/api/v1/profile/search',
            },
          ],
          'Upstream requires `page` and returns 400 without it; this gateway defaults it to `0` for convenience. ' +
            'A `limit` param is not exposed because upstream silently ignores it — page size is a fixed 20. ' +
            'Results carry the same viewer-relative fields as `GET /profiles/:handle`; see that route\'s notes. ' +
            'For bounded multi-page collection, use `substack-api collect \'/profiles/search?query=...\' ' +
            '--limit 100 --max-pages 10` or the typed client\'s `profiles.searchAll()` helper.',
        ),
        querystring: requestSchema(ProfileSearchQuerySchema),
        security: [{ substackCookie: [] }],
        response: {
          200: { description: 'Search results.', ...responseSchema(ProfileSearchResultSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { query, page } = request.query as { query: string; page: number };
      return app.substack.profiles.search({ query, page }, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/profiles/:handle/overlap/:other',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Compare two profiles\' subscription graphs',
        description: describeRoute(
          'Ranks how much two people\'s reading overlaps: the publications both subscribe to, a raw count, ' +
            'and a Jaccard score (0..1) over publication ids. Built for ranking a stranger — a search result ' +
            'or a note reactor — by how much their subscriptions overlap with someone\'s own.',
          [
            {
              title: 'Compare two profiles',
              curl: 'curl -s http://127.0.0.1:3000/profiles/aiebysdr/overlap/systemdesignone | jq',
              ts: `const cmp = await substack.profiles.subscriptionOverlap('aiebysdr', 'systemdesignone');\nconsole.log(cmp.overlapCount, cmp.score);`,
            },
          ],
        ),
        params: requestSchema(OverlapParamsSchema),
        response: {
          200: { description: 'Overlap comparison.', ...responseSchema(SubscriptionOverlapSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { handle, other } = request.params as { handle: string; other: string };
      return app.substack.profiles.subscriptionOverlap(handle, other, { cookie: request.substackCookie });
    },
  );
}
