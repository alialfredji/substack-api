import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { SubstackHttp } from '../src/client/http.js';
import {
  SubstackHttpError,
  SubstackParseError,
  SubstackTimeoutError,
  SubstackValidationError,
} from '../src/client/errors.js';

/** A realistic stand-in for Substack's ~68 KB HTML 404 page. */
const HTML_BODY = `<!DOCTYPE html>\n<html lang="en" dir="ltr">\n<head><meta charset="utf-8" /><title>Substack</title></head>\n<body>${'x'.repeat(2000)}</body></html>`;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function htmlResponse(status: number): Response {
  return new Response(HTML_BODY, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  method: string;
  redirect: string | undefined;
}

/** Fake fetch that returns a scripted sequence and records what it was sent. */
function scriptedFetch(sequence: Array<() => Response>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const impl = (async (input: unknown, init: Record<string, unknown>) => {
    calls.push({
      url: String(input),
      headers: (init['headers'] as Record<string, string>) ?? {},
      method: String(init['method'] ?? 'GET'),
      redirect: init['redirect'] as string | undefined,
    });
    const make = sequence[Math.min(index, sequence.length - 1)]!;
    index += 1;
    return make();
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    get count(): number {
      return index;
    },
  };
}

const ENV_KEYS = ['SUBSTACK_COOKIE', 'SUBSTACK_VALIDATE', 'SUBSTACK_DEBUG'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Validation warnings write to stderr; keep test output readable.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('cookie handling', () => {
  it('sends no cookie header when none is configured', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ ok: true })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await http.request('/api/v1/categories');

    expect(http.hasCookie).toBe(false);
    expect(fetcher.calls[0]!.headers['cookie']).toBeUndefined();
  });

  it('wraps a bare sid value into a valid cookie header', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ ok: true })]);
    const http = new SubstackHttp({ cookie: 'abc123', fetchImpl: fetcher.impl });

    await http.request('/api/v1/categories');

    expect(http.hasCookie).toBe(true);
    expect(fetcher.calls[0]!.headers['cookie']).toBe('substack.sid=abc123');
  });

  it('lets a single call override the client cookie', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ ok: true })]);
    const http = new SubstackHttp({ cookie: 'client-sid', fetchImpl: fetcher.impl });

    await http.request('/api/v1/categories', { cookie: 'per-request-sid' });

    expect(fetcher.calls[0]!.headers['cookie']).toBe('substack.sid=per-request-sid');
  });

  it('treats an explicit null cookie as "force anonymous"', async () => {
    // This distinction matters: the gateway needs a way to make an anonymous
    // call even when the server itself has a cookie configured.
    const fetcher = scriptedFetch([() => jsonResponse({ ok: true })]);
    const http = new SubstackHttp({ cookie: 'client-sid', fetchImpl: fetcher.impl });

    await http.request('/api/v1/categories', { cookie: null });

    expect(fetcher.calls[0]!.headers['cookie']).toBeUndefined();
  });
});

describe('url and query building', () => {
  it('expands array values into repeated keys, matching Substack\'s convention', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ items: [] })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await http.request('/api/v1/reader/feed', { query: { 'types[]': ['note', 'comment'] } });

    const url = new URL(fetcher.calls[0]!.url);
    expect(url.searchParams.getAll('types[]')).toEqual(['note', 'comment']);
  });

  it('drops undefined and null query values instead of sending "undefined"', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({})]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await http.request('/api/v1/profile/search', {
      query: { query: 'ai', page: 0, cursor: undefined, limit: null },
    });

    const url = new URL(fetcher.calls[0]!.url);
    expect(url.searchParams.get('query')).toBe('ai');
    expect(url.searchParams.get('page')).toBe('0');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('honours a per-call baseUrl for publication-scoped endpoints', async () => {
    const fetcher = scriptedFetch([() => jsonResponse([])]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await http.request('/api/v1/archive', { baseUrl: 'https://aieworks.substack.com' });

    expect(fetcher.calls[0]!.url).toBe('https://aieworks.substack.com/api/v1/archive');
  });

  it('accepts an absolute URL as the path', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({})]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await http.request('https://example.substack.com/api/v1/thing');

    expect(fetcher.calls[0]!.url).toBe('https://example.substack.com/api/v1/thing');
  });
});

