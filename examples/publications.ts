/**
 * Runnable tour of the publications resource.
 *
 *   npx tsx examples/publications.ts
 *
 * Centrepiece is the realistic discovery flow at the bottom: search a niche,
 * pick a publication, walk its archive, and harvest commenters — the way
 * you'd actually go from "I want AI newsletters" to "here are real, engaged
 * people to look at."
 *
 * No cookie required; every call here works anonymously.
 */

import { createSubstackClient } from '../src/client/client.js';

const substack = createSubstackClient();

function log(label: string, value: unknown): void {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  // 1. Publication search. `limit` is accepted but Substack ignores it in
  // practice — expect a fixed-size batch regardless of the value you pass.
  const pubSearch = await substack.publications.search({ query: 'ai', limit: 10 });
  log('publications.search("ai") — first 3 of ' + pubSearch.results.length, {
    more: pubSearch.more,
    sample: pubSearch.results.slice(0, 3).map((p) => ({ id: p.id, name: p.name, subdomain: p.subdomain })),
  });

  // 2. Post search. Documented as unreliable: expect empty arrays.
  const postSearch = await substack.publications.searchPosts({ query: 'ai', limit: 5 });
  log('publications.searchPosts("ai")', {
    resultsCount: postSearch.results.length,
    focusedCount: postSearch.focused.length,
    note: postSearch.results.length === 0 ? '(empty is expected — see resources/publications.ts)' : undefined,
  });

  // 3. Archive: pick a real, low-traffic newsletter from our fixtures so this
  // stays fast and polite. `aieworks` is a fixture used throughout this module.
  const subdomain = 'aieworks';
  const archive = await substack.publications.archive(subdomain, { sort: 'new', limit: 5 });
  log(`publications.archive("${subdomain}") — ${archive.length} posts`, {
    sample: archive.map((p) => ({ id: p.id, slug: p.slug, title: p.title, comment_count: p.comment_count })),
  });

  // 4. Single post by slug.
  const firstSlug = archive[0]?.slug;
  if (firstSlug) {
    const post = await substack.publications.getPost(subdomain, firstSlug);
    log(`publications.getPost("${subdomain}", "${firstSlug}")`, {
      title: post.title,
      wordcount: post.wordcount,
      comment_count: post.comment_count,
    });
  }

  // 5. Comments + commenters. Small newsletters like `aieworks` typically have
  // zero comments, so this uses a free, high-traffic publication known (from
  // live testing) to return real threads without a cookie: `platformer`.
  const commentsSubdomain = 'platformer';
  const commentsPostId = 140489606; // "substack-says-it-will-remove-nazi" — 39 comments, verified live.
  const { comments, automod_hidden_comments } = await substack.publications.comments(commentsSubdomain, commentsPostId);
  log(`publications.comments("${commentsSubdomain}", ${commentsPostId})`, {
    topLevelCount: comments.length,
    automodHiddenCount: automod_hidden_comments?.length ?? 0,
    sample: comments.slice(0, 2).map((c) => ({ id: c.id, name: c.name, childrenCount: c.children?.length ?? 0 })),
  });

  const commenters = await substack.publications.commenters(commentsSubdomain, commentsPostId);
  log(`publications.commenters("${commentsSubdomain}", ${commentsPostId}) — ${commenters.length} unique people`, {
    sample: commenters.slice(0, 5),
  });

  // 6. Recommendation graph, from the fixture publication.
  const publicationId = 5081214; // aieworks
  const recs = await substack.publications.recommendations(subdomain, publicationId);
  log(`publications.recommendations("${subdomain}", ${publicationId}) — ${recs.length} edges`, {
    sample: recs.slice(0, 3).map((r) => ({
      id: r.id,
      recommends: r.recommendedPublication?.name,
      subdomain: r.recommendedPublication?.subdomain,
    })),
  });

  // 7. Related publications: BFS a couple of hops out, bounded.
  const related = await substack.publications.relatedPublications(subdomain, publicationId, {
    limit: 15,
    maxPages: 3,
  });
  log(`publications.relatedPublications("${subdomain}", ${publicationId}) — ${related.length} found`, {
    sample: related.slice(0, 5).map((r) => ({ name: r.publication.name, subdomain: r.publication.subdomain, distance: r.distance })),
  });

  // --- The realistic flow: niche -> publication -> archive -> commenters ---
  console.log('\n=== Discovery flow: find AI newsletters, then harvest real engaged people ===');
  const niche = await substack.publications.search({ query: 'ai' });
  const candidate = niche.results.find((p) => p.subdomain);
  if (candidate?.subdomain) {
    const posts = await substack.publications.archive(candidate.subdomain, { sort: 'top', limit: 5 });
    const withComments = posts.find((p) => (p.comment_count ?? 0) > 0);
    log(`Chose "${candidate.name}" (${candidate.subdomain})`, {
      topPosts: posts.map((p) => ({ slug: p.slug, comment_count: p.comment_count })),
    });
    if (withComments) {
      const people = await substack.publications.commenters(candidate.subdomain, withComments.id);
      log(`Commenters on "${withComments.slug}"`, { count: people.length, sample: people.slice(0, 5) });
    } else {
      console.log('(No post in this sample had comments — this niche flow depends on live data and will vary by run.)');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
