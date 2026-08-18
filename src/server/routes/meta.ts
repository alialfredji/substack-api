/**
 * Health, effective configuration, and the raw OpenAPI document.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRoute, responseSchema } from '../openapi.js';

const HealthSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
  node: z.string(),
});

const ConfigSchema = z.object({
  cookieConfigured: z
    .boolean()
    .describe('Whether the server has a default cookie. The value itself is never exposed.'),
  concurrency: z.number().describe('Max simultaneous upstream requests.'),
  minDelayMs: z.number().describe('Minimum gap between upstream request starts.'),
  timeoutMs: z.number(),
  retries: z.number(),
  validate: z.string().describe('Schema validation mode: lenient | strict | off.'),
  baseUrl: z.string(),
});

export default async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: 'Liveness check',
        description: describeRoute('Returns ok if the process is up.', [
          { title: 'Check health', curl: 'curl -s http://127.0.0.1:3000/health | jq' },
        ]),
        response: { 200: { description: 'Healthy.', ...responseSchema(HealthSchema) } },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    }),
  );

  app.get(
    '/config',
    {
      schema: {
        tags: ['meta'],
        summary: 'Effective configuration',
        description: describeRoute(
          'Shows the resolved client settings so you can confirm whether a cookie was picked up. The cookie value is never returned.',
          [{ title: 'Inspect config', curl: 'curl -s http://127.0.0.1:3000/config | jq' }],
        ),
        response: { 200: { description: 'Current settings.', ...responseSchema(ConfigSchema) } },
      },
    },
    async () => {
      const c = app.substack.http.config;
      return {
        cookieConfigured: c.cookie !== null,
        concurrency: c.concurrency,
        minDelayMs: c.minDelayMs,
        timeoutMs: c.timeoutMs,
        retries: c.retries,
        validate: c.validate,
        baseUrl: c.baseUrl,
      };
    },
  );

  app.get(
    '/openapi.json',
    {
      schema: {
        tags: ['meta'],
        summary: 'OpenAPI document',
        description: describeRoute(
          'The full OpenAPI 3.0 spec for this gateway. Feed it to a codegen tool or an agent that needs a machine-readable route list.',
          [
            {
              title: 'Save the spec',
              curl: 'curl -s http://127.0.0.1:3000/openapi.json -o openapi.json',
            },
          ],
        ),
      },
    },
    async () => app.swagger(),
  );
}
