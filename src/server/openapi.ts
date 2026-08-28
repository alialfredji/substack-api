/**
 * Zod -> OpenAPI glue, plus helpers for writing route documentation.
 *
 * One non-obvious thing worth knowing: when a Fastify route declares a response
 * schema, Fastify serialises the reply with fast-json-stringify, which *drops*
 * any property the schema does not mention. Our schemas are deliberately loose
 * because Substack returns fields we have not catalogued, so a naive conversion
 * would silently delete real data on its way out the door.
 *
 * {@link relaxAdditionalProperties} therefore forces `additionalProperties: true`
 * on every object in a generated response schema. Docs stay accurate about the
 * fields we know, and unknown fields still reach the caller.
 */

import { z, type ZodType } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

/**
 * Recursively prepare a generated schema for Fastify:
 *
 *  - Drop `$schema`. Fastify's ajv instance rejects it inside a route schema.
 *  - Optionally force `additionalProperties: true`, so the reply serialiser
 *    passes through the fields our loose schemas do not enumerate.
 */
function normalize(node: unknown, relax: boolean): unknown {
  if (Array.isArray(node)) return node.map((child) => normalize(child, relax));
  if (node === null || typeof node !== 'object') return node;

  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node as JsonSchemaNode)) {
    if (key === '$schema') continue;
    out[key] = normalize(value, relax);
  }
  if (relax && (out['type'] === 'object' || out['properties'] !== undefined)) {
    out['additionalProperties'] = true;
  }
  return out;
}

/**
 * Convert a Zod schema to an OpenAPI 3.0 schema object.
 *
 * @param schema The Zod schema.
 * @param io     `'output'` (default) describes what we send back;
 *               `'input'` describes what we accept, honouring defaults.
 * @param relax  Force `additionalProperties: true`. Defaults to true for
 *               response schemas; pass false for request schemas where you
 *               actually want unknown params rejected.
 */
export function toOpenApi(
  schema: ZodType,
  io: 'input' | 'output' = 'output',
  relax = true,
): JsonSchemaNode {
  const generated = z.toJSONSchema(schema, {
    // draft-2020-12 rather than openapi-3.0, deliberately. The 3.0 target emits
    // draft-4 style numeric bounds — `{minimum: 0, exclusiveMinimum: true}` —
    // and Fastify's ajv refuses to compile that ("exclusiveMinimum must be
    // number"), so any route using `.positive()` or `.min()` fails at boot.
    // 2020-12 emits `{exclusiveMinimum: 0}`, which ajv accepts, and it is also
    // precisely the dialect OpenAPI 3.1 uses — so the served document and the
    // request validator agree instead of quietly diverging.
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as JsonSchemaNode;
  return normalize(generated, relax) as JsonSchemaNode;
}

/** Shorthand for a request (querystring / params) schema. Rejects nothing extra. */
export function requestSchema(schema: ZodType): JsonSchemaNode {
  return toOpenApi(schema, 'input', false);
}

/** Shorthand for a response schema that preserves unknown upstream fields. */
export function responseSchema(schema: ZodType): JsonSchemaNode {
  return toOpenApi(schema, 'output', true);
}

export interface RouteExample {
  /** Short label, e.g. "Fetch a profile by handle". */
  title: string;
  /** A runnable curl one-liner against the local gateway. */
  curl: string;
  /** The equivalent call using the TypeScript client. */
  ts?: string;
  /** The upstream Substack endpoint this proxies, for transparency. */
  upstream?: string;
}

/**
 * Build a Markdown route description with runnable examples.
 *
 * Swagger UI renders Markdown in `description`, so this is what makes the
 * examples visible and copy-pasteable in the browser rather than buried in a
 * README nobody opens.
 */
export function describeRoute(summary: string, examples: RouteExample[] = [], notes?: string): string {
  const parts: string[] = [summary];

  if (notes) parts.push('', notes);

  for (const example of examples) {
    parts.push('', `**${example.title}**`);
    if (example.upstream) parts.push('', `Upstream: \`${example.upstream}\``);
    parts.push('', '```bash', example.curl.trim(), '```');
    if (example.ts) parts.push('', '```ts', example.ts.trim(), '```');
  }

  return parts.join('\n');
}

/** Standard error response body, shared by every route. */
export const ErrorResponseSchema = z.object({
  error: z.string().describe('Error class name, e.g. SubstackHttpError.'),
  message: z.string().describe('Human-readable description.'),
  statusCode: z.number().describe('HTTP status returned by this gateway.'),
  upstreamStatus: z.number().nullish().describe('Status Substack returned, when relevant.'),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Reusable `response` block for the error cases every route can produce. */
export const commonErrorResponses = {
  400: { description: 'Invalid request parameters.', ...responseSchema(ErrorResponseSchema) },
  404: { description: 'Substack has no such resource.', ...responseSchema(ErrorResponseSchema) },
  502: { description: 'Substack returned an unexpected response.', ...responseSchema(ErrorResponseSchema) },
} as const;

/** OpenAPI tag definitions. Keep in sync with the tags used on routes. */
export const OPENAPI_TAGS = [
  {
    name: 'profiles',
    description:
      'People. Fetch profiles, their public subscriber/follower/following lists, or search by keyword. ' +
      'Profile objects include public `subscriptions[]`, so one call gives you both a person and their subscription graph.',
  },
  {
    name: 'notes',
    description:
      'Substack Notes. Per-profile note feeds, the suggested-notes feed, single-note lookup, and — the most useful ' +
      'endpoint here — the list of accounts that liked a note, each carrying `is_subscribed` and `is_following`.',
  },
  {
    name: 'publications',
    description:
      'Newsletters. Keyword search, post archive, individual posts, post comments, and the recommendation graph ' +
      '(which publications a given publication recommends).',
  },
  {
    name: 'discovery',
    description:
      'Category taxonomy and per-category leaderboards. The entry point for finding publications adjacent to yours.',
  },
  { name: 'meta', description: 'Health, configuration, and the raw OpenAPI document.' },
] as const;
