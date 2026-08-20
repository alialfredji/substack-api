/**
 * Demonstrates every `ProfilesResource` method against the live Substack API.
 *
 * Run: npx tsx examples/profiles.ts
 *
 * No cookie required — everything here works anonymously. Set SUBSTACK_COOKIE
 * in your environment first if you want to see `isSubscribed`/`isFollowing`
 * resolve to real values instead of `false`.
 */

import { createSubstackClient } from '../src/client/client.js';

const substack = createSubstackClient();

async function main(): Promise<void> {
  // getByHandle: a single profile, with its subscription graph attached.
  const profile = await substack.profiles.getByHandle('alialfredji');
  console.log(
    `getByHandle: ${profile.name} (@${profile.handle}) — ${profile.subscriptions?.length ?? 0} subscriptions, ` +
      `${profile.followerCount ?? 0} followers`,
  );

  // getSubscriptions: just the subscriptions array, for a person who has some.
  const subs = await substack.profiles.getSubscriptions('aiebysdr');
  console.log(
    `getSubscriptions: aiebysdr subscribes to ${subs.length} publications — ` +
      subs.slice(0, 3).map((s) => s.publication.name).join(', '),
  );

  // search: one page of results, each a full profile with subscriptions.
  const page = await substack.profiles.search({ query: 'ai engineer', page: 0 });
  console.log(`search: ${page.results.length} results on page 0, more=${page.more}`);
  console.log('  top result:', page.results[0]?.name, `(@${page.results[0]?.handle})`);

  // searchAll: walk pages up to a bounded limit. One ranked query may exhaust
  // below a target such as 100, so combine adjacent queries and dedupe by id.
  const prospects = new Map<number, (typeof page.results)[number]>();
  for (const query of ['ai engineer', 'software architecture', 'developer tools']) {
    const matches = await substack.profiles.searchAll({ query, limit: 100, maxPages: 10 });
    console.log(`searchAll("${query}"): collected ${matches.length} profiles`);
    for (const match of matches) prospects.set(match.id, match);
  }
  console.log(`Cross-query prospect pool: ${prospects.size} unique profiles`);

  // resolveHandle / getByUserId: the id -> handle bridge. Note reactors only
  // carry a numeric id, so this is what connects "who liked my note" to
  // "what do they subscribe to". The second call reuses the id->handle cache.
  const handle = await substack.profiles.resolveHandle(86433889);
  console.log(`resolveHandle: user 86433889 -> @${handle}`);
  const byId = await substack.profiles.getByUserId(86433889);
  console.log(`getByUserId: @${byId.handle} (${byId.name}), ${byId.subscriptions?.length ?? 0} subscriptions`);

  // subscriptionOverlap: the actual use case — rank two people by shared reading.
  const overlap = await substack.profiles.subscriptionOverlap('aiebysdr', 'systemdesignone');
  console.log(
    `subscriptionOverlap: aiebysdr (${overlap.subscriptionCountA} subs) vs systemdesignone ` +
      `(${overlap.subscriptionCountB} subs) — ${overlap.overlapCount} shared, score=${overlap.score.toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error('Example failed:', error);
  process.exitCode = 1;
});
