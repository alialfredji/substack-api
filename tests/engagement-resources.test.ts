import { describe, expect, it, vi } from 'vitest';
import type { SubstackHttp } from '../src/client/http.js';
import { NotesResource } from '../src/client/resources/notes.js';
import { PublicationsResource } from '../src/client/resources/publications.js';
import { PostFacepileSchema, ReaderRepliesPageSchema } from '../src/schemas/post.js';

const replyPage = {
  commentBranches: [
    {
      comment: { id: 10, user_id: 20, name: 'Reader' },
      descendantComments: [{ type: 'comment', comment: { id: 11, user_id: 21, name: 'Reply' } }],
    },
  ],
  moreBranches: 1,
  nextCursor: 'next-token',
  automodHiddenBranches: [],
};

describe('engagement schemas', () => {
  it('parses reader reply branches and post facepiles', () => {
    expect(ReaderRepliesPageSchema.parse(replyPage).commentBranches[0]?.comment.id).toBe(10);
    expect(
      PostFacepileSchema.parse({
        reactors: [{ id: 1, name: 'Reactor' }],
        restackers: [{ id: 2, name: 'Restacker' }],
      }),
    ).toMatchObject({ reactors: [{ id: 1 }], restackers: [{ id: 2 }] });
  });
});

describe('notes engagement requests', () => {
  it('uses the verified restackers and paginated replies paths', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce([{ id: 1, name: 'Restacker' }])
      .mockResolvedValueOnce(replyPage);
    const resource = new NotesResource({ request } as unknown as SubstackHttp);

    await resource.restackers(337504999);
    await resource.replies(337504999, {
      publicationId: 9341396,
      cursor: 'cursor-a',
      onlyTopLevel: true,
    });

    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/comment/337504999/restackers');
    expect(request.mock.calls[1]?.[0]).toBe('/api/v1/reader/comment/337504999/replies');
    expect(request.mock.calls[1]?.[1].query).toEqual({
      publication_id: 9341396,
      comment_id: 337504999,
      cursor: 'cursor-a',
      only_top_level: '1',
    });
  });
});

describe('publication engagement requests', () => {
  it('uses publication-scoped facepile, reactors, restackers, and replies paths', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ reactors: [], restackers: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(replyPage);
    const resource = new PublicationsResource({ request } as unknown as SubstackHttp);

    await resource.facepile('alialf', 213684376);
    await resource.reactors('alialf', 213684376);
    await resource.restackers('alialf', 213684376);
    await resource.replies('alialf', 213684376, { publicationId: 9341396, cursor: 'cursor-a' });

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/post/213684376/facepile',
      '/api/v1/post/213684376/reactors',
      '/api/v1/post/213684376/restackers',
      '/api/v1/reader/post/213684376/replies',
    ]);
    for (const call of request.mock.calls) expect(call[1].baseUrl).toBe('https://alialf.substack.com');
    expect(request.mock.calls[3]?.[1].query).toEqual({ publication_id: 9341396, cursor: 'cursor-a' });
  });
});
