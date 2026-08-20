/**
 * Substack Notes routes: profile/suggested feeds, single-note lookup, and
 * the reactors endpoint — including the "liked but never subscribed" filter,
 * which is why this route group carries the only `security` requirement in
 * the notes surface.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRoute, requestSchema, responseSchema, commonErrorResponses } from '../openapi.js';
import {
  NoteFeedPageSchema,
  NoteFeedItemSchema,
  ReactorListSchema,
  NoteContextUserSchema,
} from '../../schemas/note.js';

/** Valid `types[]` values, per live verification against the profile feed endpoint. */
const NOTE_FEED_TYPES_NOTE = 'note, comment, post, like, restack';

/** Split a comma-separated `types` query param into the array the client expects. */
function parseTypes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

const FeedQuerySchema = z.object({
  cursor: z.string().optional().describe('`nextCursor` from a previous response. Omit for the first page.'),
  types: z
    .string()
    .optional()
    .describe(`Comma-separated feed item types, e.g. "note,like". Valid values: ${NOTE_FEED_TYPES_NOTE}. Defaults to note.`),
});

const ProfileParamsSchema = z.object({
  userId: z.coerce.number().int().positive().describe('Numeric Substack user id, e.g. 86433889.'),
});

const NoteParamsSchema = z.object({
  noteId: z.coerce.number().int().positive().describe('Numeric note id, e.g. 314595743.'),
});

const ReactorsQuerySchema = z.object({
  unsubscribedOnly: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .describe(
      'When "true", return only reactors with is_subscribed === false. Requires a cookie ' +
        '(server-configured or via x-substack-cookie) — without one every reactor reads ' +
        'is_subscribed: false and this filter would silently return a worthless "everyone" list, ' +
        'so the gateway 401s instead.',
    ),
});

