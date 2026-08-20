# Substack's undocumented API: what is actually there

Everything below was verified against the live API by direct probing, not taken
from documentation — there is no documentation. Dates matter for a surface like
this: **core endpoints verified 2026-08-17; pagination rechecked 2026-08-20**.
Treat anything here as liable to change without notice.

Negative results are recorded deliberately. Knowing that `/api/v1/comment/{id}/restacks`
returns 404 saves the next person an afternoon.

---

## 1. Rate limits

There are none published. Different routes and traffic patterns behave
differently, so a successful burst test must not be treated as proof that
collection is unthrottled.

Measured: 600 requests to `/api/v1/user/{handle}/public_profile`, in three
fully-concurrent bursts of 200.

| Burst | Requests | Wall time | Result |
|-------|----------|-----------|--------|
| A | 200 | 742 ms | 200 × HTTP 200 |
| B | 200 | 607 ms | 200 × HTTP 200 |
| C | 200 | 468 ms | 200 × HTTP 200 |

- No `429` responses in that specific profile-read burst.
- No `Retry-After` header, ever.
- No `X-RateLimit-*` headers of any kind.
- No `cf-mitigated` header.
- Response headers present: `server: cloudflare`, `x-served-by: Substack`,
  `cf-cache-status: DYNAMIC`, `cf-ray: …`.

**The correct conclusion is not "rate limits are generous".** Later paginated
collection produced real HTTP 429 responses. Treat throttling as route-, IP-,
and traffic-pattern-dependent rather than assuming one global policy.

### 1a. The trap: silent degradation instead of 429

`/api/v1/publication/search` does throttle — it just never tells you. Under
light, ordinary use it starts returning `200 OK` with `{"results": []}` for a
query that returned 18 results seconds earlier. No `429`, no error field, no
header. It recovers on its own, typically within seconds.

This was observed twice independently: once after roughly a dozen calls over a
few minutes, and once mid-way through the route smoke test.

The reason this is dangerous rather than merely annoying: **an empty result is
indistinguishable from "no matches" unless you know the endpoint's real
behaviour.** A targeting script that treats empty as authoritative will silently
conclude a niche has no publications in it.

Two discriminators, both verified:

- A genuinely unmatched query is *never* empty. `query=zzqqxvbnmlkjhgfd`
  returned **8** fuzzy matches with `more: false`. Substack's search always
  reaches for something. So `results: []` on `publication/search` effectively
  always means degradation, not absence.
- In the degraded state the `more` key is reported **absent entirely**, versus
  `more: false` on a legitimate small result set.

Practical rule: **treat an empty `publication/search` result as a retry signal,
not a result.** `npm run smoke` flags this as `WARN` rather than passing it
green, precisely so it cannot hide.

Root-host search is the only endpoint seen to do this. Publication-scoped
endpoints (`archive`, `comments`, `recommendations`) and `profile/search` kept
working normally throughout both episodes.

This client therefore defaults to concurrency `1` and a `250 ms` minimum gap.
HTTP 429, transient 5xx, and network failures receive up to four retries with
exponential backoff. `Retry-After` accepts seconds or an HTTP date, is capped at
60 seconds per retry, and establishes a shared cooldown for queued requests.
The final failed attempt throws; callers do not retry forever.

### 1b. Pagination is route-specific

Substack does not use a common pagination contract. The confirmed collection
routes fall into four groups:

| Strategy | Endpoint | Upstream behavior | Stop signal |
|---|---|---|---|
| Page | `profile/search` | 20 records per page; `limit` ignored | `more: false` |
| Page | `publication/search` | ~18–19 records per page; ranked pages can overlap; `limit` ignored | `more: false` |
| Page | `category/public/{id}/all` | 25 records per page; `limit` ignored | `more: false` |
| Cursor | `reader/feed/profile/{userId}` | Pass opaque `nextCursor` back unchanged | Missing `nextCursor` |
| Cursor | `reader/feed` | Pass opaque `nextCursor` back unchanged | Missing `nextCursor` |
| Offset | Publication-scoped `archive` | `limit` is honored; advance `offset` by the number returned | Empty or short batch |
| Unpaginated | Reactors, comments, recommendations, categories | `page`, `offset`, and/or `limit` do not expose another batch | Single response only |

Collectors must also stop if a page, cursor, or batch repeats. That guard is
important for an undocumented API where a nominal continuation field can drift
or become stale.

Three caveats found while confirming page-based routes:

- `publication/search` pages are **not cleanly disjoint** — page 0 and page 1
  shared 1 of 18 ids. It is a ranked search, not a stable cursor. **Dedupe by id
  when walking pages.**
- Leaderboard pagination is deep: category 4 (Technology) returned `more: true`
  for 15 consecutive pages (375 unique publications, zero repeats) with no sign
  of stopping. Any walk needs its own bound; `leaderboardAll()` caps at
  `maxPages` (default 20).

