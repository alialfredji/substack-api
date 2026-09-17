import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('engagement OpenAPI routes', () => {
  it('publishes every new endpoint in the generated specification', () => {
    const spec = app.swagger() as { paths?: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    expect(paths).toEqual(
      expect.arrayContaining([
        '/notes/{noteId}/restackers',
        '/notes/{noteId}/replies',
        '/publications/{subdomain}/posts/{postId}/facepile',
        '/publications/{subdomain}/posts/{postId}/reactors',
        '/publications/{subdomain}/posts/{postId}/restackers',
        '/publications/{subdomain}/posts/{postId}/replies',
      ]),
    );
  });
});
