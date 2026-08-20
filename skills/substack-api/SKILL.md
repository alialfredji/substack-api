---
name: substack-api
description: Query Substack's public read-only API through a scriptable JSON CLI. Use when an agent needs Substack profiles, profile searches, public subscription graphs, note feeds, note reactors, publications, post archives, comments, recommendations, related publications, categories, or leaderboards; when it needs to discover or inspect the available Substack API routes; or when it needs to combine these calls into research and targeting workflows.
---

# Substack API

Use the bundled launcher, resolved relative to this `SKILL.md`, to discover and invoke every documented route. It returns JSON and runs the gateway in-process, so do not start a server or use browser automation for data the API already exposes.

## Workflow

1. Discover matching routes when the correct path is uncertain:

   ```bash
   scripts/substack-api routes profiles
   scripts/substack-api routes reactors
   ```

2. Inspect a route only when its full schema or detailed description is needed:

   ```bash
   scripts/substack-api describe '/profiles/{handle}'
   ```

3. Use `call` for one page or one unpaginated response:

   ```bash
   scripts/substack-api call '/profiles/alialfredji'
   scripts/substack-api call '/profiles/search?query=ai%20engineer&page=0'
   scripts/substack-api call '/discovery/categories/technology/leaderboard?page=0'
   ```

4. Use `collect` when the user needs more than the first page. Always give it
   finite bounds:

   ```bash
   scripts/substack-api collect '/profiles/search?query=ai%20engineer' \
     --limit 100 \
     --max-pages 10
   ```

   `collect` recognizes page-, cursor-, and offset-paginated routes. Its JSON
   envelope contains `items`, `count`, `pagesFetched`, `exhausted`, and
   `continuation`. When a bound stops the walk before upstream exhaustion,
   `continuation` contains `{ parameter, value }` for resuming the route.
   Unpaginated routes are rejected.

   Requests are politely paced by default. HTTP 429, transient 5xx, and network
   errors use bounded exponential backoff; `Retry-After` pauses queued requests
   too. If the retry ceiling is reached, stop and report the error rather than
   immediately restarting the same collection.

5. Parse the returned JSON and present only the fields or conclusions relevant
   to the user's request.

Add `--pretty` only when human-readable output is useful. Add `--anonymous` to a
`call` or `collect` to ignore any configured cookie for that invocation.

## Pagination

Substack has no uniform pagination contract:

| Strategy | Collections |
|---|---|
| `page` | Profile search, publication search, category leaderboards |
| `nextCursor` | Profile Notes, suggested Notes |
| `offset` + `limit` | Publication archives |
| None known | Note reactors, comments, recommendations, categories |

Never invent pagination parameters for an unpaginated route. Stop if a
continuation value or page repeats, even when the upstream response claims more
data exists.

For a 100-prospect workflow, do not expect one profile query to produce 100
results. Run several adjacent keyword queries with bounded `collect` calls,
merge their `items`, and deduplicate by profile `id` before filtering or
scoring. Substack search is keyword-ranked rather than a complete directory, so
report the number actually found instead of claiming exhaustive coverage.

## Authentication

All routes work anonymously. Set `SUBSTACK_COOKIE` in the environment only when viewer-relative fields such as subscription or following state must be accurate. Treat it as a password: never print it, include it in a command argument, commit it, or expose it in the response.

`unsubscribedOnly=true` requires authentication because anonymous reactor records report subscription state as false.

## Interpretation Rules

- Treat the API as unofficial, read-only, and subject to upstream drift.
- Do not claim that an empty publication search proves there are no matches;
  this endpoint can transiently return empty results with no `more` field when
  throttled. The collector retries that degraded response once in addition to
  transport-level HTTP retries, then reports the search as inconclusive if it
  remains empty.
- Do not promise follower or following enumeration; Substack exposes no such public endpoint.
- Do not assume a requested collection `limit` controls upstream page size. It
  caps the returned aggregate. Profile search, publication search, and
  leaderboards use upstream-fixed page sizes; archives honor their page
  `limit`.
- Dedupe publication-search pages by publication id because ranked pages can
  overlap.
- Do not assume reaction counts equal the number of returned reactors.
- Treat empty gated comment threads as inconclusive rather than proof that no comments exist.
- Keep request volume polite, retain the conservative pacing defaults, and
  avoid unbounded enumeration. Do not bypass a final 429 by immediately
  restarting the command.

## Runtime

Require Node.js 24 or newer. By default, the launcher invokes the published `@alialf/substack-api@0.1.0` package through `npx`.

Before the npm package is published, or when developing locally, set `SUBSTACK_API_DIR` to the repository checkout. Set `SUBSTACK_API_PACKAGE` to test another published version.