describe('error translation', () => {
  it('turns Substack\'s HTML 404 page into a small typed error', async () => {
    const fetcher = scriptedFetch([() => htmlResponse(404)]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 0 });

    const error = await http.request('/api/v1/nope').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SubstackHttpError);
    const httpError = error as SubstackHttpError;
    expect(httpError.status).toBe(404);
    expect(httpError.isNotFound).toBe(true);
    expect(httpError.wasHtml).toBe(true);
    expect(httpError.message).toMatch(/HTML response/);
    // The whole point: the 2 KB page must not end up in the message.
    expect(httpError.bodyPreview.length).toBeLessThanOrEqual(400);
    expect(httpError.message.length).toBeLessThan(600);
  });

  it('does not retry a 404, which will never become a 200', async () => {
    const fetcher = scriptedFetch([() => htmlResponse(404)]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 3 });

    await expect(http.request('/api/v1/nope')).rejects.toBeInstanceOf(SubstackHttpError);
    expect(fetcher.count).toBe(1);
  });

  it('raises a parse error when a 200 carries an HTML body', async () => {
    const fetcher = scriptedFetch([() => new Response(HTML_BODY, { status: 200 })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 0 });

    await expect(http.request('/api/v1/weird')).rejects.toBeInstanceOf(SubstackParseError);
  });

  it('raises a parse error on malformed JSON', async () => {
    const fetcher = scriptedFetch([
      () => new Response('{"truncated": ', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 0 });

    await expect(http.request('/api/v1/weird')).rejects.toBeInstanceOf(SubstackParseError);
  });

  it('reports a timeout as a timeout, not a generic abort', async () => {
    const impl = (async (_url: unknown, init: Record<string, unknown>) =>
      new Promise<Response>((_resolve, reject) => {
        (init['signal'] as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const http = new SubstackHttp({ fetchImpl: impl, timeoutMs: 25, retries: 0 });

    await expect(http.request('/api/v1/slow')).rejects.toBeInstanceOf(SubstackTimeoutError);
  });
});

describe('retries', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    // retry-after: 0 keeps the test fast while exercising the header path.
    const fetcher = scriptedFetch([
      () => jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '0' }),
      () => jsonResponse({ ok: true }),
    ]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 2 });

    await expect(http.request('/api/v1/categories')).resolves.toEqual({ ok: true });
    expect(fetcher.count).toBe(2);
  });

  it('retries 5xx up to the configured limit, then throws', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ err: 1 }, 503, { 'retry-after': '0' })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, retries: 2 });

    const error = await http.request('/api/v1/categories').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SubstackHttpError);
    expect((error as SubstackHttpError).status).toBe(503);
    expect(fetcher.count).toBe(3); // first attempt + 2 retries
  });
});

