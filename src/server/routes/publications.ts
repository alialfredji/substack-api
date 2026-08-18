/**
 * Newsletters: search, archive, individual posts, comments, commenters, and
 * the recommendation graph. See `src/client/resources/publications.ts` for
 * what was verified live against the upstream API — the notes there explain
 * *why* each route is shaped the way it is; this file just wires it to HTTP.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { commonErrorResponses, describeRoute, requestSchema, responseSchema } from '../openapi.js';
import {
  PublicationSearchResponseSchema,
  PostSearchResponseSchema,
  RecommendationsResponseSchema,
  RelatedPublicationSchema,
} from '../../schemas/publication.js';
import { ArchiveResponseSchema, PostSchema, CommentsEnvelopeSchema, CommenterSchema } from '../../schemas/post.js';

const SubdomainParamSchema = z.object({
  subdomain: z
    .string()
    .regex(/^[a-z0-9-]+$/i)
    .describe('Publication subdomain, e.g. "aieworks" for aieworks.substack.com.'),
});

const SlugParamSchema = SubdomainParamSchema.extend({
  slug: z.string().min(1).describe('Post slug, e.g. "lesson-5-reranking-improving-on-raw". Get it from the archive route.'),
});

const PostIdParamSchema = SubdomainParamSchema.extend({
  postId: z.coerce.number().int().positive().describe('Numeric post id. Get it from the archive route\'s `id` field.'),
});

const PublicationSearchQuerySchema = z.object({
  query: z.string().min(1).describe('Keyword to search publication names, hero text, etc.'),
  limit: z
    .coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Forwarded to Substack as-is. Verified live to have no observed effect: values of 2, 5, 18 and 100 ' +
        'all returned the same ~18-19 item batch. Kept for forward-compatibility; use `page` to get more results.',
    ),
  page: z.coerce.number().int().min(0).optional().describe('Zero-based page index. Verified to actually change the result set.'),
});

const PostSearchQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().optional(),
});

const ArchiveQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z
    .coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Verified to page correctly: offset=3 returns different posts than the first 3.'),
  sort: z
    .enum(['new', 'top', 'community'])
    .optional()
    .describe('"new" and "top" verified to reorder results. "community" 200s but its distinct effect was not confirmed.'),
});

const CommentsQuerySchema = z.object({
  sort: z.string().optional().describe('Verified: "best_first" works. Other values untested.'),
  allComments: z.coerce.boolean().optional().describe('Forwarded as `all_comments`. Defaults to true.'),
});

const RecommendationsQuerySchema = z.object({
  publicationId: z
    .coerce
    .number()
    .int()
    .positive()
    .describe(
      'Numeric id of the publication whose outgoing recommendations to fetch. Get it from the `id` field ' +
        'of a result in GET /publications/search.',
    ),
});

const RelatedQuerySchema = RecommendationsQuerySchema.extend({
  limit: z.coerce.number().int().positive().optional().describe('Stop after this many related publications. Default 100.'),
  maxPages: z.coerce.number().int().positive().optional().describe('Stop after this many recommendation-graph hops. Default 20.'),
});

export default async function publicationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { query: string; limit?: number; page?: number } }>(
    '/publications/search',
    {
      schema: {
        tags: ['publications'],
        summary: 'Search publications by keyword',
        description: describeRoute(
          'Keyword search across publication names, hero text, and descriptions.',
          [
            {
              title: 'Find AI newsletters',
              curl: "curl -s 'http://127.0.0.1:3000/publications/search?query=ai&limit=10' | jq",
              ts: "const { results } = await substack.publications.search({ query: 'ai', limit: 10 });",
              upstream: 'GET https://substack.com/api/v1/publication/search',
            },
          ],
          '`limit` is forwarded but verified to have no observed effect on how many results come back — Substack ' +
            'returns a fixed ~18-19 item batch regardless. Increment `page` to see more. Also verified: under ' +
            'sustained use this endpoint can degrade to an empty `results` array with the `more` key missing ' +
            'entirely, even for a query with real matches minutes earlier — treat that as throttling, not "no matches".',
        ),
        querystring: requestSchema(PublicationSearchQuerySchema),
        response: {
          200: { description: 'Search results.', ...responseSchema(PublicationSearchResponseSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { query, limit, page } = request.query;
      return app.substack.publications.search({ query, limit, page }, { cookie: request.substackCookie });
    },
  );

  app.get<{ Querystring: { query: string; limit?: number } }>(
    '/posts/search',
    {
      schema: {
        tags: ['publications'],
        summary: 'Search posts by keyword',
        description: describeRoute(
          'Keyword search across post content, cross-publication.',
          [
            {
              title: 'Search for posts about AI',
              curl: "curl -s 'http://127.0.0.1:3000/posts/search?query=ai&limit=10' | jq",
              ts: "const { results } = await substack.publications.searchPosts({ query: 'ai', limit: 10 });",
              upstream: 'GET https://substack.com/api/v1/post/search',
            },
          ],
          'Verified live: nine distinct queries (including generic terms like "ai", "startup", "the", "bitcoin") ' +
            'all returned empty result arrays. The route and envelope are real and documented; whether it returns ' +
            'anything for any query, anonymously, is unconfirmed. Do not assume a bug in this gateway if you get ' +
            'nothing back — confirm against the raw upstream URL first.',
        ),
        querystring: requestSchema(PostSearchQuerySchema),
        response: {
          200: { description: 'Search results.', ...responseSchema(PostSearchResponseSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { query, limit } = request.query;
      return app.substack.publications.searchPosts({ query, limit }, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { subdomain: string }; Querystring: { limit?: number; offset?: number; sort?: string } }>(
    '/publications/:subdomain/archive',
    {
      schema: {
        tags: ['publications'],
        summary: "List a publication's posts",
        description: describeRoute(
          "A publication's post archive, newest or top first.",
          [
            {
              title: 'Newest posts from a publication',
              curl: "curl -s 'http://127.0.0.1:3000/publications/aieworks/archive?sort=new&limit=10' | jq",
              ts: "const posts = await substack.publications.archive('aieworks', { sort: 'new', limit: 10 });",
              upstream: 'GET https://{subdomain}.substack.com/api/v1/archive',
            },
          ],
        ),
        params: requestSchema(SubdomainParamSchema),
        querystring: requestSchema(ArchiveQuerySchema),
        response: {
          200: { description: 'Posts, newest or top first.', ...responseSchema(ArchiveResponseSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain } = request.params;
      const { limit, offset, sort } = request.query;
      return app.substack.publications.archive(subdomain, { limit, offset, sort }, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { subdomain: string; slug: string } }>(
    '/publications/:subdomain/posts/:slug',
    {
      schema: {
        tags: ['publications'],
        summary: 'Fetch a single post by slug',
        description: describeRoute(
          'Fetch one post, including its full HTML body.',
          [
            {
              title: 'Fetch a post',
              curl: 'curl -s http://127.0.0.1:3000/publications/aieworks/posts/lesson-5-reranking-improving-on-raw | jq',
              ts: "const post = await substack.publications.getPost('aieworks', 'lesson-5-reranking-improving-on-raw');",
              upstream: 'GET https://{subdomain}.substack.com/api/v1/posts/{slug}',
            },
          ],
          'Slug only. There is no numeric-id lookup on this API — `GET /api/v1/post/{id}` and ' +
            '`GET /api/v1/posts/id/{id}` were both verified live to 404. Get the slug from the archive route.',
        ),
        params: requestSchema(SlugParamSchema),
        response: {
          200: { description: 'The post.', ...responseSchema(PostSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain, slug } = request.params;
      return app.substack.publications.getPost(subdomain, slug, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { subdomain: string; postId: number }; Querystring: { sort?: string; allComments?: boolean } }>(
    '/publications/:subdomain/posts/:postId/comments',
    {
      schema: {
        tags: ['publications'],
        summary: "Fetch a post's comments",
        description: describeRoute(
          'Full comment tree for a post, including nested replies under `children`.',
          [
            {
              title: 'Fetch comments',
              curl: "curl -s 'http://127.0.0.1:3000/publications/platformer/posts/140489606/comments?sort=best_first' | jq",
              ts: "const { comments } = await substack.publications.comments('platformer', 140489606, { sort: 'best_first' });",
              upstream: 'GET https://{subdomain}.substack.com/api/v1/post/{postId}/comments',
            },
          ],
          'Verified live: works anonymously on posts where comment viewing is not gated (confirmed on `platformer`). ' +
            'Several high-traffic publications returned an empty array despite a non-zero `comment_count` on the ' +
            "archive listing — that is gating on the upstream's side, not a bug here.",
        ),
        params: requestSchema(PostIdParamSchema),
        querystring: requestSchema(CommentsQuerySchema),
        response: {
          200: { description: 'Comment tree.', ...responseSchema(CommentsEnvelopeSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain, postId } = request.params;
      const { sort, allComments } = request.query;
      return app.substack.publications.comments(subdomain, postId, { sort, allComments }, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { subdomain: string; postId: number } }>(
    '/publications/:subdomain/posts/:postId/commenters',
    {
      schema: {
        tags: ['publications'],
        summary: 'Fetch deduplicated commenters for a post',
        description: describeRoute(
          "The post's full comment tree flattened into one deduplicated list of people, by user id.",
          [
            {
              title: 'Harvest commenters',
              curl: 'curl -s http://127.0.0.1:3000/publications/platformer/posts/140489606/commenters | jq',
              ts: "const people = await substack.publications.commenters('platformer', 140489606);",
            },
          ],
          'Engaged commenters are a stronger signal than likes for finding real, active readers. Subject to the ' +
            'same viewing gate as the comments route: an empty array on a post with real comments means the ' +
            'thread is not readable anonymously, not that nobody commented.',
        ),
        params: requestSchema(PostIdParamSchema),
        response: {
          200: { description: 'Deduplicated commenters.', ...responseSchema(z.array(CommenterSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain, postId } = request.params;
      return app.substack.publications.commenters(subdomain, postId, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { subdomain: string }; Querystring: { publicationId: number } }>(
    '/publications/:subdomain/recommendations',
    {
      schema: {
        tags: ['publications'],
        summary: 'Which publications does this one recommend?',
        description: describeRoute(
          "A publication's outgoing recommendations.",
          [
            {
              title: 'Fetch recommendations',
              curl: "curl -s 'http://127.0.0.1:3000/publications/aieworks/recommendations?publicationId=5081214' | jq",
              ts: "const recs = await substack.publications.recommendations('aieworks', 5081214);",
              upstream: 'GET https://{subdomain}.substack.com/api/v1/recommendations/from/{publicationId}',
            },
          ],
          'Requires the subdomain, not just the id — `GET /api/v1/publication/{id}/recommendations` on the root ' +
            'host is a confirmed 404. Get `publicationId` from a result of `GET /publications/search` (its `id` ' +
            'field); the subdomain in the path must be that same publication\'s.',
        ),
        params: requestSchema(SubdomainParamSchema),
        querystring: requestSchema(RecommendationsQuerySchema),
        response: {
          200: { description: 'Recommendation edges.', ...responseSchema(RecommendationsResponseSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain } = request.params;
      const { publicationId } = request.query;
      return app.substack.publications.recommendations(subdomain, publicationId, { cookie: request.substackCookie });
    },
  );

  app.get<{
    Params: { subdomain: string };
    Querystring: { publicationId: number; limit?: number; maxPages?: number };
  }>(
    '/publications/:subdomain/related',
    {
      schema: {
        tags: ['publications'],
        summary: 'Find publications adjacent to this one',
        description: describeRoute(
          'Breadth-first walk of the recommendation graph: publications this one recommends, publications those ' +
            'recommend, and so on, deduplicated with distance from the start.',
          [
            {
              title: 'Find publications adjacent to aieworks',
              curl: "curl -s 'http://127.0.0.1:3000/publications/aieworks/related?publicationId=5081214&limit=20' | jq",
              ts: "const related = await substack.publications.relatedPublications('aieworks', 5081214, { limit: 20 });",
            },
          ],
          'Not a single upstream endpoint — composed from repeated `recommendations` calls with a visited-set and ' +
            'two caps (`limit` on total results, `maxPages` on graph hops) so a densely connected neighbourhood ' +
            "cannot balloon into an unbounded crawl. Get `publicationId` the same way as for the recommendations route.",
        ),
        params: requestSchema(SubdomainParamSchema),
        querystring: requestSchema(RelatedQuerySchema),
        response: {
          200: { description: 'Adjacent publications, nearest first.', ...responseSchema(z.array(RelatedPublicationSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { subdomain } = request.params;
      const { publicationId, limit, maxPages } = request.query;
      return app.substack.publications.relatedPublications(subdomain, publicationId, {
        limit,
        maxPages,
        cookie: request.substackCookie,
      });
    },
  );
}
