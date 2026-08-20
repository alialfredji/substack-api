import { describe, expect, it } from 'vitest';
import { collectRoute } from '../src/cli/collect.js';

function responder(
  handler: (url: URL, call: number) => unknown,
): {
  calls: URL[];
  request: (target: string) => Promise<{ statusCode: number; payload: string }>;
} {
  const calls: URL[] = [];
  return {
    calls,
    request: async (target) => {
      const url = new URL(target, 'http://localhost');
      calls.push(url);
      return { statusCode: 200, payload: JSON.stringify(handler(url, calls.length)) };
    },
  };
}

describe('collectRoute', () => {
  it('walks profile search pages and returns a stable envelope', async () => {
    const fake = responder((url) => {
      const page = Number(url.searchParams.get('page'));
      return page === 0
        ? { results: [{ id: 1 }, { id: 2 }], more: true }
        : { results: [{ id: 3 }], more: false };
    });

    const result = await collectRoute({
      target: '/profiles/search?query=ai',
      limit: 100,
      maxPages: 10,
      request: fake.request,
    });

    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 3,
      pagesFetched: 2,
      exhausted: true,
      continuation: null,
    });
    expect(fake.calls.map((url) => url.searchParams.get('page'))).toEqual(['0', '1']);
  });

  it('deduplicates publication search results by id', async () => {
    const fake = responder((url) =>
      url.searchParams.get('page') === '0'
        ? { results: [{ id: 1 }, { id: 2 }], more: true }
        : { results: [{ id: 2 }, { id: 3 }], more: false },
    );

    const result = await collectRoute({
      target: '/publications/search?query=ai',
      limit: 100,
      maxPages: 10,
      request: fake.request,
    });

    expect(result.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(result.count).toBe(3);
  });

  it('retries a degraded publication search response once', async () => {
    const fake = responder((_url, call) =>
      call === 1 ? { results: [] } : { results: [{ id: 1 }], more: false },
    );

    const result = await collectRoute({
      target: '/publications/search?query=ai',
      limit: 10,
      maxPages: 2,
      request: fake.request,
    });

    expect(fake.calls).toHaveLength(2);
    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.pagesFetched).toBe(1);
  });

  it('fails clearly when publication search remains degraded', async () => {
    const fake = responder(() => ({ results: [] }));

    await expect(
      collectRoute({
        target: '/publications/search?query=ai',
        limit: 10,
        maxPages: 2,
        request: fake.request,
      }),
    ).rejects.toThrow(/throttling.*inconclusive/i);
    expect(fake.calls).toHaveLength(2);
  });

  it('walks cursor-paginated notes and preserves existing query parameters', async () => {
    const fake = responder((url) => {
      const cursor = url.searchParams.get('cursor');
      return cursor === null
        ? { items: [{ entity_key: 'c-1' }], nextCursor: 'next-token' }
        : { items: [{ entity_key: 'c-2' }], nextCursor: null };
    });

    const result = await collectRoute({
      target: '/notes/profile/42?types=note,like',
      limit: 10,
      maxPages: 3,
      request: fake.request,
    });

    expect(result.items).toEqual([{ entity_key: 'c-1' }, { entity_key: 'c-2' }]);
    expect(fake.calls[1]!.searchParams.get('cursor')).toBe('next-token');
    expect(fake.calls[1]!.searchParams.get('types')).toBe('note,like');
  });

  it('uses offset and a bounded request size for publication archives', async () => {
    const fake = responder((url) => {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Array.from({ length: limit }, (_, index) => ({ id: offset + index }));
    });

    const result = await collectRoute({
      target: '/publications/example/archive?sort=new',
      limit: 60,
      maxPages: 5,
      request: fake.request,
    });

    expect(result.count).toBe(60);
    expect(result.exhausted).toBe(false);
    expect(result.continuation).toEqual({ parameter: 'offset', value: 60 });
    expect(fake.calls.map((url) => [url.searchParams.get('offset'), url.searchParams.get('limit')])).toEqual([
      ['0', '50'],
      ['50', '10'],
    ]);
  });

  it('walks category leaderboards and reports a continuation when max-pages stops it', async () => {
    const fake = responder((url) => ({
      publications: [{ id: Number(url.searchParams.get('page')) + 1 }],
      more: true,
    }));

    const result = await collectRoute({
      target: '/discovery/categories/technology/leaderboard',
      limit: 10,
      maxPages: 2,
      request: fake.request,
    });

    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      count: 2,
      pagesFetched: 2,
      exhausted: false,
      continuation: { parameter: 'page', value: 2 },
    });
  });

  it('rejects unsupported routes instead of guessing pagination', async () => {
    const fake = responder(() => []);

    await expect(
      collectRoute({
        target: '/notes/123/reactors',
        limit: 100,
        maxPages: 10,
        request: fake.request,
      }),
    ).rejects.toThrow(/does not support collection/i);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects repeated cursors to prevent infinite loops', async () => {
    const fake = responder((_url, call) => ({
      items: [{ entity_key: `item-${call}` }],
      nextCursor: 'same-token',
    }));

    await expect(
      collectRoute({
        target: '/notes/suggested',
        limit: 100,
        maxPages: 10,
        request: fake.request,
      }),
    ).rejects.toThrow(/repeated the same cursor/i);
  });

  it('rejects repeated page payloads even when the page number advances', async () => {
    const fake = responder(() => ({
      results: [{ id: 1 }, { id: 2 }],
      more: true,
    }));

    await expect(
      collectRoute({
        target: '/profiles/search?query=ai',
        limit: 100,
        maxPages: 10,
        request: fake.request,
      }),
    ).rejects.toThrow(/repeated the same result page/i);
    expect(fake.calls).toHaveLength(2);
  });

  it('rejects an empty page that claims more results', async () => {
    const fake = responder(() => ({ results: [], more: true }));

    await expect(
      collectRoute({
        target: '/profiles/search?query=ai',
        limit: 100,
        maxPages: 10,
        request: fake.request,
      }),
    ).rejects.toThrow(/empty page while claiming more/i);
    expect(fake.calls).toHaveLength(1);
  });

  it('does not return an unsafe continuation when the limit truncates a page', async () => {
    const fake = responder(() => ({
      results: [{ id: 1 }, { id: 2 }, { id: 3 }],
      more: true,
    }));

    const result = await collectRoute({
      target: '/profiles/search?query=ai',
      limit: 2,
      maxPages: 10,
      request: fake.request,
    });

    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      count: 2,
      pagesFetched: 1,
      exhausted: false,
      continuation: null,
    });
  });
});
