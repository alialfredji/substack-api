# substack-api

A typed TypeScript client and a documented REST gateway over Substack's
**public, undocumented** API. Read-only. Cookie optional. Swagger UI included.

Built for finding people and publications — profile search, subscription graphs,
note engagement, category leaderboards — so that a tool can rank who is worth
engaging with.

- **28 routes**, every one verified against the live API
- **Zero write endpoints**, on purpose — see [Why read-only](#why-read-only)
- Full endpoint research, including 22 confirmed dead ends, in
  [`docs/UPSTREAM.md`](docs/UPSTREAM.md)

📖 **Browse every route: <https://alialfredji.github.io/substack-api/>**
— documentation only, there is no hosted API. The gateway runs on your machine.

---

## Requirements

Node **24 or newer** (developed on 25.8). No other services needed.

## Install the CLI

Run it without a global install:

```bash
npx --yes --package @alialf/substack-api@0.2.2 substack-api routes profiles
```

Or install the binary globally:

```bash
npm install --global @alialf/substack-api
substack-api call /health
```

## Quickstart

```bash
npm install
cp .env.example .env    # optional — everything works without it
npm run dev
```

Then open **<http://127.0.0.1:3000/docs>**. Every route is listed, documented,
and executable from the browser with a "Try it out" button. Each one carries a
runnable `curl` example and the equivalent TypeScript call in its description.

Verify it against live Substack in one command:

```bash
npm run smoke
```

## Using it as a library

```ts
import { createSubstackClient } from '@alialf/substack-api';

const substack = createSubstackClient();          // anonymous — this is fine

const profile = await substack.profiles.getByHandle('alialfredji');
console.log(profile.name, profile.subscriberCount, profile.subscriptions?.length);

const people = await substack.profiles.searchAll({ query: 'ai engineer', limit: 60 });
console.log(people.length, 'profiles, each with their subscriptions[]');
```

## The cookie model

**Every route works with no cookie.** A cookie only upgrades *viewer-relative*
fields — the ones answering "what is the relationship between the caller and this
person". Anonymously they are all `false`:

| Field | Where | Anonymous | With cookie |
|---|---|---|---|
| `is_subscribed` | note reactors | always `false` | correct |
| `is_following` | note reactors | always `false` | correct |
| `isSubscribed` / `isFollowing` / `followsViewer` | profile | always `false` | correct |

Three ways to supply one, in increasing precedence:

```bash
# 1. Whole server, via .env
SUBSTACK_COOKIE=s%3AabC123...
```

```ts
// 2. Per client
createSubstackClient({ cookie: process.env.SUBSTACK_COOKIE });
```

```bash
# 3. Per request against the gateway
curl -s http://127.0.0.1:3000/notes/314595743/reactors \
  -H 'x-substack-cookie: s%3AabC123...'

# force an anonymous upstream call even when the server has a cookie
curl -s http://127.0.0.1:3000/profiles/alialfredji -H 'x-substack-cookie: none'
```

Both a bare `substack.sid` value and a full `Cookie` header string are accepted.
Get it from DevTools → Application → Cookies → `substack.com` → `substack.sid`.
**Treat it like a password** — it is full account access, and `.env` is gitignored
for that reason.

The subscriber/follower/following endpoint is protected by a browser-fingerprint check.
The client handles it transparently: the first such call lazily bootstraps a
browser-compatible HTTP session, and later calls reuse it. Public methods,
Swagger routes, and cookie semantics are unchanged.

One deliberate hard failure: `unsubscribedReactors()` — "who liked this but has
not subscribed" — **throws `SubstackAuthRequiredError` without a cookie** rather
than returning a list. Anonymously every reactor reads `is_subscribed: false`, so
the filter would hand back everyone while looking like it worked.

## Client API

Every method takes an optional trailing `opts?: CallOptions`
(`{ cookie?: string | null; signal?: AbortSignal }`). Methods that walk pages take
`PaginateOptions` (`{ limit?, maxPages? }`) and are bounded by default.

Pagination is route-specific because the upstream API has no common convention:

| Strategy | Collections | Continuation |
|---|---|---|
| Page | Profile search, publication search, category leaderboards | Increment `page`; stop when `more` is false |
| Cursor | Profile Notes, suggested Notes | Pass the returned `nextCursor` |
| Offset | Publication archives | Increase `offset` by the number of posts returned |
| Unpaginated | Note reactors, comments, recommendations, categories | No working upstream continuation mechanism is known |

Use the `*All` / `collect*` helpers below for bounded multi-page work. A `limit`
caps collected items; `maxPages` caps upstream requests. Neither changes
Substack's fixed or variable upstream page size.

### `substack.profiles`

| Method | Notes |
|---|---|
| `getByHandle(handle)` | Full profile, including public `subscriptions[]` |
| `getByUserId(userId)` | Two requests: resolves the handle first, then fetches. Cached |
| `resolveHandle(userId)` | Numeric id → handle, via a `301`. The bridge from a note reactor to a profile |
| `search({ query, page })` | Returns full profile objects, `subscriptions[]` included |
| `searchAll({ query, limit, maxPages })` | Bounded page walk, deduped by profile id. Page size is fixed at 20 upstream |
| `getSubscriptions(handle)` | Just the subscription list |
| `getSubscriberLists(handleOrId, lists)` | Grouped subscribers/followers/following; numeric id is one request, handle is two |
| `getSubscribers(handleOrId)` | Flat, deduped public subscriber list |
| `getFollowers(handleOrId)` | Flat, deduped public follower list |
| `getFollowing(handleOrId)` | Flat, deduped list of followed profiles; capped at 200 upstream |
| `subscriptionOverlap(a, b)` | Shared publications + count + Jaccard score |

### `substack.notes`

| Method | Notes |
|---|---|
| `reactors(noteId)` | Who liked a note. Carries `is_subscribed` / `is_following` |
| `unsubscribedReactors(noteId)` | Liked but not subscribed. **Requires a cookie** |
| `listByProfile(userId, { cursor, types })` | One person's notes |
| `listSuggested({ cursor, types })` | The suggested feed |
| `get(noteId)` | A single note |
| `collectProfileNotes(userId, { limit, maxPages, types })` | Bounded cursor walk over a profile's notes |
| `collectSuggestedNotes({ limit, maxPages, types })` | Bounded cursor walk over suggested Notes |
| `contextUsers(page)` | Deduped "why am I seeing this" users. Only populated on the suggested feed |

### `substack.publications`

| Method | Notes |
|---|---|
| `search({ query, limit, page })` | `limit` is ignored upstream; use `page`. **Dedupe by id** — pages overlap slightly |
| `searchAll({ query, limit, maxPages })` | Bounded page walk, deduped by publication id. Empty results may mean throttling |
| `archive(subdomain, { limit, offset, sort })` | Post list. `offset` genuinely pages |
| `archiveAll(subdomain, { limit, maxPages, pageSize, sort })` | Bounded offset walk; `pageSize` controls each archive request |
| `getPost(subdomain, slug)` | Slug only; there is no numeric post lookup |
| `comments(subdomain, postId, { sort, allComments })` | Nested thread |
| `commenters(subdomain, postId)` | Flattened, deduped people from a comment tree |
| `recommendations(subdomain, publicationId)` | Publications this one recommends |
| `relatedPublications(subdomain, publicationId, { limit, maxPages })` | Bounded BFS over the recommendation graph |
| `searchPosts({ query, limit })` | Wrapped for completeness — **appears non-functional upstream** |

### `substack.discovery`

| Method | Notes |
|---|---|
| `categories()` | 32 top-level, subcategories pre-nested |
| `findCategory(idOrSlugOrName)` | Client-side resolution — upstream rejects slugs |
| `leaderboard(category, { page, type })` | Accepts id, slug or name. Page size fixed at 25. `type` has no effect |
| `leaderboardAll(category, { limit, maxPages })` | Bounded walk — this paginates very deep |
| `categoryTree()` | Grouped by `parent_tag_id` |

## REST routes

All `GET`. Browse and execute them at `/docs`.

| Route | Purpose |
|---|---|
| `/health`, `/config`, `/openapi.json` | Meta. `/config` shows whether a cookie was detected |
| `/profiles/{handle}` | Profile with subscriptions |
| `/profiles/{handle}/subscriptions` | Subscription list only |
| `/profiles/{handle}/subscribers` | Public subscriber list |
| `/profiles/{handle}/followers` | Public follower list |
| `/profiles/{handle}/following` | Public list of followed profiles; capped at 200 upstream |
| `/profiles/by-id/{userId}` | Profile by numeric id |
| `/profiles/by-id/{userId}/handle` | Just the id → handle mapping (one request) |
| `/profiles/search?query=&page=` | People search |
| `/profiles/{handle}/overlap/{other}` | Subscription overlap + score |
| `/notes/{noteId}/reactors?unsubscribedOnly=` | Who liked a note |
| `/notes/{noteId}` | A single note |
| `/notes/profile/{userId}` | A person's notes |
| `/notes/profile/{userId}/context-users` | Connective users |
| `/notes/suggested` | Suggested feed |
| `/publications/search?query=&page=` | Newsletter search |
| `/publications/{subdomain}/archive` | Post list |
| `/publications/{subdomain}/posts/{slug}` | One post |
| `/publications/{subdomain}/posts/{postId}/comments` | Comment thread |
| `/publications/{subdomain}/posts/{postId}/commenters` | Deduped commenters |
| `/publications/{subdomain}/recommendations?publicationId=` | Recommended publications |
| `/publications/{subdomain}/related?publicationId=` | Recommendation-graph walk |
| `/posts/search?query=` | Post search (non-functional upstream) |
| `/discovery/categories`, `/discovery/categories/tree` | Taxonomy |
| `/discovery/categories/{category}` | Resolved category |
| `/discovery/categories/{category}/leaderboard?page=&type=` | Top publications in a category |

## Examples

Each file is runnable and prints compact output:

```bash
npx tsx examples/profiles.ts        # lookup, search, id->handle, overlap scoring
npx tsx examples/notes.ts           # cursor-walk feeds, reactors, "liked but not subscribed"
npx tsx examples/publications.ts    # paged search -> archive walk -> harvest commenters
npx tsx examples/discovery.ts       # categories -> leaderboard
```

## A worked targeting pipeline

For a known profile, the relationship endpoint exposes its subscribers,
followers, and up to 200 profiles it follows. For broader discovery beyond those
fixed lists, every public profile also carries `subscriptions[]`. Gather
candidates from public engagement surfaces, then score each by subscription
overlap with your own reading.

```ts
const substack = createSubstackClient({ cookie: process.env.SUBSTACK_COOKIE });

// 1. Search several adjacent topics. One ranked query may exhaust before 100.
const candidates = new Map<number, { id: number; handle: string }>();
for (const query of ['ai engineer', 'software architecture', 'developer tools']) {
  const matches = await substack.profiles.searchAll({
    query,
    limit: 100,
    maxPages: 10,
  });
  for (const profile of matches) {
    if (profile.handle) candidates.set(profile.id, { id: profile.id, handle: profile.handle });
  }
}

// 2. Score the deduped candidates by how much their reading overlaps yours.
const ranked = [];
for (const { handle } of candidates.values()) {
  const { overlapCount, score } = await substack.profiles.subscriptionOverlap('alialfredji', handle);
  if (overlapCount > 0) ranked.push({ handle, overlapCount, score });
}
ranked.sort((a, b) => b.score - a.score);

// 3. Separately: people who already engaged with you but never subscribed.
const warm = await substack.notes.unsubscribedReactors(YOUR_NOTE_ID);
```

Search is keyword-ranked, not a complete directory. Multiple queries and
cross-query deduplication improve coverage, but cannot guarantee 100 exact
matches. The warm list is often the highest-yield one because those people have
already shown intent.

Then act on the list **as a human**, in a browser. That split is the whole point.

## Why read-only

Reads here are anonymous, IP-scoped, and carry no account attribution.

Writes are a different risk class entirely. Automating subscribe / follow / like /
comment means sending your session cookie at machine speed to paths that
Substack's own `robots.txt` disallows (`/action/`, `/subscribe`,
`/p/*/comment/*`), and it lands directly on the Terms of Use clause written for
exactly that — "any processes that run or are activated while you are not logged
into Substack" — with enforcement that is explicitly discretionary and
unappealable.

