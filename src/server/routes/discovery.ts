/**
 * Category taxonomy and per-category leaderboards.
 *
 * See `src/schemas/discovery.ts` for the full probe log this route set is
 * built on — which upstream params are real (`page`) and which are dead
 * weight we forward anyway for forward compatibility (`type`).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRoute, requestSchema, responseSchema, commonErrorResponses } from '../openapi.js';
import {
  CategorySchema,
  CategoryTreeNodeSchema,
  LeaderboardPageSchema,
  LeaderboardQuerySchema,
} from '../../schemas/discovery.js';

/** Path param shared by every `:category` route below. */
const CategoryParamsSchema = z.object({
  category: z.string().describe('Category id, slug, or name — case-insensitive on slug and name.'),
});

export default async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/discovery/categories',
    {
      schema: {
        tags: ['discovery'],
        summary: 'List every discovery category',
        description: describeRoute(
          'The full taxonomy: 32 top-level categories, each with its subcategories nested underneath. ' +
            'Start here to find the id, slug, or name to feed into the leaderboard route below.',
          [
            {
              title: 'List categories',
              curl: "curl -s http://127.0.0.1:3000/discovery/categories | jq '.[] | {id, name, slug}'",
              ts: 'const categories = await substack.discovery.categories();',
              upstream: 'GET https://substack.com/api/v1/categories',
            },
          ],
        ),
        response: {
          200: { description: 'All 32 top-level categories, with subcategories nested.', ...responseSchema(z.array(CategorySchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => app.substack.discovery.categories({ cookie: request.substackCookie }),
  );

  app.get(
    '/discovery/categories/tree',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Category taxonomy as explicit parent/child groups',
        description: describeRoute(
          'The same taxonomy as /discovery/categories, regrouped explicitly by `parent_tag_id` into ' +
            '`{ category, children }` pairs instead of relying on the nested `subcategories` field.',
          [
            {
              title: 'Get the tree',
              curl: "curl -s http://127.0.0.1:3000/discovery/categories/tree | jq '.[0]'",
              ts: 'const tree = await substack.discovery.categoryTree();',
            },
          ],
        ),
        response: {
          200: { description: 'Parent categories paired with their children.', ...responseSchema(z.array(CategoryTreeNodeSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => app.substack.discovery.categoryTree({ cookie: request.substackCookie }),
  );

  app.get(
    '/discovery/categories/:category',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Resolve a category by id, slug, or name',
        description: describeRoute(
          'Looks up one category or subcategory by numeric id, slug, or name (case-insensitive on the ' +
            'latter two). Useful to confirm you have the right id, or to discover a subcategory, before ' +
            'pulling its leaderboard.',
          [
            {
              title: 'Resolve by name',
              curl: 'curl -s http://127.0.0.1:3000/discovery/categories/Technology | jq',
              ts: "const tech = await substack.discovery.findCategory('technology');",
            },
          ],
        ),
        params: requestSchema(CategoryParamsSchema),
        response: {
          200: { description: 'The matched category.', ...responseSchema(CategorySchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { category } = request.params as z.infer<typeof CategoryParamsSchema>;
      return app.substack.discovery.findCategory(category, { cookie: request.substackCookie });
    },
  );

  app.get(
    '/discovery/categories/:category/leaderboard',
    {
      schema: {
        tags: ['discovery'],
        summary: 'Leaderboard for a category',
        description: describeRoute(
          'The entry point for finding publications adjacent to your own niche: pick your category (or a ' +
            "close subcategory), page through its leaderboard, and cross-reference the results against " +
            "your own readers' other subscriptions. `:category` accepts an id, slug, or name. `type` is " +
            'accepted for forward compatibility but has been verified to have no effect upstream as of this ' +
            'writing — see `src/schemas/discovery.ts` for how that was confirmed. Upstream page size is a ' +
            'fixed 25 regardless of any `limit`. For bounded multi-page collection, use `substack-api collect` ' +
            'with this route or the typed client\'s `discovery.leaderboardAll()` helper.',
          [
            {
              title: 'Top of the Technology leaderboard',
              curl:
                'curl -s "http://127.0.0.1:3000/discovery/categories/technology/leaderboard?page=0" ' +
                "| jq '.title, (.publications | length)'",
              ts: "const page = await substack.discovery.leaderboard('technology', { page: 0 });",
              upstream: 'GET https://substack.com/api/v1/category/public/{id}/all?page=0',
            },
          ],
        ),
        params: requestSchema(CategoryParamsSchema),
        querystring: requestSchema(LeaderboardQuerySchema),
        response: {
          200: { description: 'One page of the leaderboard.', ...responseSchema(LeaderboardPageSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { category } = request.params as z.infer<typeof CategoryParamsSchema>;
      const { page, type } = request.query as z.infer<typeof LeaderboardQuerySchema>;
      return app.substack.discovery.leaderboard(category, { page, type }, { cookie: request.substackCookie });
    },
  );
}
