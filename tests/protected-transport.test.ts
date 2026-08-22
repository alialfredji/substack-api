import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubstackHttp } from '../src/client/http.js';

const createSession = vi.hoisted(() => vi.fn());

vi.mock('wreq-js', () => ({ createSession }));

const listPayload = {
  subscriberLists: [
    {
      id: 'subscribers',
      name: 'Subscribers',
      groups: [{ name: 'Free subscribers', users: [{ id: 1, name: 'One', handle: 'one' }] }],
    },
  ],
};

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

function mockSession(fetch: ReturnType<typeof vi.fn>) {
  const session = {
    closed: false,
    fetch,
    close: vi.fn(async () => {
      session.closed = true;
    }),
  };
  return session;
}

describe('Cloudflare-protected transport', () => {
  beforeEach(() => {
    createSession.mockReset();
  });

  it('bootstraps once, reuses the session, and closes it', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response('<html>root</html>', { status: 200 }))
      .mockResolvedValueOnce(response(listPayload, { status: 200 }));
    const session = mockSession(fetch);
    createSession.mockResolvedValue(session);
    const http = new SubstackHttp({ minDelayMs: 0, retries: 0 });

    await expect(
      http.requestRaw('/api/v1/user/42/subscriber-lists', { query: { lists: 'subscribers' } }),
    ).resolves.toEqual(listPayload);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://substack.com/',
      'https://substack.com/api/v1/user/42/subscriber-lists?lists=subscribers',
    ]);

    await http.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('re-bootstraps once when Cloudflare challenges an expired session', async () => {
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(response('<html>root</html>', { status: 200 }))
      .mockResolvedValueOnce(
        response('<html>challenge</html>', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
        }),
      );
    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce(response('<html>root</html>', { status: 200 }))
      .mockResolvedValueOnce(response(listPayload, { status: 200 }));
    const first = mockSession(firstFetch);
    const second = mockSession(secondFetch);
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const http = new SubstackHttp({ minDelayMs: 0, retries: 0 });

    await expect(
      http.requestRaw('/api/v1/user/42/subscriber-lists', { query: { lists: 'subscribers' } }),
    ).resolves.toEqual(listPayload);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    await http.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('respects an explicitly injected fetch implementation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(listPayload, { status: 200 }));
    const http = new SubstackHttp({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minDelayMs: 0,
      retries: 0,
    });

    await expect(
      http.requestRaw('/api/v1/user/42/subscriber-lists', { query: { lists: 'subscribers' } }),
    ).resolves.toEqual(listPayload);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
  });
});
