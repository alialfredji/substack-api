# Testing the engagement endpoints

This walkthrough uses the public `alialfredji` profile and its Modern Builder
publication. All commands work anonymously. Live counts can change, so verify
response shape and identity fields rather than asserting the example totals.

## 1. Install and verify the project

```bash
npm install
npm run typecheck
npm test
npm run spec
```

`npm run spec` writes the generated `openapi.json`. To browse and execute the
same routes interactively:

```bash
npm run serve
# Open http://127.0.0.1:3000/docs
```

## 2. Resolve the profile and recent content

```bash
npm run --silent cli -- call '/profiles/alialfredji' \
  | jq '{id, handle, publication: .primaryPublication | {id, name, subdomain}}'

npm run --silent cli -- collect '/notes/profile/86433889?types=note' \
  --limit 20 --max-pages 3 \
  | jq '{count, pagesFetched, exhausted, noteIds: [.items[].comment.id]}'

npm run --silent cli -- call '/publications/alialf/archive?sort=new&limit=10' \
  | jq 'map({id, publication_id, slug, reaction_count, restacks, comment_count})'
```

The fixtures used below are:

- Profile: `alialfredji`, user id `86433889`
- Publication: `alialf`, publication id `9341396`
- Note with likes, replies, and restacks: `337504999`
- Post with likes and replies: `213684376`
- Post with restacks: `207008579`

## 3. Test Note engagement

```bash
# Likes
npm run --silent cli -- call '/notes/337504999/reactors' \
  | jq 'map({id, name, writes})'

# Restacks
npm run --silent cli -- call '/notes/337504999/restackers' \
  | jq 'map({id, name, writes})'

# First reply page
npm run --silent cli -- call \
  '/notes/337504999/replies?publicationId=9341396' \
  | jq '{branches: (.commentBranches | length), nextCursor, people: [.commentBranches[].comment | {user_id, name, handle}]}'

# Bounded walk over every available reply page
npm run --silent cli -- collect \
  '/notes/337504999/replies?publicationId=9341396' \
  --limit 100 --max-pages 10 \
  | jq '{count, pagesFetched, exhausted}'
```

## 4. Test article engagement

```bash
# Small UI preview; do not treat this as the complete list
npm run --silent cli -- call \
  '/publications/alialf/posts/213684376/facepile' \
  | jq '{reactors: (.reactors | length), restackers: (.restackers | length)}'

# Full upstream identity lists
npm run --silent cli -- call \
  '/publications/alialf/posts/213684376/reactors' \
  | jq 'map({id, name, writes})'

npm run --silent cli -- call \
  '/publications/alialf/posts/207008579/restackers' \
  | jq 'map({id, name, writes})'

# First modern replies page
npm run --silent cli -- call \
  '/publications/alialf/posts/213684376/replies?publicationId=9341396' \
  | jq '{branches: (.commentBranches | length), nextCursor}'

# Bounded cursor walk
npm run --silent cli -- collect \
  '/publications/alialf/posts/213684376/replies?publicationId=9341396' \
  --limit 100 --max-pages 10 \
  | jq '{count, pagesFetched, exhausted}'
```

The legacy post comment tree remains available at:

```bash
npm run --silent cli -- call \
  '/publications/alialf/posts/213684376/comments?allComments=true&sort=best_first' \
  | jq '{topLevelComments: (.comments | length)}'
```

## 5. Use the typed client

```ts
import { createSubstackClient } from '@alialf/substack-api';

const substack = createSubstackClient();

const noteId = 337504999;
const publicationId = 9341396;

const [noteReactors, noteRestackers, noteReplies] = await Promise.all([
  substack.notes.reactors(noteId),
  substack.notes.restackers(noteId),
  substack.notes.collectReplies(noteId, {
    publicationId,
    limit: 100,
    maxPages: 10,
  }),
]);

const [postReactors, postRestackers, postReplies] = await Promise.all([
  substack.publications.reactors('alialf', 213684376),
  substack.publications.restackers('alialf', 207008579),
  substack.publications.collectReplies('alialf', 213684376, {
    publicationId,
    limit: 100,
    maxPages: 10,
  }),
]);

console.log({
  noteReactors: noteReactors.length,
  noteRestackers: noteRestackers.length,
  noteReplyBranches: noteReplies.length,
  postReactors: postReactors.length,
  postRestackers: postRestackers.length,
  postReplyBranches: postReplies.length,
});

await substack.close();
```

For a large scan, put all calls behind one shared limiter. At 50 request starts
per minute, a complete content item costs at least three requests (reactors,
restackers, replies), so the practical ceiling is roughly 16 items per minute
before extra reply pages or profile enrichment.

## Interpretation

- `facepile` is deliberately preview-sized.
- Aggregate reaction and restack counts can exceed enumerated identities.
- Keep both `reportedCount` and `enumeratedCount`; the identity list is a lower
  bound.
- A reply page contains top-level `commentBranches`; nested replies are in each
  branch's `descendantComments`.
- Empty comments on a post with a non-zero public count can mean the thread is
  gated. Do not report that as “no engagement.”