Note also that the ToS prohibits crawling outright, with no public-data
carve-out. This tool does not make that clause disappear; it just keeps the
account-linked half of the risk off the table.

So: **automate the targeting, perform the engagement yourself.** Full reasoning
and the quoted clauses are in [`docs/UPSTREAM.md §6`](docs/UPSTREAM.md).

## Upstream gotchas worth knowing before you trust a result

Details and evidence for each in [`docs/UPSTREAM.md`](docs/UPSTREAM.md).

- **`publication/search` degrades silently.** It returns `200` with
  `{"results": []}` under light load, then recovers in seconds. A nonsense query
  returns 8 fuzzy matches, so **empty means throttled, not "no matches"**. Retry
  rather than believing it.
- **Search and leaderboard `limit` values do not control page size.** Page sizes
  are fixed upstream: 20 (`profile/search`), ~18–19
  (`publication/search`), and 25 (leaderboards). Publication archives do honor
  `limit` and page with `offset`.
- **`publication/search` pages overlap** — dedupe by id.
- **Feed pagination uses opaque cursors.** Pass `nextCursor` back unchanged and
  stop if it is absent or repeats.
- **One category id is a string** (`"podcast"`), and it is a valid leaderboard id.
- **Comment threads are gated** for some publications even though counts are
  public. An empty thread is not proof of no comments.
