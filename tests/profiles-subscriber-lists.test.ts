import { describe, expect, it, vi } from 'vitest';
import type { SubstackHttp } from '../src/client/http.js';
import { ProfilesResource } from '../src/client/resources/profiles.js';
import type { SubscriberListsResponse } from '../src/schemas/profile.js';

const user = (id: number) => ({ id, name: `User ${id}`, handle: `user-${id}` });

describe('profile subscriber lists', () => {
  it('calls the grouped upstream endpoint directly for a numeric user id', async () => {
    const payload: SubscriberListsResponse = {
      subscriberLists: [{ id: 'followers', name: 'Followers', groups: [{ name: null, users: [user(1)] }] }],
    };
    const request = vi.fn().mockResolvedValue(payload);
    const resource = new ProfilesResource({ request } as unknown as SubstackHttp);

    await expect(resource.getSubscriberLists(42, ['followers'])).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith('/api/v1/user/42/subscriber-lists', {
      query: { lists: 'followers' },
      schema: expect.anything(),
      cookie: undefined,
      signal: undefined,
    });
  });

  it('resolves a handle to its numeric id before requesting subscriber lists', async () => {
    const request = vi.fn().mockResolvedValue({ subscriberLists: [] });
    const resource = new ProfilesResource({ request } as unknown as SubstackHttp);
    vi.spyOn(resource, 'getByHandle').mockResolvedValue({ id: 42, name: 'Example', handle: 'example' });

    await resource.getSubscriberLists('example', ['subscribers', 'followers', 'followers']);

    expect(resource.getByHandle).toHaveBeenCalledWith('example', undefined);
    expect(request).toHaveBeenCalledWith(
      '/api/v1/user/42/subscriber-lists',
      expect.objectContaining({ query: { lists: 'subscribers,followers' } }),
    );
  });

  it('flattens display groups and deduplicates users by id', async () => {
    const request = vi.fn().mockResolvedValue({
      subscriberLists: [
        {
          id: 'subscribers',
          name: 'Subscribers',
          groups: [
            { name: 'People you follow', users: [user(1)] },
            { name: 'Free subscribers', users: [user(1), user(2)] },
          ],
        },
      ],
    });
    const resource = new ProfilesResource({ request } as unknown as SubstackHttp);

    await expect(resource.getSubscribers(42)).resolves.toEqual([user(1), user(2)]);
  });

  it('rejects an empty list selection without making a request', async () => {
    const request = vi.fn();
    const resource = new ProfilesResource({ request } as unknown as SubstackHttp);

    await expect(resource.getSubscriberLists(42, [])).rejects.toThrow(/at least one list/);
    expect(request).not.toHaveBeenCalled();
  });
});