export default async function noteRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { userId: string }; Querystring: { cursor?: string; types?: string } }>(
    '/notes/profile/:userId',
    {
      schema: {
        tags: ['notes'],
        summary: "A profile's note feed",
        params: requestSchema(ProfileParamsSchema),
        querystring: requestSchema(FeedQuerySchema),
        description: describeRoute(
          "A profile's own notes, or (via `types`) their likes/restacks/comments/posts activity. " +
            'Cursor-paginated: pass the previous response\'s `nextCursor` back as `cursor` to advance.',
          [
            {
              title: "Fetch a profile's notes",
              curl: 'curl -s "http://127.0.0.1:3000/notes/profile/86433889" | jq',
              ts: `const page = await substack.notes.listByProfile(86433889);\nconsole.log(page.items.length, page.nextCursor);`,
              upstream: 'GET /api/v1/reader/feed/profile/{userId}?types[]=note',
            },
            {
              title: 'Fetch likes instead of notes, and advance a cursor',
              curl: 'curl -s "http://127.0.0.1:3000/notes/profile/86433889?types=like&cursor=<nextCursor>" | jq',
              ts: `const page = await substack.notes.listByProfile(86433889, { types: ['like'] });`,
            },
          ],
          'The upstream `comment` type is valid but often returns 0 items — that means the account ' +
            'has no post comments, not an error. For bounded cursor traversal, use `substack-api collect` ' +
            'with this route or the typed client\'s `notes.collectProfileNotes()` helper.',
        ),
        response: {
          200: { description: 'A page of feed items.', ...responseSchema(NoteFeedPageSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const userId = Number(request.params.userId);
      const { cursor, types } = request.query;
      return app.substack.notes.listByProfile(
        userId,
        { cursor, types: parseTypes(types) },
        { cookie: request.substackCookie },
      );
    },
  );

  app.get<{ Querystring: { cursor?: string; types?: string } }>(
    '/notes/suggested',
    {
      schema: {
        tags: ['notes'],
        summary: 'Suggested notes feed',
        querystring: requestSchema(FeedQuerySchema),
        description: describeRoute(
          'The cold-start suggested-notes feed. Anonymous calls return generic suggestions; a cookie ' +
            "reflects the account's actual reading graph. Same envelope as the profile feed, plus a " +
            'populated `trackingParameters` block.',
          [
            {
              title: 'Fetch suggested notes',
              curl: 'curl -s "http://127.0.0.1:3000/notes/suggested" | jq',
              ts: `const page = await substack.notes.listSuggested();\nconsole.log(page.items.length);`,
              upstream: 'GET /api/v1/reader/feed?types[]=note',
            },
          ],
          'For bounded cursor traversal, use `substack-api collect \'/notes/suggested\'` or the typed ' +
            'client\'s `notes.collectSuggestedNotes()` helper.',
        ),
        response: {
          200: { description: 'A page of feed items.', ...responseSchema(NoteFeedPageSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { cursor, types } = request.query;
      return app.substack.notes.listSuggested({ cursor, types: parseTypes(types) }, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { noteId: string } }>(
    '/notes/:noteId',
    {
      schema: {
        tags: ['notes'],
        summary: 'Fetch a single note',
        params: requestSchema(NoteParamsSchema),
        description: describeRoute('Look up one note by id. Same item shape as a feed entry, unwrapped from the upstream `{ item }` envelope.', [
          {
            title: 'Fetch a note',
            curl: 'curl -s "http://127.0.0.1:3000/notes/314595743" | jq',
            ts: `const note = await substack.notes.get(314595743);\nconsole.log(note.comment?.body);`,
            upstream: 'GET /api/v1/reader/comment/{noteId}',
          },
        ]),
        response: {
          200: { description: 'The note.', ...responseSchema(NoteFeedItemSchema) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const noteId = Number(request.params.noteId);
      return app.substack.notes.get(noteId, { cookie: request.substackCookie });
    },
  );

  app.get<{ Params: { noteId: string }; Querystring: { unsubscribedOnly?: 'true' | 'false' } }>(
    '/notes/:noteId/reactors',
    {
      schema: {
        tags: ['notes'],
        summary: 'Who reacted to a note',
        security: [{ substackCookie: [] }],
        params: requestSchema(NoteParamsSchema),
        querystring: requestSchema(ReactorsQuerySchema),
        description: describeRoute(
          'Every account that reacted (liked) a note. There is no working pagination on this upstream ' +
            'endpoint — `limit`/`offset`/`page` were all tried live and had no effect, so this always ' +
            "returns the endpoint's full list in one call.\n\n" +
            '**Without a cookie**, `is_subscribed` and `is_following` read `false` for every reactor — ' +
            'they are viewer-relative fields Substack only resolves for an authenticated caller. ' +
            '`unsubscribedOnly=true` therefore requires a cookie (server-configured, or per-request via ' +
            '`x-substack-cookie`) and the gateway responds `401` if none is available, rather than ' +
            'silently returning a list that "looks" like unsubscribed reactors but is really just everyone.',
          [
            {
              title: 'List all reactors',
              curl: 'curl -s "http://127.0.0.1:3000/notes/314595743/reactors" | jq',
              ts: `const reactors = await substack.notes.reactors(314595743);\nconsole.log(reactors.length);`,
              upstream: 'GET /api/v1/comment/{noteId}/reactors',
            },
            {
              title: 'Reactors who liked but never subscribed (requires a cookie)',
              curl:
                'curl -s "http://127.0.0.1:3000/notes/314595743/reactors?unsubscribedOnly=true" ' +
                '-H "x-substack-cookie: $SUBSTACK_COOKIE" | jq',
              ts: `const cold = await substack.notes.unsubscribedReactors(314595743);\nconsole.log(cold.map((r) => r.name));`,
            },
          ],
        ),
        response: {
          200: { description: 'Reactors.', ...responseSchema(ReactorListSchema) },
          401: { ...commonErrorResponses[400], description: 'unsubscribedOnly requested with no cookie available.' },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const noteId = Number(request.params.noteId);
      const opts = { cookie: request.substackCookie };
      return request.query.unsubscribedOnly === 'true'
        ? app.substack.notes.unsubscribedReactors(noteId, opts)
        : app.substack.notes.reactors(noteId, opts);
    },
  );

  app.get<{ Params: { userId: string }; Querystring: { cursor?: string; types?: string } }>(
    '/notes/profile/:userId/context-users',
    {
      schema: {
        tags: ['notes'],
        summary: 'People attributed as "why this surfaced" on a note feed page',
        params: requestSchema(ProfileParamsSchema),
        querystring: requestSchema(FeedQuerySchema),
        description: describeRoute(
          "Fetches one page of a profile's note feed and returns the deduped set of accounts found in " +
            'each item\'s `context.users` — the "suggested by" / "connective people" signal. In testing ' +
            "this was consistently empty on a profile's *own* feed (context users showed up on the " +
            'suggested feed instead); this endpoint exists for when a future account or feed variant does ' +
            'populate it, and the response will simply be an empty array otherwise.',
          [
            {
              title: 'Context users for a profile feed page',
              curl: 'curl -s "http://127.0.0.1:3000/notes/profile/86433889/context-users" | jq',
              ts: `const page = await substack.notes.listByProfile(86433889);\nconst people = substack.notes.contextUsers(page);`,
            },
          ],
        ),
        response: {
          200: { description: 'Deduped context users.', ...responseSchema(z.array(NoteContextUserSchema)) },
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const userId = Number(request.params.userId);
      const { cursor, types } = request.query;
      const page = await app.substack.notes.listByProfile(
        userId,
        { cursor, types: parseTypes(types) },
        { cookie: request.substackCookie },
      );
      return app.substack.notes.contextUsers(page);
    },
  );
}
