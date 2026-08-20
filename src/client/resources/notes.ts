/**
 * Substack Notes: per-profile and suggested feeds, single-note lookup, and
 * who reacted to a note.
 *
 * The reason this resource exists is `unsubscribedReactors`: cross-referencing
 * a note's reactors against `is_subscribed` is the single most actionable
 * targeting signal in this whole project ("who engages with my content but
 * has not subscribed"). Everything else here — feeds, cursors, context users —
 * exists to get you to a note id to feed into that call.
 */

import type { SubstackHttp } from '../http.js';
import { SubstackAuthRequiredError } from '../errors.js';
import type { CallOptions, PaginateOptions } from '../types.js';
import {
  NoteFeedPageSchema,
  ReactorListSchema,
  SingleNoteResponseSchema,
  type NoteFeedPage,
  type NoteFeedItem,
  type NoteContextUser,
  type Reactor,
} from '../../schemas/note.js';

/** Query params accepted by both feed endpoints. */
export interface NoteFeedParams {
  /** `nextCursor` from a previous page. Omit for the first page. */
  cursor?: string;
  /**
   * Feed item types to include. Verified live: `note` (default), `comment`,
   * `post`, `like`, `restack` — all five are accepted and combine when you
   * pass more than one, rather than the last value winning. `comment` is
   * valid but can legitimately come back empty for an account with no post
   * comments; that is not an error.
   */
  types?: string[];
}

/** Options for collecting multiple cursor-paginated feed pages. */
export interface CollectNoteFeedOptions extends PaginateOptions {
  /** Feed item types to include. Defaults to `['note']`. */
  types?: string[];
}

/** Notes: feeds, single notes, and who reacted to them. */
export class NotesResource {
  constructor(private readonly http: SubstackHttp) {}

