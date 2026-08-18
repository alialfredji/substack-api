/**
 * Runnable demo of the discovery resource: list categories, resolve one by
 * name, pull its leaderboard, and print the "find publications like mine"
 * shortlist — the reason this module exists.
 *
 *   npx tsx examples/discovery.ts
 */

import { createSubstackClient } from '../src/client/client.js';

const substack = createSubstackClient();

async function main(): Promise<void> {
  const categories = await substack.discovery.categories();
  console.log(`categories(): ${categories.length} top-level categories`);
  for (const c of categories.slice(0, 5)) {
    console.log(`  ${c.id}\t${c.name}\t(${c.slug}, ${c.subcategories?.length ?? 0} subcategories)`);
  }

  const tree = await substack.discovery.categoryTree();
  const withChildren = tree.filter((node) => node.children.length > 0);
  console.log(`\ncategoryTree(): ${tree.length} parents, ${withChildren.length} with subcategories`);

  const target = await substack.discovery.findCategory('technology');
  console.log(`\nfindCategory('technology') -> id=${target.id} name=${target.name} slug=${target.slug}`);

  const page = await substack.discovery.leaderboard(target.id, { page: 0 });
  console.log(`\nleaderboard(${target.id}, { page: 0 }): title=${JSON.stringify(page.title)} more=${page.more} count=${page.publications.length}`);
  console.log('Top publications like your niche:');
  for (const pub of page.publications.slice(0, 5)) {
    const domain = pub.custom_domain ?? pub.subdomain ?? 'no domain';
    const freeSubs = pub.rough_num_free_subscribers_int ?? pub.rough_num_free_subscribers ?? '?';
    console.log(`  - ${pub.name} (${domain}) ~${freeSubs} free subscribers`);
  }

  const top50 = await substack.discovery.leaderboardAll(target.id, { limit: 50, maxPages: 3 });
  console.log(`\nleaderboardAll(${target.id}, { limit: 50, maxPages: 3 }): fetched ${top50.length} publications`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