`profile/search` terminates honestly — `"ai engineer"` gave 86 results over 5
pages (20/20/20/20/6) and then `more: false`.

A single search query therefore cannot be assumed to yield 100 prospects. For a
100-person targeting workflow, run several adjacent keyword queries, bound each
walk, and dedupe across every result by profile id. This improves coverage; it
does not turn Substack's ranked search into a complete directory.

## 2. Authentication

Optional everywhere. No endpoint in this project requires it.

A cookie changes exactly one class of field: **viewer-relative** ones, which
answer "what is the relationship between the caller and this entity". Anonymous,
they are all `false`.

| Field | Where | Anonymous | With cookie |
|-------|-------|-----------|-------------|
| `is_subscribed` | note reactors | always `false` | correct |
| `is_following` | note reactors | always `false` | correct |
| `isSubscribed` | `public_profile` | always `false` | correct |
| `isFollowing` | `public_profile` | always `false` | correct |
| `followsViewer` | `public_profile` | always `false` | correct |

Cookie format: the `substack.sid` value, optionally alongside `substack.lli`.
Both a bare sid value and a full `Cookie` header string are accepted.

The consequence worth internalising: **a filter like "reactors who have not
subscribed" is meaningless without a cookie**, because every record reads
`is_subscribed: false`. This client throws `SubstackAuthRequiredError` rather
than returning a plausible-looking but worthless list.

## 3. Confirmed endpoints

All are `GET`. Base is `https://substack.com` unless the path is marked
*publication-scoped*, which means `https://{subdomain}.substack.com`.

### People

| Endpoint | Returns | Notes |
|---|---|---|
| `/api/v1/user/{handle}/public_profile` | profile object | Includes `subscriptions[]` — who this person subscribes to. |
| `/api/v1/profile/search?query={q}&page={n}` | `{ results, more }` | **Both params required.** Results are full profile objects, `subscriptions[]` included. |

`public_profile` verified top-level keys:

```
id, name, handle, previous_name, photo_url, bio, profile_set_up_at,
reader_installed_at, tos_accepted_at, profile_disabled, userLinks[],
publicationUsers[], theme{colors,fonts,wordmark}, subscriptions[],
subscriptionsTruncated, hasGuestPost, primaryPublication{}, max_pub_tier,
hasPosts, hasActivity, hasLikes, primaryPublicationPodcastTabInfo,
primaryPublicationChatEnabled, lists[], rough_num_free_subscribers_int,
rough_num_free_subscribers, bestseller_badge_disabled, bestseller_tier,
subscriberCountString, subscriberCount, subscriberCountNumber,
hasHiddenPublicationUsers, visibleSubscriptionsCount, followerCount, slug,
previousSlug, primaryPublicationIsPledged, primaryPublicationSubscriptionState,
isSubscribed, isFollowing, followsViewer, can_dm, subdomainUrl,
isPersonalEligible, status{bestsellerTier,subscriberTier,leaderboard,vip,badge,subscriber}
```

`subscriptions[]` entry: `user_id, id, visibility, membership_state, type,
is_founding, publication{…}`.

Omitting `page` from `profile/search` returns HTTP 400 with a genuinely useful
body — Substack validates params and names them:

```json
{"errors":[{"location":"query","param":"query","msg":"Invalid value"},
           {"location":"query","param":"page","msg":"Invalid value"}]}
```

### Notes

| Endpoint | Returns | Notes |
|---|---|---|
| `/api/v1/comment/{noteId}/reactors` | **bare array** | Who liked a note. Carries `is_subscribed` / `is_following`. |
| `/api/v1/reader/feed/profile/{userId}?types[]=note&cursor={cursor}` | `{ items, originalCursorTimestamp, nextCursor }` | One person's notes. Cursor-paginated. |
| `/api/v1/reader/feed?types[]=note&cursor={cursor}` | same + `trackingParameters` | Suggested feed. Cursor-paginated; anonymous returns cold-start picks. |
| `/api/v1/reader/comment/{noteId}` | `{ item }` | Single note. |

Reactor element: `id, name, photo_url, primary_publication, bestseller_tier,
status, is_subscribed, is_following, writes`.

Feed item: `entity_key, type, context, publication, post, comment,
parentComments, canReply, isMuted, trackingParameters, canShowFollowUpsell,
canShowCommentReveal`.

`item.context`: `type, timestamp, users, fallbackReason, fallbackUrl, isFresh,
source, page, page_rank`. **`context.users` is the "why am I seeing this"
signal** — the accounts that caused the item to surface.

