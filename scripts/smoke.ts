/**
 * Live smoke test: exercise every route against the real Substack API.
 *
 *   npm run smoke
 *
 * Uses Fastify's `inject()` rather than binding a port, so it runs the complete
 * server stack — routing, schema serialisation, error mapping — without needing
 * a free port or a second process. The upstream calls are real, which is the
 * point: schema drift and endpoint removal only show up against live data.
 *
 * Set SUBSTACK_COOKIE to additionally verify the authenticated paths.
 * Exits non-zero if any route behaves unexpectedly, so it works in CI.
 */

import 'dotenv/config';
import { buildApp } from '../src/server/app.js';

const app = await buildApp({ logger: false });
await app.ready();

const authenticated = app.substack.authenticated;

interface Result {
  label: string;
  url: string;
  status: number;
  ok: boolean;
  note: string;
  /** Set when the status was fine but the payload looks suspicious. */
  warn?: string;
}

/** Count the items in whichever collection key a payload uses. */
function itemCount(body: unknown): number | null {
  if (Array.isArray(body)) return body.length;
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['results', 'items', 'publications', 'comments']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
  }
  return null;
}

const results: Result[] = [];

/** Summarise a payload in one short line — never dump whole objects. */
function summarise(body: unknown): string {
  if (Array.isArray(body)) return `array(${body.length})`;
  if (body === null || typeof body !== 'object') return String(body);
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['results', 'items', 'publications', 'comments', 'overlap', 'categories']) {
    if (Array.isArray(record[key])) parts.push(`${key}=${(record[key] as unknown[]).length}`);
  }
  if (typeof record['handle'] === 'string') parts.push(`handle=${record['handle']}`);
  if (typeof record['name'] === 'string') parts.push(`name=${String(record['name']).slice(0, 24)}`);
  if (typeof record['overlapCount'] === 'number') parts.push(`overlapCount=${record['overlapCount']}`);
  if (typeof record['more'] === 'boolean') parts.push(`more=${record['more']}`);
  if (record['error'] !== undefined) parts.push(`error=${String(record['error'])}`);
  return parts.length ? parts.join(' ') : `keys=${Object.keys(record).slice(0, 5).join(',')}`;
}

async function hit(
  label: string,
  url: string,
  options: {
    expect?: number[];
    headers?: Record<string, string>;
    /**
     * Warn when the collection comes back empty. Use for routes that should
     * always have data — an empty payload there means transient upstream
     * degradation, not a real result, and a green tick would hide it.
     */
    expectNonEmpty?: boolean;
  } = {},
): Promise<unknown> {
  const expected = options.expect ?? [200];
  const response = await app.inject({ method: 'GET', url, headers: options.headers });
  let body: unknown = null;
  try {
    body = JSON.parse(response.payload);
  } catch {
    /* non-JSON (e.g. the Swagger UI HTML) */
  }
  const ok = expected.includes(response.statusCode);

  let warn: string | undefined;
  if (ok && options.expectNonEmpty) {
    const count = itemCount(body);
    if (count === 0) {
      warn =
        'empty payload on a route that should always return data - likely transient ' +
        'upstream throttling (see docs/UPSTREAM.md), re-run before believing it';
    }
  }

  results.push({
    label,
    url,
    status: response.statusCode,
    ok,
    note: body === null ? `${response.payload.length}B non-JSON` : summarise(body),
    ...(warn ? { warn } : {}),
  });
  return body;
}

// ---------------------------------------------------------------------------
// Discover real ids first. Hard-coding them would rot; deriving them means the
// smoke test keeps working as Substack's content changes.
// ---------------------------------------------------------------------------
console.log('Resolving live fixtures...');

const archive = (await hit('bootstrap: archive', '/publications/platformer/archive?limit=5')) as
  | Array<Record<string, unknown>>
  | { posts?: Array<Record<string, unknown>> }
  | null;

const posts = Array.isArray(archive) ? archive : (archive?.posts ?? []);
const firstPost = posts[0] ?? {};
const postSlug = String(firstPost['slug'] ?? '');
const postId = Number(firstPost['id'] ?? 0);
const publicationId = Number(firstPost['publication_id'] ?? 0);

// A post with actual comments, so the comment routes get exercised for real.
const commented = posts.find((p) => Number(p['comment_count'] ?? 0) > 0) ?? firstPost;
const commentedId = Number(commented['id'] ?? postId);

console.log(
  `  platformer: publicationId=${publicationId} postId=${postId} slug=${postSlug.slice(0, 40)} ` +
    `commentedPostId=${commentedId}`,
);
console.log(`  cookie: ${authenticated ? 'present' : 'absent (viewer-relative fields will be false)'}\n`);

