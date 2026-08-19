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

3. Replace path parameters, URL-encode query values, and invoke the concrete path:

   ```bash
   scripts/substack-api call '/profiles/alialfredji'
   scripts/substack-api call '/profiles/search?query=ai%20engineer&page=0'
   scripts/substack-api call '/discovery/categories/technology/leaderboard?page=0'
   ```

4. Parse the returned JSON and present only the fields or conclusions relevant to the user's request. Use multiple calls for multi-step research workflows.

Add `--pretty` only when human-readable output is useful. Add `--anonymous` to a `call` to ignore any configured cookie for that invocation.

## Authentication

All routes work anonymously. Set `SUBSTACK_COOKIE` in the environment only when viewer-relative fields such as subscription or following state must be accurate. Treat it as a password: never print it, include it in a command argument, commit it, or expose it in the response.

`unsubscribedOnly=true` requires authentication because anonymous reactor records report subscription state as false.

## Interpretation Rules

- Treat the API as unofficial, read-only, and subject to upstream drift.
- Do not claim that an empty publication search proves there are no matches; this endpoint can transiently return empty results when throttled. Retry once after a short pause.
- Do not promise follower or following enumeration; Substack exposes no such public endpoint.
- Do not assume a requested `limit` controls upstream page size. Use the documented pagination parameters and bound multi-page work.
- Do not assume reaction counts equal the number of returned reactors.
- Treat empty gated comment threads as inconclusive rather than proof that no comments exist.
- Keep request volume polite and avoid unbounded enumeration.

## Runtime

Require Node.js 24 or newer. By default, the launcher invokes the published `@alialf/substack-api@0.1.0` package through `npx`.

Before the npm package is published, or when developing locally, set `SUBSTACK_API_DIR` to the repository checkout. Set `SUBSTACK_API_PACKAGE` to test another published version.