`item.comment`: `name, handle, photo_url, id, body, body_json, publication_id,
post_id, user_id, type, date, edited_at, ancestor_path, reply_minimum_role,
media_clip_id, reaction_count, reactions, restacks, restacked, children_count,
attachments, user_bestseller_tier, userStatus, user_primary_publication,
language, autotranslate_to, is_ai_generated_text`.

`comment.reactions` is an emoji→count map, e.g. `{"❤": 6}`. There is no
per-user reaction data on the comment; `/reactors` is the only way to get it.

### Publications

| Endpoint | Returns | Notes |
|---|---|---|
| `/api/v1/publication/search?query={q}&page={n}` | `{ results, more }` | Ranked page search; pages can overlap. `limit` is ignored. |
| `/api/v1/post/search?query={q}&limit={n}` | `{ focused, results, resultsWithTrackingParams, more, publications }` | |
| `/api/v1/archive?sort=new&limit={n}&offset={n}` | **bare array** | *Publication-scoped.* Offset-paginated; `limit` is honored. |
| `/api/v1/recommendations/from/{publicationId}` | **bare array** | *Publication-scoped and unpaginated.* Which publications this one recommends. |
| `/api/v1/post/{postId}/comments?all_comments=true&sort=best_first` | comment tree | *Publication-scoped and unpaginated.* |

### Discovery

| Endpoint | Returns | Notes |
|---|---|---|
| `/api/v1/categories` | **bare array**, 32 elements | Unpaginated. `id, created_at, updated_at, name, canonical_name, active, rank, parent_tag_id, slug, emoji` |
| `/api/v1/category/public/{categoryId}/all?page=0` | `{ publications, more, title }` | 25 per page. The leaderboard. |

## 4. Confirmed dead ends

Every one of these returns **HTTP 404 with a ~68 KB HTML page**, not a JSON
error. Recorded so nobody re-probes them.

```
/api/v1/user/{userId}/following
/api/v1/user/{userId}/followers
/api/v1/user/{userId}/subscribers
/api/v1/user/{userId}/public_subscriptions
/api/v1/profile/{userId}/followers
/api/v1/reader/profile/{userId}/followers
/api/v1/comment/{noteId}/reactions
/api/v1/comment/{noteId}/likes
/api/v1/comment/{noteId}/likers
/api/v1/comment/{noteId}/restacks
/api/v1/comment/{noteId}/reaction/users
/api/v1/reader/comment/{noteId}/reactions
/api/v1/reader/comment/{noteId}/reactors
/api/v1/reader/comment/{noteId}/likes
/api/v1/notes/{noteId}/reactions
/api/v1/reaction/comment/{noteId}
/api/v1/recommendations/for-user/{userId}
/api/v1/recommendations/writers
/api/v1/reader/recommendations
/api/v1/publication/{publicationId}/recommendations   <- use the publication subdomain instead
/api/v1/search
/api/v1/discover/search
```

Two structural facts follow from this list:

1. **There is no public follower or following enumeration.** You cannot list who
   follows an account.
2. **Recommendations are only served from a publication's own subdomain.** The
   `substack.com`-hosted variant does not exist.

## 4a. Additional confirmed behaviours

### The id → handle bridge (load-bearing)

`public_profile` accepts **only a handle**. There is no by-id variant — verified
404 for `/api/v1/user/{id}/public_profile`, `/api/v1/profile/{slug}` and
`/api/v1/user/{handle}/profile`.

But note reactors identify people by **numeric id with no handle**. So the whole
"who liked my note → what do they subscribe to" path would dead-end, except:

```
GET https://substack.com/profile/{userId}   ->  301
Location: https://substack.com/@{handle}
```

Verified `86433889 → alialfredji` and `491472156 → sandytidereadings`. The
`{id}-{name-slug}` form redirects identically. An unknown id returns 404 with no
`Location`. `https://substack.com/@{numericId}` does **not** work — it 302s to a
search page.

This is exposed as `profiles.resolveHandle(userId)` / `getByUserId(userId)`, and
costs two upstream requests (cached per client).

### Posts

- `GET /api/v1/posts/{slug}` (publication-scoped) **works** — 200, full body
  including `body_html`, ~73 fields.
- `GET /api/v1/post/{id}` and `/api/v1/posts/id/{id}` are both 404. **There is no
  numeric post lookup**; slug is the only key.
- `GET /api/v1/publication` and `/api/v1/publication/settings` on a subdomain
  return **403 "Not authorized"** — they exist but need auth. Not wrapped here,
  since the authenticated shape is unverified.
- No subscriber-count endpoint exists (`/publication/{id}/subscriber_count`,
  `/subscriptions/count` both 404). Use the `rough_num_free_subscribers*` fields
  already present on publication objects.

### `post/search` appears to be dead

