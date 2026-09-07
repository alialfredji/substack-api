import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server/app.js';

describe('MCP server', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('advertises four read-only tools and calls list_routes over streamable HTTP', async () => {
    const app = await buildApp({ logger: false });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'substack-api-test', version: '1.0.0' });
    cleanups.push(async () => client.close(), async () => app.close());

    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'list_routes',
      'describe_route',
      'call_route',
      'collect_route',
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(
      Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.annotations?.openWorldHint])),
    ).toEqual({
      list_routes: false,
      describe_route: false,
      call_route: true,
      collect_route: true,
    });

    const result = await client.callTool({ name: 'list_routes', arguments: { filter: 'profiles' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ result: expect.any(Array) });
  });
});
