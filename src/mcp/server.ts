import { createMcpHandler, McpServer, type JSONValue } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { collectRoute } from '../cli/collect.js';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const OPEN_WORLD_READ_ONLY_ANNOTATIONS = {
  ...READ_ONLY_ANNOTATIONS,
  openWorldHint: true,
} as const;
const OutputSchema = z.object({ result: z.unknown() });

function jsonResult(result: unknown) {
  const safeResult = JSON.parse(JSON.stringify(result)) as JSONValue;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(safeResult) }],
    structuredContent: { result: safeResult },
  };
}

function routePattern(pathTemplate: string): RegExp {
  const escaped = pathTemplate
    .split('/')
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}$`);
}

function documentedGetRoute(spec: OpenApiDocument, target: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(target, 'http://127.0.0.1').pathname;
  } catch {
    return undefined;
  }
  return Object.entries(spec.paths ?? {}).find(
    ([template, item]) => item.get && routePattern(template).test(pathname),
  )?.[0];
}

function createServer(app: FastifyInstance): McpServer {
  const server = new McpServer({ name: 'substack-api', version: '0.2.2' });

  server.registerTool(
    'list_routes',
    {
      title: 'List Substack API routes',
      description: 'List the read-only Substack routes available through this plugin.',
      inputSchema: z.object({
        filter: z.string().optional().describe('Optional case-insensitive route or topic filter.'),
      }),
      outputSchema: OutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ filter }) => {
      const spec = app.swagger() as OpenApiDocument;
      const routes = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
        HTTP_METHODS.flatMap((method) => {
          const operation = item[method];
          if (!operation) return [];
          return [{ method: method.toUpperCase(), path, tags: operation.tags ?? [], summary: operation.summary ?? '' }];
        }),
      );
      const normalized = filter?.toLowerCase();
      return jsonResult(
        normalized
          ? routes.filter((route) => JSON.stringify(route).toLowerCase().includes(normalized))
          : routes,
      );
    },
  );

  server.registerTool(
    'describe_route',
    {
      title: 'Describe a Substack API route',
      description: 'Return the input parameters, response schemas, and documentation for one route template.',
      inputSchema: z.object({ pathTemplate: z.string().startsWith('/') }),
      outputSchema: OutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ pathTemplate }) => {
      const spec = app.swagger() as OpenApiDocument;
      const route = spec.paths?.[pathTemplate];
      if (!route) throw new Error(`Unknown path template: ${pathTemplate}`);
      return jsonResult({ path: pathTemplate, ...route });
    },
  );

  server.registerTool(
    'call_route',
    {
      title: 'Call a Substack API route',
      description: 'Call one documented read-only route and return its JSON response.',
      inputSchema: z.object({
        path: z.string().startsWith('/').describe('Concrete path with optional query string.'),
      }),
      outputSchema: OutputSchema,
      annotations: OPEN_WORLD_READ_ONLY_ANNOTATIONS,
    },
    async ({ path }) => {
      const spec = app.swagger() as OpenApiDocument;
      if (!documentedGetRoute(spec, path)) throw new Error(`No documented GET route matches: ${path}`);
      const response = await app.inject({ method: 'GET', url: path, headers: { 'x-substack-cookie': 'none' } });
      const payload = JSON.parse(response.payload) as unknown;
      if (response.statusCode >= 400) {
        throw new Error(`Substack API request failed (HTTP ${response.statusCode}): ${response.payload.slice(0, 500)}`);
      }
      return jsonResult(payload);
    },
  );

  server.registerTool(
    'collect_route',
    {
      title: 'Collect paginated Substack results',
      description: 'Collect multiple pages from a supported read-only route with explicit safety bounds.',
      inputSchema: z.object({
        path: z.string().startsWith('/').describe('Concrete paginated path with optional query string.'),
        limit: z.number().int().min(1).max(100).default(100),
        maxPages: z.number().int().min(1).max(20).default(20),
      }),
      outputSchema: OutputSchema,
      annotations: OPEN_WORLD_READ_ONLY_ANNOTATIONS,
    },
    async ({ path, limit, maxPages }) => {
      const spec = app.swagger() as OpenApiDocument;
      if (!documentedGetRoute(spec, path)) throw new Error(`No documented GET route matches: ${path}`);
      const result = await collectRoute({
        target: path,
        limit,
        maxPages,
        request: async (url) => {
          const response = await app.inject({
            method: 'GET',
            url,
            headers: { 'x-substack-cookie': 'none' },
          });
          return { statusCode: response.statusCode, payload: response.payload };
        },
      });
      return jsonResult(result);
    },
  );

  return server;
}

export function createSubstackMcpHandler(app: FastifyInstance) {
  return createMcpHandler(() => createServer(app));
}

export async function registerMcpRoute(app: FastifyInstance): Promise<void> {
  const handler = createSubstackMcpHandler(app);
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => app.log.error(error) });

  app.addHook('onClose', async () => handler.close());
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      reply.hijack();
      await nodeHandler(request.raw, reply.raw, request.body);
    },
  });
}