describe('schema validation modes', () => {
  const Schema = z.looseObject({ id: z.number(), name: z.string() });

  it('lenient mode returns the payload even when it does not match', async () => {
    // The upstream is undocumented. A new or renamed field must not break a
    // caller's script, so lenient warns and hands the data back.
    const fetcher = scriptedFetch([() => jsonResponse({ id: 'not-a-number', name: 'x' })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, validate: 'lenient' });

    const result = await http.request('/api/v1/thing', { schema: Schema });

    expect(result).toEqual({ id: 'not-a-number', name: 'x' });
  });

  it('strict mode throws with readable field-level issues', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ id: 'nope', name: 'x' })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, validate: 'strict' });

    const error = await http.request('/api/v1/thing', { schema: Schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SubstackValidationError);
    const validationError = error as SubstackValidationError;
    expect(validationError.issues.join(' ')).toMatch(/id/);
    // The raw data is retained so a caller can still recover it.
    expect(validationError.data).toEqual({ id: 'nope', name: 'x' });
  });

  it('off mode skips validation entirely', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ garbage: true })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, validate: 'off' });

    await expect(http.request('/api/v1/thing', { schema: Schema })).resolves.toEqual({ garbage: true });
  });

  it('keeps unknown fields, because looseObject is the whole point', async () => {
    const fetcher = scriptedFetch([
      () => jsonResponse({ id: 1, name: 'x', undocumentedNewField: 'kept' }),
    ]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, validate: 'strict' });

    const result = await http.request<{ undocumentedNewField?: string }>('/api/v1/thing', {
      schema: Schema as unknown as z.ZodType<{ undocumentedNewField?: string }>,
    });

    expect(result.undocumentedNewField).toBe('kept');
  });

  it('warns only once per endpoint and issue, so drift cannot flood stderr', async () => {
    const write = vi.mocked(process.stderr.write);
    const fetcher = scriptedFetch([() => jsonResponse({ id: 'bad', name: 'x' })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, validate: 'lenient' });

    await http.request('/api/v1/thing', { schema: Schema });
    await http.request('/api/v1/thing', { schema: Schema });
    await http.request('/api/v1/thing', { schema: Schema });

    const driftWarnings = write.mock.calls.filter((call) => String(call[0]).includes('schema drift'));
    expect(driftWarnings).toHaveLength(1);
  });
});

describe('concurrency gate', () => {
  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const http = new SubstackHttp({ fetchImpl: impl, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, () => http.request('/api/v1/categories')));

    expect(peak).toBe(2);
  });

  it('still completes every queued request', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ ok: true })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl, concurrency: 3 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => http.request('/api/v1/categories')),
    );

    expect(results).toHaveLength(10);
    expect(fetcher.count).toBe(10);
  });
});

describe('requestRaw', () => {
  it('returns the parsed payload without applying a schema', async () => {
    const fetcher = scriptedFetch([() => jsonResponse([{ anything: 1 }])]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await expect(http.requestRaw('/api/v1/categories')).resolves.toEqual([{ anything: 1 }]);
  });
});

describe('resolveRedirect', () => {
  const redirect = (location: string, status = 301): Response =>
    new Response('', { status, headers: { location } });

  it('returns the Location header without following it', async () => {
    // This is how a numeric user id becomes a handle: /profile/{id} 301s to /@handle.
    const fetcher = scriptedFetch([() => redirect('https://substack.com/@alialfredji')]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    const location = await http.resolveRedirect('/profile/86433889');

    expect(location).toBe('https://substack.com/@alialfredji');
    expect(fetcher.calls[0]!.redirect).toBe('manual');
  });

  it('returns null when the response was not a redirect', async () => {
    const fetcher = scriptedFetch([() => jsonResponse({ not: 'a redirect' })]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await expect(http.resolveRedirect('/profile/1')).resolves.toBeNull();
  });

  it('handles a relative Location value', async () => {
    const fetcher = scriptedFetch([() => redirect('/@somebody')]);
    const http = new SubstackHttp({ fetchImpl: fetcher.impl });

    await expect(http.resolveRedirect('/profile/2')).resolves.toBe('/@somebody');
  });

  it('still applies the configured cookie', async () => {
    const fetcher = scriptedFetch([() => redirect('/@x')]);
    const http = new SubstackHttp({ cookie: 'sid-value', fetchImpl: fetcher.impl });

    await http.resolveRedirect('/profile/3');

    expect(fetcher.calls[0]!.headers['cookie']).toBe('substack.sid=sid-value');
  });

  it('respects the concurrency gate like any other request', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return redirect('/@x');
    }) as unknown as typeof fetch;

    const http = new SubstackHttp({ fetchImpl: impl, concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => http.resolveRedirect(`/profile/${i}`)));

    expect(peak).toBe(2);
  });
});