const SELF = 'alialfredji';
const SELF_ID = 86433889;
const NOTE_ID = 314595743;

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
await hit('meta: health', '/health');
await hit('meta: config', '/config');
await hit('meta: openapi', '/openapi.json');
await hit('meta: swagger ui', '/docs', { expect: [200, 302] });

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------
await hit('profiles: by handle', `/profiles/${SELF}`);
await hit('profiles: subscriptions', `/profiles/${SELF}/subscriptions`);
await hit('profiles: search', '/profiles/search?query=ai%20engineer&page=0', { expectNonEmpty: true });
await hit('profiles: overlap', `/profiles/${SELF}/overlap/${SELF}`);
await hit('profiles: unknown handle 404', '/profiles/definitely-not-a-real-handle-xyz9', {
  expect: [404, 502],
});

// These exist only if the id->handle bridge landed; tolerate 404 on the route itself.
await hit('profiles: handle by id', `/profiles/by-id/${SELF_ID}/handle`, { expect: [200, 404] });
await hit('profiles: profile by id', `/profiles/by-id/${SELF_ID}`, { expect: [200, 404] });

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------
await hit('notes: profile feed', `/notes/profile/${SELF_ID}`, { expectNonEmpty: true });
await hit('notes: suggested feed', '/notes/suggested');
await hit('notes: single note', `/notes/${NOTE_ID}`);
await hit('notes: reactors', `/notes/${NOTE_ID}/reactors`);
await hit('notes: context users', `/notes/profile/${SELF_ID}/context-users`);
// Without a cookie this must fail loudly rather than return a worthless list.
await hit('notes: unsubscribed reactors', `/notes/${NOTE_ID}/reactors?unsubscribedOnly=true`, {
  expect: authenticated ? [200] : [401],
});

// ---------------------------------------------------------------------------
// publications
// ---------------------------------------------------------------------------
// Known to degrade to an empty result under light load and recover in seconds.
await hit('publications: search', '/publications/search?query=ai&page=0', { expectNonEmpty: true });
await hit('publications: archive', '/publications/platformer/archive?limit=3', { expectNonEmpty: true });
if (postSlug) await hit('publications: post by slug', `/publications/platformer/posts/${postSlug}`);
await hit('publications: comments', `/publications/platformer/posts/${commentedId}/comments`);
await hit('publications: commenters', `/publications/platformer/posts/${commentedId}/commenters`);
if (publicationId) {
  await hit(
    'publications: recommendations',
    `/publications/platformer/recommendations?publicationId=${publicationId}`,
  );
  await hit(
    'publications: related',
    `/publications/platformer/related?publicationId=${publicationId}&limit=5`,
  );
}
// Documented as returning nothing for every query tried; assert it at least responds.
await hit('publications: post search (known empty)', '/posts/search?query=ai');

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
await hit('discovery: categories', '/discovery/categories', { expectNonEmpty: true });
await hit('discovery: category tree', '/discovery/categories/tree', { expect: [200, 404] });
await hit('discovery: category by slug', '/discovery/categories/technology', { expect: [200, 404] });
await hit('discovery: leaderboard by slug', '/discovery/categories/technology/leaderboard?page=0', {
  expectNonEmpty: true,
});
await hit('discovery: leaderboard by id', '/discovery/categories/4/leaderboard?page=0', {
  expectNonEmpty: true,
});
// "podcast" is the one string category id, and it is a working leaderboard id.
await hit('discovery: leaderboard (string id)', '/discovery/categories/podcast/leaderboard?page=0', {
  expectNonEmpty: true,
});

// ---------------------------------------------------------------------------
// cookie plumbing: `none` must force an anonymous upstream call
// ---------------------------------------------------------------------------
await hit('cookie: forced anonymous', `/profiles/${SELF}`, { headers: { 'x-substack-cookie': 'none' } });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
await app.close();

const width = Math.max(...results.map((r) => r.label.length));
console.log('Route sweep:\n');
for (const r of results) {
  const verdict = !r.ok ? 'FAIL' : r.warn ? 'WARN' : 'PASS';
  console.log(`  ${verdict}  ${r.label.padEnd(width)}  ${String(r.status).padEnd(4)} ${r.note}`);
}

const failed = results.filter((r) => !r.ok);
const warned = results.filter((r) => r.ok && r.warn);

console.log(`\n${results.length - failed.length}/${results.length} routes behaved as expected.`);

if (warned.length) {
  console.log(`\n${warned.length} warning(s) — status was fine, payload was not:`);
  for (const r of warned) console.log(`  ${r.label}: ${r.warn}`);
}

if (failed.length) {
  console.log('\nUnexpected:');
  for (const r of failed) console.log(`  ${r.status}  ${r.url}`);
  process.exit(1);
}
