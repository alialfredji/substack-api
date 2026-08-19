#!/usr/bin/env node

import 'dotenv/config';
import { buildApp } from './server/app.js';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

interface RouteSummary {
  method: string;
  path: string;
  tags: string[];
  summary: string;
  parameters: Array<{
    name: string;
    in: string;
    required: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

function usage(): string {
  return `Usage:
  substack-api routes [filter] [--pretty]
  substack-api describe <path-template> [--pretty]
  substack-api call <concrete-path-and-query> [--anonymous] [--pretty]

Examples:
  substack-api routes profiles
  substack-api describe '/profiles/{handle}'
  substack-api call '/profiles/alialfredji'
  substack-api call '/profiles/search?query=ai&page=0' --pretty

Authentication:
  Set SUBSTACK_COOKIE in the environment. Use --anonymous to override it for one call.`;
}

function writeJson(value: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: 'SubstackCliError', message })}\n`);
  process.exitCode = 2;
  throw new Error(message);
}

function parseFlags(args: string[]): {
  positional: string[];
  pretty: boolean;
  anonymous: boolean;
} {
  const positional: string[] = [];
  let pretty = false;
  let anonymous = false;

  for (const arg of args) {
    if (arg === '--pretty') {
      pretty = true;
    } else if (arg === '--anonymous') {
      anonymous = true;
    } else if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, pretty, anonymous };
}

function listRoutes(spec: OpenApiDocument): RouteSummary[] {
  const routes: RouteSummary[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      routes.push({
        method: method.toUpperCase(),
        path,
        tags: operation.tags ?? [],
        summary: operation.summary ?? '',
        parameters: (operation.parameters ?? []).map((parameter) => ({
          name: parameter.name ?? '',
          in: parameter.in ?? '',
          required: parameter.required ?? false,
          ...(parameter.description ? { description: parameter.description } : {}),
          ...(parameter.schema ? { schema: parameter.schema } : {}),
        })),
      });
    }
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
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

function findConcreteRoute(routes: RouteSummary[], target: string): RouteSummary | undefined {
  let pathname: string;
  try {
    pathname = new URL(target, 'http://127.0.0.1').pathname;
  } catch {
    return undefined;
  }
  return routes.find((route) => route.method === 'GET' && routePattern(route.path).test(pathname));
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { positional, pretty, anonymous } = parseFlags(rawArgs);
  const app = await buildApp({ logger: false });

  try {
    await app.ready();
    const spec = app.swagger() as OpenApiDocument;
    const routes = listRoutes(spec);

    if (command === 'routes') {
      if (anonymous) fail('--anonymous is only valid with call');
      if (positional.length > 1) fail('routes accepts at most one filter');
      const filter = positional[0]?.toLowerCase();
      writeJson(
        filter
          ? routes.filter((route) =>
              `${route.method} ${route.path} ${route.tags.join(' ')} ${route.summary}`
                .toLowerCase()
                .includes(filter),
            )
          : routes,
        pretty,
      );
      return;
    }

    if (command === 'describe') {
      if (anonymous) fail('--anonymous is only valid with call');
      if (positional.length !== 1) fail('describe requires exactly one OpenAPI path template');
      const path = positional[0] as string;
      const pathItem = spec.paths?.[path];
      if (!pathItem) fail(`Unknown path template: ${path}`);
      writeJson({ path, ...pathItem }, pretty);
      return;
    }

    if (command === 'call') {
      if (positional.length !== 1) fail('call requires exactly one concrete path and optional query');
      const target = positional[0] as string;
      if (!target.startsWith('/')) fail('call target must start with /');
      if (!findConcreteRoute(routes, target)) {
        fail(`No documented GET route matches: ${target}`);
      }

      const response = await app.inject({
        method: 'GET',
        url: target,
        ...(anonymous ? { headers: { 'x-substack-cookie': 'none' } } : {}),
      });

      let payload: unknown;
      try {
        payload = JSON.parse(response.payload);
      } catch {
        payload = {
          statusCode: response.statusCode,
          contentType: response.headers['content-type'] ?? null,
          body: response.payload,
        };
      }

      writeJson(payload, pretty);
      if (response.statusCode >= 400) process.exitCode = 1;
      return;
    }

    fail(`Unknown command: ${command}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (process.exitCode === undefined) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: 'SubstackCliError', message })}\n`);
    process.exitCode = 1;
  }
});