  /**
   * A profile's own note feed (their notes, and — with `types[]` — their
   * likes/restacks/comments/posts activity).
   *
   * `types` defaults to `['note']`. Substack expects the array as repeated
   * `types[]=...` query keys, which `SubstackHttp.request` produces
   * automatically from an array value.
   */
  async listByProfile(userId: number, params: NoteFeedParams = {}, opts?: CallOptions): Promise<NoteFeedPage> {
    return this.http.request(`/api/v1/reader/feed/profile/${userId}`, {
      query: { cursor: params.cursor, 'types[]': params.types ?? ['note'] },
      schema: NoteFeedPageSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * The suggested/cold-start notes feed. Anonymously this returns Substack's
   * generic suggestions rather than anything personalised; with a cookie it
   * reflects the account's actual reading graph. Same envelope as
   * {@link listByProfile}, plus a populated {@link NoteFeedPage.trackingParameters}.
   */
  async listSuggested(params: NoteFeedParams = {}, opts?: CallOptions): Promise<NoteFeedPage> {
    return this.http.request('/api/v1/reader/feed', {
      query: { cursor: params.cursor, 'types[]': params.types ?? ['note'] },
      schema: NoteFeedPageSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /** Fetch a single note by id. Unwraps the upstream `{ item }` envelope. */
  async get(noteId: number, opts?: CallOptions): Promise<NoteFeedItem> {
    const data = await this.http.request(`/api/v1/reader/comment/${noteId}`, {
      schema: SingleNoteResponseSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
    return data.item;
  }

  /**
   * Every account that reacted to (liked) a note.
   *
   * There is no working pagination here — `limit`, `offset` and `page` query
   * params were all tried live and every one returned the identical result,
   * so this always fetches the endpoint's full list in one request. Do not
   * assume the length equals the note's `reaction_count`: the fixture used to
   * verify this endpoint had 6 reactions but only 5 reactors (see the comment
   * in `schemas/note.ts` for the likely cause).
   */
  async reactors(noteId: number, opts?: CallOptions): Promise<Reactor[]> {
    return this.http.request(`/api/v1/comment/${noteId}/reactors`, {
      schema: ReactorListSchema,
      cookie: opts?.cookie,
      signal: opts?.signal,
    });
  }

  /**
   * Reactors who have not subscribed — the "liked but never signed up" list.
   *
   * `is_subscribed` is viewer-relative and reads `false` for *every* reactor
   * on an anonymous call, which would make this method return a list that
   * looks meaningful but is actually worthless noise. So it throws
   * {@link SubstackAuthRequiredError} instead of silently doing that: it
   * checks whether a cookie is actually in play for this call — `opts.cookie`
   * if given (an explicit `null` there means force-anonymous and still
   * throws), otherwise whether the client itself was constructed with one.
   */
  async unsubscribedReactors(noteId: number, opts?: CallOptions): Promise<Reactor[]> {
    const cookieInPlay = opts?.cookie === null ? false : opts?.cookie !== undefined ? true : this.http.hasCookie;
    if (!cookieInPlay) {
      throw new SubstackAuthRequiredError(
        'Filtering reactors to unsubscribed accounts (is_subscribed reads false for everyone without one)',
      );
    }
    const all = await this.reactors(noteId, opts);
    return all.filter((reactor) => reactor.is_subscribed === false);
  }

  /**
   * Walk `listByProfile` across pages until `nextCursor` is exhausted or
   * stops advancing.
   *
   * Two stopping conditions, both required, matching the convention used by
   * every other paginate-to-completion helper in this project: `limit` bounds
   * the total items returned, `maxPages` bounds the number of upstream
   * requests regardless of item count. `nextCursor === cursor` (a page that
   * returns the same cursor it was given) is treated the same as an absent
   * cursor — both mean "stop" — since that would otherwise loop forever.
   */
  async collectProfileNotes(userId: number, opts: CollectNoteFeedOptions = {}): Promise<NoteFeedItem[]> {
    const limit = opts.limit ?? 100;
    const maxPages = opts.maxPages ?? 20;
    const byEntityKey = new Map<string, NoteFeedItem>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < maxPages && byEntityKey.size < limit; page += 1) {
      const result = await this.listByProfile(
        userId,
        { cursor, types: opts.types },
        { cookie: opts.cookie, signal: opts.signal },
      );
      for (const item of result.items) {
        if (!byEntityKey.has(item.entity_key)) byEntityKey.set(item.entity_key, item);
        if (byEntityKey.size >= limit) break;
      }
      if (!result.nextCursor || seenCursors.has(result.nextCursor) || result.items.length === 0) break;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    return [...byEntityKey.values()].slice(0, limit);
  }

  /**
   * Walk the suggested feed with the same bounded cursor semantics as
   * {@link collectProfileNotes}.
   */
  async collectSuggestedNotes(opts: CollectNoteFeedOptions = {}): Promise<NoteFeedItem[]> {
    const limit = opts.limit ?? 100;
    const maxPages = opts.maxPages ?? 20;
    const byEntityKey = new Map<string, NoteFeedItem>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < maxPages && byEntityKey.size < limit; page += 1) {
      const result = await this.listSuggested(
        { cursor, types: opts.types },
        { cookie: opts.cookie, signal: opts.signal },
      );
      for (const item of result.items) {
        if (!byEntityKey.has(item.entity_key)) byEntityKey.set(item.entity_key, item);
        if (byEntityKey.size >= limit) break;
      }
      if (!result.nextCursor || seenCursors.has(result.nextCursor) || result.items.length === 0) break;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    return [...byEntityKey.values()].slice(0, limit);
  }

  /**
   * Deduped list of every account attributed as a "why this surfaced" signal
   * across a feed page's `item.context.users`.
   *
   * This is the raw material for a suggested-people workflow: the suggested
   * feed ({@link listSuggested}) attaches exactly one context user per item
   * (the account whose activity caused the suggestion), so collecting them
   * across a page is how you'd build a "people connected to your notes
   * activity" list. A profile's own feed consistently returned an empty
   * `context.users` for every item in testing, so this is mostly useful on
   * {@link listSuggested} results. Deduped by `id`, order preserved.
   */
  contextUsers(page: NoteFeedPage): NoteContextUser[] {
    const seen = new Map<number, NoteContextUser>();
    for (const item of page.items) {
      for (const user of item.context.users ?? []) {
        if (!seen.has(user.id)) seen.set(user.id, user);
      }
    }
    return [...seen.values()];
  }
}
