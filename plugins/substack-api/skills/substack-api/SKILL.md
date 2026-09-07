---
name: substack-api
description: Query Substack's public read-only API for profiles, public networks, notes, publications, archives, comments, recommendations, categories, and leaderboards.
---

# Substack API

Use the plugin's MCP tools for live Substack research. The service is unofficial, read-only, and anonymous; never claim it can follow, subscribe, react, comment, or publish.

## Workflow

1. Call `list_routes` with a topic filter when the right route is uncertain.
2. Call `describe_route` only when you need a route's complete parameters or response documentation.
3. Call `call_route` for one page or an unpaginated response.
4. Call `collect_route` for paginated research, always with finite `limit` and `maxPages` values.
5. Summarize only the fields and conclusions relevant to the user's request.

Profile search, publication search, category leaderboards, profile and suggested Note feeds, and publication archives support bounded collection. Subscriber, follower, following, reactor, comment, recommendation, and category routes are unpaginated; do not invent pagination parameters for them.

Substack search is keyword-ranked rather than exhaustive. For broad prospecting, run several adjacent queries, merge the results, deduplicate by profile or publication ID, and report how many records were actually found.

Treat empty publication searches and gated comment threads as inconclusive when the tool reports upstream throttling or access limitations. Do not immediately retry final rate-limit errors, and keep request volume polite.