- **Relationship lists are unpaginated.** The following list is capped at 200;
  `page`, `offset`, and `limit` all return the same first batch.
- **`reaction_count` can exceed `reactors.length`.** Do not assume they agree.

## Agent-friendly CLI

The CLI exposes every documented route as JSON without starting a listener. It
uses Fastify's in-process injection, so route validation, error mapping, cookies,
and response schemas behave exactly like the REST gateway.

```bash
# installed package
substack-api routes profiles
substack-api describe '/profiles/{handle}'
substack-api call '/profiles/alialfredji'
substack-api call '/profiles/search?query=ai%20engineer&page=0' --pretty
substack-api collect '/profiles/search?query=ai%20engineer' \
  --limit 100 \
  --max-pages 10

# local checkout; --silent keeps stdout as JSON for jq and other pipes
npm run --silent cli -- routes profiles
```

`call` returns one REST page. `collect` recognizes the route's page, cursor, or
offset strategy and returns a consistent bounded envelope:

```json
{
  "items": ["..."],
  "count": 100,
  "pagesFetched": 5,
  "exhausted": false,
  "continuation": {
    "parameter": "page",
    "value": 5
  }
}
```

`exhausted` means the upstream collection ended. When `limit` or `maxPages`
stops the walk first, `continuation` contains `{ parameter, value }` for the
page, cursor, or offset needed to resume. `collect` rejects routes in the
unpaginated group. Always supply a finite bound; collection does not turn
keyword-ranked search into a complete global directory.

