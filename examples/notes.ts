/**
 * Demonstrates every `NotesResource` method against the live Substack API.
 *
 * Run: npx tsx examples/notes.ts
 *
 * Most of this works anonymously. The centrepiece — `unsubscribedReactors`,
 * "who liked my note but hasn't subscribed to me" — needs a real session
 * cookie, because `is_subscribed`/`is_following` are viewer-relative and read
 * `false` for everyone without one. Set SUBSTACK_COOKIE in your environment
 * (see .env.example) to see it do something real instead of throwing
 * SubstackAuthRequiredError.
 */

import { createSubstackClient } from '../src/client/client.js';

const substack = createSubstackClient();

const USER_ID = 86433889; // alialfredji
const NOTE_ID = 314595743; // has 6 reactions but only 5 reactors — see schemas/note.ts

async function main(): Promise<void> {
  // listByProfile: a profile's own notes, cursor-paginated.
  const profileFeed = await substack.notes.listByProfile(USER_ID);
  console.log(
    `listByProfile: ${profileFeed.items.length} items, nextCursor=${profileFeed.nextCursor ? 'present' : 'none'}`,
  );

  // listByProfile with types: same call, but restack activity instead of notes.
  const restacks = await substack.notes.listByProfile(USER_ID, { types: ['restack'] });
  console.log(`listByProfile (types=restack): ${restacks.items.length} items`);

  // listSuggested: the cold-start feed, plus its tracking telemetry.
  const suggested = await substack.notes.listSuggested();
  console.log(
    `listSuggested: ${suggested.items.length} items, followedUserCount=` +
      `${suggested.trackingParameters?.followed_user_count ?? 'n/a'}`,
  );

  // contextUsers: the "why this surfaced" people, deduped across a page.
  // Populated on the suggested feed; a profile's own feed reliably comes back empty.
  const people = substack.notes.contextUsers(suggested);
  console.log(`contextUsers: ${people.length} distinct accounts —`, people.slice(0, 3).map((p) => p.name));

  // get: a single note by id.
  const note = await substack.notes.get(NOTE_ID);
  console.log(
    `get: note ${NOTE_ID} by ${note.comment?.name} — reaction_count=${note.comment?.reaction_count}, ` +
      `body="${note.comment?.body?.slice(0, 60)}..."`,
  );

  // reactors: everyone who liked it. No working pagination — this is the full list.
  const reactors = await substack.notes.reactors(NOTE_ID);
  console.log(`reactors: ${reactors.length} accounts (reaction_count said ${note.comment?.reaction_count})`);

  // collectProfileNotes: walk every page up to a bounded limit.
  const collected = await substack.notes.collectProfileNotes(USER_ID, { limit: 30, maxPages: 5 });
  console.log(`collectProfileNotes: collected ${collected.length} items across up to 5 pages`);

  // collectSuggestedNotes: the same bounded cursor walk over the suggested
  // feed. `types` is preserved on every request.
  const suggestedCollected = await substack.notes.collectSuggestedNotes({
    types: ['note'],
    limit: 30,
    maxPages: 5,
  });
  console.log(`collectSuggestedNotes: collected ${suggestedCollected.length} items across up to 5 pages`);

  // --- The centrepiece: who liked this note but never subscribed? ---
  //
  // Needs a session cookie — without one, is_subscribed reads false for every
  // reactor and this call throws SubstackAuthRequiredError rather than
  // returning a list that looks meaningful but isn't.
  if (substack.authenticated) {
    const cold = await substack.notes.unsubscribedReactors(NOTE_ID);
    console.log(
      `unsubscribedReactors: ${cold.length} of ${reactors.length} reactors on note ${NOTE_ID} have not subscribed —`,
      cold.map((r) => r.name),
    );
  } else {
    console.log(
      'unsubscribedReactors: skipped — set SUBSTACK_COOKIE to see real results ' +
        '(anonymous calls throw SubstackAuthRequiredError, on purpose).',
    );
  }
}

main().catch((error) => {
  console.error('Example failed:', error);
  process.exitCode = 1;
});
