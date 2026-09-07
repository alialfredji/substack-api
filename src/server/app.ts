/**
 * The Fastify application: a documented REST gateway in front of the client,
 * with Swagger UI at `/docs` so every route is browsable and testable.
 *
 * Cookie handling here is per-request. The gateway holds one client built from
 * the environment, and any caller can override the cookie for a single call by
 * sending an `x-substack-cookie` header. That means you can run the server with
 * no cookie at all and still get authenticated results when you want them.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { createSubstackClient, type SubstackClient } from '../client/client.js';
import type { SubstackClientConfig } from '../client/config.js';
import {
  SubstackAuthRequiredError,
  SubstackHttpError,
  SubstackParseError,
  SubstackTimeoutError,
  SubstackValidationError,
} from '../client/errors.js';
import { OPENAPI_TAGS } from './openapi.js';

import profileRoutes from './routes/profiles.js';
import noteRoutes from './routes/notes.js';
import publicationRoutes from './routes/publications.js';
import discoveryRoutes from './routes/discovery.js';
import metaRoutes from './routes/meta.js';
import { registerMcpRoute } from '../mcp/server.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared Substack client, built from environment configuration. */
    substack: SubstackClient;
  }
  interface FastifyRequest {
    /**
     * Cookie for this request only.
     *   - `undefined` -> fall back to the server's configured cookie
     *   - a string    -> use it for this request
     *   - `null`      -> explicitly send no cookie
     */
    substackCookie: string | null | undefined;
  }
}

export interface BuildAppOptions {
  /** Overrides passed through to the Substack client. */
  client?: SubstackClientConfig;
  /** Fastify logger. Defaults to pretty-ish info logging, `false` in tests. */
  logger?: boolean;
  /** Advertised server URL in the OpenAPI document. */
  publicUrl?: string;
}

const DESCRIPTION = `
A typed client and REST gateway over Substack's **public, undocumented** API.

### What this is for

Read-only discovery. Finding people and publications, and understanding who
engages with what. Every route here is a \`GET\`.

### What this deliberately does not do

There are no write endpoints — no subscribing, following, liking, or commenting.
Those are left to be performed as ordinary human interaction in a real browser.
Automating them means sending your session cookie at machine speed to endpoints
Substack's \`robots.txt\` explicitly disallows, which is the behaviour that gets
accounts terminated.

### Authentication is optional

Every route works with no cookie. A cookie only upgrades *viewer-relative*
fields — chiefly \`is_subscribed\` and \`is_following\` on note reactors, which
read \`false\` for everyone when anonymous. Supply one per request via the
\`x-substack-cookie\` header, or set \`SUBSTACK_COOKIE\` for the whole server.

### Politeness

Requests are pooled at a bounded concurrency (default 4) with optional pacing.
Substack publishes no rate limits and did not throttle 600 concurrent reads in
testing, but that is not licence to hammer it.
`.trim();

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    // Substack ids are large but safe integers; keep default JSON parsing.
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false } },
  });

  app.decorate('substack', createSubstackClient(options.client ?? {}));
  app.decorateRequest('substackCookie', undefined);
  app.addHook('onClose', async () => app.substack.close());

  // Lift the per-request cookie override off the header exactly once.
  app.addHook('onRequest', async (request) => {
    const header = request.headers['x-substack-cookie'];
    const value = Array.isArray(header) ? header[0] : header;
    if (value === undefined) {
      request.substackCookie = undefined;
    } else if (value.trim() === '' || value.trim().toLowerCase() === 'none') {
      request.substackCookie = null;
    } else {
      request.substackCookie = value.trim();
    }
  });

  await app.register(cors, { origin: true, exposedHeaders: ['x-substack-authenticated'] });

  await app.register(swagger, {
    openapi: {
      // 3.1, because its schema dialect *is* JSON Schema 2020-12 — the same
      // dialect toOpenApi() emits and Fastify's ajv validates against.
      openapi: '3.1.0',
      info: {
        title: 'Substack Public API Gateway',
        description: DESCRIPTION,
        version: '0.1.0',
      },
      servers: [{ url: options.publicUrl ?? 'http://127.0.0.1:3000', description: 'Local' }],
      tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
      components: {
        securitySchemes: {
          substackCookie: {
            type: 'apiKey',
            in: 'header',
            name: 'x-substack-cookie',
            description:
              'Optional. Your `substack.sid` value, or a full cookie header. ' +
              'Only needed for viewer-relative fields such as `is_subscribed`. ' +
              'Send `none` to force an anonymous call when the server has a cookie configured.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, displayRequestDuration: true },
    staticCSP: true,
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    // Fastify 5 hands the handler an `unknown`. Narrow once, here, rather than
    // casting at each of the half-dozen use sites below.
    const error = rawError as Error & { statusCode?: number };

    const send = (statusCode: number, upstreamStatus?: number | null): void => {
      request.log.warn({ err: error, url: request.url }, 'request failed');
      void reply.status(statusCode).send({
        error: error.name || 'Error',
        message: error.message,
        statusCode,
        upstreamStatus: upstreamStatus ?? null,
      });
    };

    if (error instanceof SubstackHttpError) {
      // A 404 from Substack is a real 404 for us. Everything else upstream is a
      // bad gateway, because the fault is not the caller's.
      if (error.isNotFound) return send(404, error.status);
      if (error.isRateLimited) return send(429, error.status);
      return send(502, error.status);
    }
    if (error instanceof SubstackParseError) return send(502);
    if (error instanceof SubstackValidationError) return send(502);
    if (error instanceof SubstackTimeoutError) return send(504);
    if (error instanceof SubstackAuthRequiredError) return send(401);
    if (typeof error.statusCode === 'number') return send(error.statusCode);
    return send(500);
  });

  await app.register(metaRoutes);
  await app.register(profileRoutes);
  await app.register(noteRoutes);
  await app.register(publicationRoutes);
  await app.register(discoveryRoutes);
  await registerMcpRoute(app);

  return app;
}