Collection is paced by default: one upstream request at a time, with at least
250 ms between request starts. HTTP 429, transient 5xx, and network errors are
retried up to four times with exponential backoff. A `Retry-After` header pauses
the whole client queue, not only the request that received it. After the retry
ceiling, collection stops with a typed error rather than looping indefinitely.

After building or installing the package, use the `substack-api` binary directly.
Set `SUBSTACK_COOKIE` for viewer-relative fields, or pass `--anonymous` to force
one call to ignore it.

## Install the agent skill

The repository also contains a Codex-compatible skill that invokes the published
CLI and explains how to interpret its results:

```bash
npx skills add alialf/substack-api --skill substack-api --agent codex -g -y
```

Restart Codex, then invoke `$substack-api` or ask it to query Substack profiles,
notes, publications, comments, or discovery data.

To test from a local checkout before the npm package is published:

```bash
npx skills add . --skill substack-api --agent codex -y --copy
export SUBSTACK_API_DIR=/absolute/path/to/substack-api
```

Start or restart Codex from that shell so the installed skill can use the local
checkout.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server with watch reload |
| `npm run serve` | Server, one-shot |
| `npm run --silent cli -- ...` | Discover, describe, invoke, and collect routes as pipe-safe JSON |
| `npm run smoke` | Exercise every route against live Substack |
| `npm test` | Unit tests (transport, config) — no network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` / `npm start` | Compile to `dist/`, then run |
| `npm run spec` | Write `openapi.json` |

See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the manual npm release and
skill-testing workflow.

## Configuration

All optional — see [`.env.example`](.env.example) for the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `SUBSTACK_COOKIE` | – | Session cookie. Upgrades viewer-relative fields |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Server binding |
| `SUBSTACK_CONCURRENCY` | `1` | Max simultaneous upstream requests |
| `SUBSTACK_MIN_DELAY_MS` | `250` | Minimum gap between request starts |
| `SUBSTACK_TIMEOUT_MS` | `15000` | Per-request timeout |
| `SUBSTACK_RETRIES` | `4` | Retries after the first attempt on 429/5xx/network |
| `SUBSTACK_RETRY_BASE_DELAY_MS` | `1000` | Initial exponential-backoff delay |
| `SUBSTACK_RETRY_MAX_DELAY_MS` | `60000` | Maximum wait for one retry |
| `SUBSTACK_VALIDATE` | `lenient` | `lenient` \| `strict` \| `off` |
| `SUBSTACK_DEBUG` | `0` | Log every upstream request |

### On `SUBSTACK_VALIDATE`

Default is **`lenient`**: responses are validated against Zod schemas, mismatches
are logged once to stderr, and the data is returned regardless. This is
deliberate. The upstream is undocumented and changes without notice — breaking a
running script because Substack added a field would be the wrong trade.

Use `strict` in CI to catch drift early. Every upstream schema is a
`z.looseObject`, so undocumented fields survive rather than being stripped.

## Project layout

```
src/
  client/
    http.ts            transport: concurrency, retries, HTML-404 detection, cookies
    config.ts          config resolution, cookie normalisation
    errors.ts          typed error hierarchy
    client.ts          composed client
    resources/         profiles, notes, publications, discovery
  schemas/             Zod schemas -> types + OpenAPI
  server/
    app.ts             Fastify + Swagger UI + error mapping
    openapi.ts         Zod -> OpenAPI, example rendering
    routes/            one module per resource
docs/UPSTREAM.md       verified endpoint reference + dead ends
examples/              runnable per-resource demos
scripts/smoke.ts       live route sweep
tests/                 transport + config unit tests
```

## Testing

```bash
npm test          # fast, offline, injected fetch
npm run smoke     # live, hits real Substack
```

Unit tests cover the parts most likely to break something quietly: cookie
precedence (including `null` meaning force-anonymous), HTML-404 translation,
retry ceilings, `Retry-After`, shared 429 cooldowns, timeout classification, all
three validation modes, and the concurrency gate.

`npm run smoke` is the one that catches upstream drift, since schema mismatches
and removed endpoints only show up against real data. It reports `WARN` for
suspicious-but-successful responses so silent degradation cannot pass as green.

## Docs site

[`site/`](site/) is a two-file static reference — a landing page and a
[Scalar](https://scalar.com) rendering of the OpenAPI document. On every push to
`main`, [`.github/workflows/pages.yml`](.github/workflows/pages.yml) typechecks,
tests, regenerates `openapi.json`, and deploys to GitHub Pages. Nothing generated
is committed.

## License

[MIT](LICENSE). Unaffiliated with Substack — this consumes undocumented endpoints
that can change or disappear without notice.
