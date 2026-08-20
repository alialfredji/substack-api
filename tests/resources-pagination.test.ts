import { describe, expect, it, vi } from 'vitest';
import type { SubstackHttp } from '../src/client/http.js';
import { ProfilesResource } from '../src/client/resources/profiles.js';
import { PublicationsResource } from '../src/client/resources/publications.js';
import { NotesResource } from '../src/client/resources/notes.js';
import { DiscoveryResource } from '../src/client/resources/discovery.js';
import type { Profile } from '../src/schemas/profile.js';
import type { Publication } from '../src/schemas/common.js';
import type { Post } from '../src/schemas/post.js';
import type { NoteFeedItem, NoteFeedPage } from '../src/schemas/note.js';
import type { LeaderboardPage } from '../src/schemas/discovery.js';

const profile = (id: number): Profile => ({ id, name: `Profile ${id}`, handle: `profile-${id}` });
const publication = (id: number): Publication => ({ id, name: `Publication ${id}`, subdomain: `pub-${id}` });
const post = (id: number): Post => ({ id, publication_id: 1, slug: `post-${id}` });
const item = (id: number): NoteFeedItem => ({
  entity_key: `c-${id}`,
  type: 'comment',
  context: { type: 'note', timestamp: '2026-08-20T00:00:00Z' },
});
const feedPage = (ids: number[], nextCursor?: string): NoteFeedPage => ({
  items: ids.map(item),
  nextCursor,
});

describe('profile pagination', () => {
  it('deduplicates ids and stops when a page repeats', async () => {
    const resource = new ProfilesResource({} as SubstackHttp);
    vi.spyOn(resource, 'search')
      .mockResolvedValueOnce({ results: [profile(1), profile(2)], more: true })
      .mockResolvedValueOnce({ results: [profile(2), profile(3)], more: true })
      .mockResolvedValueOnce({ results: [profile(2), profile(3)], more: true });

    const result = await resource.searchAll({ query: 'ai', limit: 10, maxPages: 10 });

    expect(result.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(resource.search).toHaveBeenCalledTimes(3);
  });
});

describe('publication pagination', () => {
  it('deduplicates search pages and obeys the total limit', async () => {
    const resource = new PublicationsResource({} as SubstackHttp);
    vi.spyOn(resource, 'search')
      .mockResolvedValueOnce({ results: [publication(1), publication(2)], more: true })
      .mockResolvedValueOnce({ results: [publication(2), publication(3)], more: true });

    const result = await resource.searchAll({ query: 'engineering', limit: 3, maxPages: 5 });

    expect(result.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(resource.search).toHaveBeenCalledTimes(2);
  });

  it('retries the degraded empty shape once and throws if it persists', async () => {
    const resource = new PublicationsResource({} as SubstackHttp);
    vi.spyOn(resource, 'search').mockResolvedValue({ results: [] });

    await expect(resource.searchAll({ query: 'engineering', limit: 10, maxPages: 2 })).rejects.toThrow(
      /empty response without a 'more' field twice/,
    );
    expect(resource.search).toHaveBeenCalledTimes(2);
  });

  it('recovers when the one degraded response is followed by a real page', async () => {
    const resource = new PublicationsResource({} as SubstackHttp);
    vi.spyOn(resource, 'search')
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [publication(1)], more: false });

    await expect(resource.searchAll({ query: 'engineering', limit: 10, maxPages: 2 })).resolves.toEqual([
      publication(1),
    ]);
  });

  it('walks archive offsets with page size, sort, deduplication, and a total limit', async () => {
    const resource = new PublicationsResource({} as SubstackHttp);
    const archive = vi.spyOn(resource, 'archive')
      .mockResolvedValueOnce([post(1), post(2)])
      .mockResolvedValueOnce([post(2), post(3)]);

    const result = await resource.archiveAll('example', {
      limit: 3,
      maxPages: 5,
      pageSize: 2,
      sort: 'top',
    });

    expect(result.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(archive.mock.calls.map((call) => call[1])).toEqual([
      { limit: 2, offset: 0, sort: 'top' },
      { limit: 1, offset: 2, sort: 'top' },
    ]);
  });
});

describe('note feed pagination', () => {
  it('collects profile notes with types, deduplication, and cursor-cycle protection', async () => {
    const resource = new NotesResource({} as SubstackHttp);
    const list = vi.spyOn(resource, 'listByProfile')
      .mockResolvedValueOnce(feedPage([1, 2], 'cursor-a'))
      .mockResolvedValueOnce(feedPage([2, 3], 'cursor-b'))
      .mockResolvedValueOnce(feedPage([3, 4], 'cursor-a'));

    const result = await resource.collectProfileNotes(42, {
      types: ['note', 'restack'],
      limit: 10,
      maxPages: 10,
    });

    expect(result.map(({ entity_key }) => entity_key)).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
    expect(list.mock.calls.map((call) => call[1])).toEqual([
      { cursor: undefined, types: ['note', 'restack'] },
      { cursor: 'cursor-a', types: ['note', 'restack'] },
      { cursor: 'cursor-b', types: ['note', 'restack'] },
    ]);
  });

  it('collects and deduplicates suggested notes', async () => {
    const resource = new NotesResource({} as SubstackHttp);
    vi.spyOn(resource, 'listSuggested')
      .mockResolvedValueOnce(feedPage([1, 2], 'next'))
      .mockResolvedValueOnce(feedPage([2, 3]));

    const result = await resource.collectSuggestedNotes({ limit: 10, maxPages: 5, types: ['like'] });

    expect(result.map(({ entity_key }) => entity_key)).toEqual(['c-1', 'c-2', 'c-3']);
  });
});

describe('leaderboard pagination', () => {
  it('deduplicates publications and stops on a repeated page', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ publications: [publication(1), publication(2)], more: true } satisfies LeaderboardPage)
      .mockResolvedValueOnce({ publications: [publication(2), publication(3)], more: true } satisfies LeaderboardPage)
      .mockResolvedValueOnce({ publications: [publication(2), publication(3)], more: true } satisfies LeaderboardPage);
    const resource = new DiscoveryResource({ request } as unknown as SubstackHttp);

    const result = await resource.leaderboardAll(4, { limit: 10, maxPages: 10 });

    expect(result.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