The envelope is real (`focused, results, resultsWithTrackingParams, more,
publications`) but every one of **15 distinct queries** returned all-empty:
`ai, startup, writing, productivity, money, the, newsletter, bitcoin, climate,
recipe, platformer, substack`, and others. Status is always 200. It is wrapped
for completeness, but treat it as non-functional and use
`publication/search` instead.

### Comment threads are gated, comment counts are not

`comment_count` on an archive listing is public, but reading the thread often is
not. `astralcodexten`, `noahpinion` and `slowboring` posts all returned **empty
comment arrays despite counts in the hundreds**. `platformer` (free, unpaywalled)
returned full threads including real nested `children`.

So: an empty comments array does not mean an uncommented post. Verify against a
free publication before concluding the endpoint is broken.

Comment envelope is `{ comments: [], automod_hidden_comments: [] }`. Replies nest
under `children`, arbitrarily deep in principle (2 levels observed).

### Notes: reactors

No pagination. `limit`, `offset` and `page` are all accepted and all ignored —
every variant returns the identical full array. The list simply grows as the note
gains reactions (the same fixture note returned 5 reactors, then 8 later), so it
is not capped, just unpaginated.

`reaction_count` can exceed `reactors.length` — likely deactivated accounts whose
like still counts in the aggregate. Do not assume the two agree.

`types[]` accepts `note`, `comment`, `post`, `like`, `restack`, and multiple
values combine rather than last-wins. `nextCursor` genuinely advances (the
decoded token's `page_number` increments).

`context.users` — the "why am I seeing this" signal — was **empty on profile
feeds** in every case tested, and **populated only on the suggested feed**
(`/api/v1/reader/feed`). If you want connective/suggested people, the suggested
feed is the only source.

### Discovery / categories

- 32 top-level categories, each with `subcategories` pre-nested (206 children
  total). The hierarchy is real: every top-level entry has `parent_tag_id: null`
  and every child points back at its parent.
- **One category has a string id**: `{id: "podcast", name: "Podcasts"}`. All 31
  others and all 206 subcategories are numeric. Critically, `"podcast"` is a
  *working* leaderboard id (200, 25 publications) — so it is a real id, not bad
  data. Typing category ids as `number` breaks serialisation.
- A **slug** in the leaderboard path is a 400, not a 404:
  `{"location":"params","param":"id","value":"technology","msg":"Invalid value"}`.
  Slug and name resolution is therefore entirely client-side.
- The path segment after the id is **not validated at all** — `all`, `top`,
  `rising`, `bestsellers` and literal garbage all return identical data. There is
  no separate top/rising/bestsellers endpoint.
- `type=paid|free|newsletter|<garbage>` is accepted and has **zero effect**
  (identical id lists, diffed byte-for-byte).
- An invalid numeric category id returns `200` with `{publications: [], more:
  false}` and no `title` key — not a 404.

## 5. The thing people expect and cannot have

**Subscriber lists are not exposed.** Not by the API, not by the UI, not at all.
That list is the asset Substack sells to writers. You can read counts
(`subscriberCount`, `rough_num_free_subscribers_int`) and nothing more.

The useful inversion: `subscriptions[]` on a *profile* is public. So while you
cannot ask *"who subscribes to publication X"*, you can ask, for any given
person, *"what does this person subscribe to"* — and get the full visible list.
Harvest candidates from public engagement surfaces, then score each by
subscription overlap. That is the query the API actually supports.

## 6. Why there are no write endpoints

This project is read-only on purpose, and the reasoning is operational rather
than decorative.

Reads are anonymous and IP-scoped by default, but can still be throttled. No
account is attached unless the caller explicitly configures a cookie.

Writes are the opposite. Automating subscribe / follow / like / comment means
sending `substack.sid` — your account — at machine speed, to paths under
`/action/` that `robots.txt` explicitly disallows:

```
User-agent: *
Disallow: /action/
Disallow: /subscribe
Disallow: /p/*/comment/*
Disallow: /inbox
```

And it lands squarely on the Terms of Use clause aimed at exactly this:

> Runs Maillist, Listserv, any form of auto-responder or "spam" on Substack, **or
> any processes that run or are activated while you are not logged into
> Substack**, or that otherwise interferes with the proper working of Substack

with enforcement that is discretionary and unappealable:

> Failure to follow any of these Terms shall constitute a breach of these Terms,
> which may result in immediate termination of your account. Substack has the
> sole right to decide whether you are in violation.

Note also that the ToS bans crawling outright, with no public-data carve-out:

> "Crawls," "scrapes," or "spiders" any page, data, or portion of Substack
> (through use of manual or automated means)

So the asymmetry to exploit is: **automate the targeting, perform the engagement
as a human.** Building a ranked list from anonymous reads carries little
account risk. Driving clicks through a browser at human pace carries little
either. Bolting the two together with your session cookie is the part that gets
accounts terminated.
