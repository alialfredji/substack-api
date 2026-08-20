export interface CollectOptions {
  target: string;
  limit: number;
  maxPages: number;
  request: (target: string) => Promise<{ statusCode: number; payload: string }>;
}

export type CollectContinuation =
  | { parameter: 'page'; value: number }
  | { parameter: 'cursor'; value: string }
  | { parameter: 'offset'; value: number };

export interface CollectEnvelope {
  items: unknown[];
  count: number;
  pagesFetched: number;
  exhausted: boolean;
  continuation: CollectContinuation | null;
}

type RouteKind = 'profile-search' | 'publication-search' | 'notes' | 'archive' | 'leaderboard';

interface PageShape {
  items: unknown[];
  hasMore: boolean;
  continuation: CollectContinuation | null;
}

const ARCHIVE_PAGE_SIZE = 50;

function routeKind(pathname: string): RouteKind | null {
  if (pathname === '/profiles/search') return 'profile-search';
  if (pathname === '/publications/search') return 'publication-search';
  if (pathname === '/notes/suggested' || /^\/notes\/profile\/[^/]+$/.test(pathname)) return 'notes';
  if (/^\/publications\/[^/]+\/archive$/.test(pathname)) return 'archive';
  if (/^\/discovery\/categories\/[^/]+\/leaderboard$/.test(pathname)) return 'leaderboard';
  return null;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function objectPayload(payload: unknown, route: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Unexpected response shape while collecting ${route}`);
  }
  return payload as Record<string, unknown>;
}

function arrayField(payload: Record<string, unknown>, field: string, route: string): unknown[] {
  const value = payload[field];
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${field}[] while collecting ${route}`);
  }
  return value;
}

function itemKey(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const key = record['id'] ?? record['entity_key'];
  return typeof key === 'string' || typeof key === 'number' ? String(key) : null;
}

function addUnique(target: unknown[], seen: Set<string>, incoming: unknown[], limit: number): boolean {
  let truncated = false;

  for (const item of incoming) {
    const key = itemKey(item);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    if (target.length >= limit) {
      truncated = true;
      continue;
    }

    target.push(item);
  }

  return truncated;
}

function pageSignature(items: unknown[]): string {
  return items
    .map((item) => {
      const key = itemKey(item);
      if (key !== null) return `key:${key}`;
      return `json:${JSON.stringify(item)}`;
    })
    .join('\u001f');
}

async function fetchPayload(
  target: URL,
  request: CollectOptions['request'],
): Promise<unknown> {
  const response = await request(`${target.pathname}${target.search}`);
  let payload: unknown;
  try {
    payload = JSON.parse(response.payload);
  } catch {
    throw new Error(`Collection request returned non-JSON (HTTP ${response.statusCode})`);
  }
  if (response.statusCode >= 400) {
    const detail =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : response.payload.slice(0, 200);
    throw new Error(`Collection request failed (HTTP ${response.statusCode}): ${detail}`);
  }
  return payload;
}

function pageNumber(url: URL): number {
  const raw = url.searchParams.get('page');
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error('page must be a non-negative integer');
  return value;
}

function offsetNumber(url: URL): number {
  const raw = url.searchParams.get('offset');
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error('offset must be a non-negative integer');
  return value;
}

async function fetchPage(
  kind: RouteKind,
  url: URL,
  request: CollectOptions['request'],
  remaining: number,
): Promise<PageShape> {
  if (kind === 'archive') {
    const offset = offsetNumber(url);
    const requestLimit = Math.min(ARCHIVE_PAGE_SIZE, remaining);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(requestLimit));
    const payload = await fetchPayload(url, request);
    if (!Array.isArray(payload)) throw new Error('Expected an array while collecting publication archive');
    const nextOffset = offset + payload.length;
    const hasMore = payload.length === requestLimit;
    return {
      items: payload,
      hasMore,
      continuation: hasMore ? { parameter: 'offset', value: nextOffset } : null,
    };
  }

  if (kind === 'notes') {
    const payload = objectPayload(await fetchPayload(url, request), 'notes feed');
    const items = arrayField(payload, 'items', 'notes feed');
    const cursor = typeof payload['nextCursor'] === 'string' ? payload['nextCursor'] : null;
    return {
      items,
      hasMore: cursor !== null && cursor.length > 0,
      continuation: cursor ? { parameter: 'cursor', value: cursor } : null,
    };
  }

  const page = pageNumber(url);
  url.searchParams.set('page', String(page));
  let payload = objectPayload(await fetchPayload(url, request), kind);

  if (
    kind === 'publication-search' &&
    Array.isArray(payload['results']) &&
    payload['results'].length === 0 &&
    typeof payload['more'] !== 'boolean'
  ) {
    payload = objectPayload(await fetchPayload(url, request), kind);
    if (
      Array.isArray(payload['results']) &&
      payload['results'].length === 0 &&
      typeof payload['more'] !== 'boolean'
    ) {
      throw new Error(
        'Publication search returned an empty result with no "more" flag twice; upstream throttling is likely and the result is inconclusive',
      );
    }
  }

  const field = kind === 'leaderboard' ? 'publications' : 'results';
  const items = arrayField(payload, field, kind);
  const hasMore = payload['more'] === true;
  return {
    items,
    hasMore,
    continuation: hasMore ? { parameter: 'page', value: page + 1 } : null,
  };
}

/** Collect multiple pages from one documented, paginated gateway route. */
export async function collectRoute(options: CollectOptions): Promise<CollectEnvelope> {
  positiveInteger(options.limit, '--limit');
  positiveInteger(options.maxPages, '--max-pages');

  const url = new URL(options.target, 'http://127.0.0.1');
  const kind = routeKind(url.pathname);
  if (!kind) {
    throw new Error(
      `Route does not support collection: ${url.pathname}. Supported routes are profile search, publication search, profile/suggested notes, publication archives, and category leaderboards`,
    );
  }

  const items: unknown[] = [];
  const seenItems = new Set<string>();
  const seenContinuations = new Set<string>();
  const seenPages = new Set<string>();
  const initialCursor = url.searchParams.get('cursor');
  if (initialCursor) seenContinuations.add(`cursor:${initialCursor}`);
  let pagesFetched = 0;
  let next: CollectContinuation | null = null;
  let exhausted = false;

  while (pagesFetched < options.maxPages && items.length < options.limit) {
    const page = await fetchPage(kind, url, options.request, options.limit - items.length);
    pagesFetched += 1;

    if (page.hasMore && page.items.length === 0) {
      throw new Error('Upstream returned an empty page while claiming more results; collection cannot advance safely');
    }

    const signature = pageSignature(page.items);
    if (seenPages.has(signature)) {
      throw new Error('Upstream repeated the same result page; collection cannot advance safely');
    }
    seenPages.add(signature);

    const truncated = addUnique(items, seenItems, page.items, options.limit);
    next = page.continuation;

    if (truncated) {
      next = null;
      break;
    }

    if (!page.hasMore || next === null) {
      exhausted = true;
      next = null;
      break;
    }

    if (items.length >= options.limit || pagesFetched >= options.maxPages) break;

    const continuationKey = `${next.parameter}:${next.value}`;
    if (seenContinuations.has(continuationKey)) {
      throw new Error(`Upstream repeated the same ${next.parameter} continuation: ${next.value}`);
    }
    seenContinuations.add(continuationKey);
    url.searchParams.set(next.parameter, String(next.value));
  }

  return {
    items,
    count: items.length,
    pagesFetched,
    exhausted,
    continuation: exhausted ? null : next,
  };
}
