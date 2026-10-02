// tests/auth/sessionStore.test.ts — SqliteSessionStore against a real scratch
// database (never mocked): how often a touch saves the rolling expiry, that the
// stored expiry is never later than the cookie's, and that a touch never brings
// back a session a logout or a password change deleted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from 'express-session';
import { SqliteSessionStore, TOUCH_SAVE_INTERVAL_MS } from '../../src/auth/sessionStore';
import { sessionDestroyAllExcept, sessionGet } from '../../src/db/settings';
import { createScratchDb, destroyScratchDb, type ScratchDb } from '../helpers/db';

const HOUR = 60 * 60 * 1000;
const MAX_AGE = 30 * 24 * HOUR;

let scratch: ScratchDb;
let store: SqliteSessionStore;
/** A cookie expiry well in the future, so get() never finds the session expired. */
let base: number;

beforeEach(() => {
  scratch = createScratchDb();
  store = new SqliteSessionStore(MAX_AGE);
  base = Date.now() + MAX_AGE;
});

afterEach(() => {
  vi.useRealTimers();
  destroyScratchDb(scratch);
});

/** The session as express-session hands it to the store: logged in, its cookie expiring at `expires`. */
function loggedIn(expires: number): SessionData {
  return { cookie: { originalMaxAge: MAX_AGE, expires: new Date(expires) }, user: { username: 'pilot' } } as unknown as SessionData;
}

// The store answers through callbacks, but synchronously: each helper returns what its callback received.
function set(s: SqliteSessionStore, sid: string, expires: number): void {
  let error: unknown = 'not called';
  s.set(sid, loggedIn(expires), err => { error = err; });
  expect(error).toBeUndefined();
}

function get(s: SqliteSessionStore, sid: string): SessionData | null | undefined {
  let session: SessionData | null | undefined;
  s.get(sid, (err, value) => {
    expect(err).toBeNull();
    session = value;
  });
  return session;
}

function touch(s: SqliteSessionStore, sid: string, expires: number): void {
  let error: unknown = 'not called';
  s.touch(sid, loggedIn(expires), (err?: unknown) => { error = err; });
  expect(error).toBeUndefined();
}

const storedExpiry = (sid: string): number | null => sessionGet(sid)?.expires_at ?? null;

describe('SqliteSessionStore.touch', () => {
  it('saves at most once an hour', () => {
    expect(TOUCH_SAVE_INTERVAL_MS).toBe(HOUR);
  });

  it('writes nothing, not even a query, while the new expiry is less than an hour past the stored one', () => {
    set(store, 'sid-1', base);
    expect(get(store, 'sid-1')).toMatchObject({ user: { username: 'pilot' } });
    const prepare = vi.spyOn(scratch.db, 'prepare');

    touch(store, 'sid-1', base + 1);
    touch(store, 'sid-1', base + HOUR - 1);

    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(storedExpiry('sid-1')).toBe(base);
  });

  it('moves the stored expiry forward once the new one is an hour past it, then waits another hour', () => {
    set(store, 'sid-1', base);
    get(store, 'sid-1');

    touch(store, 'sid-1', base + HOUR);
    expect(storedExpiry('sid-1')).toBe(base + HOUR);

    touch(store, 'sid-1', base + 2 * HOUR - 1);
    expect(storedExpiry('sid-1')).toBe(base + HOUR);

    touch(store, 'sid-1', base + 2 * HOUR);
    expect(storedExpiry('sid-1')).toBe(base + 2 * HOUR);
  });

  it('writes only the expiry: the session data stays as it was saved', () => {
    set(store, 'sid-1', base);
    const before = sessionGet('sid-1')!.data;

    touch(store, 'sid-1', base + 3 * HOUR);

    expect(sessionGet('sid-1')).toEqual({ data: before, expires_at: base + 3 * HOUR });
  });

  it('lowers the stored expiry when the new one is earlier, by any amount, so it is never later than the cookie', () => {
    set(store, 'sid-1', base + 5 * HOUR);
    get(store, 'sid-1');

    touch(store, 'sid-1', base + 5 * HOUR - 1);
    expect(storedExpiry('sid-1')).toBe(base + 5 * HOUR - 1);

    touch(store, 'sid-1', base);
    expect(storedExpiry('sid-1')).toBe(base);

    // the lowered value is what later touches compare against: less than an hour past it is skipped again
    touch(store, 'sid-1', base + HOUR - 1);
    expect(storedExpiry('sid-1')).toBe(base);
  });

  it('lowers the expiry of a session this store has not read yet', () => {
    set(store, 'sid-1', base + 5 * HOUR);
    const fresh = new SqliteSessionStore(MAX_AGE);

    touch(fresh, 'sid-1', base);

    expect(storedExpiry('sid-1')).toBe(base);
  });

  it('writes nothing when the new expiry equals the stored one', () => {
    set(store, 'sid-1', base);
    get(store, 'sid-1');
    const prepare = vi.spyOn(scratch.db, 'prepare');

    touch(store, 'sid-1', base);

    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('saves the expiry of a session this store has not read yet, as another process would have left it', () => {
    set(store, 'sid-1', base);
    const fresh = new SqliteSessionStore(MAX_AGE);

    touch(fresh, 'sid-1', base + 1);

    expect(storedExpiry('sid-1')).toBe(base + 1);
  });

  it('does not recreate a session destroyed by a logout, however far the touch moves the expiry', () => {
    set(store, 'sid-1', base);
    get(store, 'sid-1');
    store.destroy('sid-1');

    touch(store, 'sid-1', base + 1);
    touch(store, 'sid-1', base + 2 * HOUR);
    touch(store, 'sid-1', base - 1);

    expect(sessionGet('sid-1')).toBeNull();
  });

  it('does not recreate the sessions a password change deleted when a request from one of them ends', () => {
    set(store, 'current', base);
    set(store, 'old', base);
    get(store, 'old');
    sessionDestroyAllExcept('current');

    touch(store, 'old', base - 1);
    touch(store, 'old', base + 1);
    touch(store, 'old', base + 2 * HOUR);
    touch(new SqliteSessionStore(MAX_AGE), 'old', base + 3 * HOUR);

    expect(sessionGet('old')).toBeNull();
    expect(storedExpiry('current')).toBe(base);
    expect(get(store, 'old')).toBeNull();
  });

  it('forgets the remembered expiry of a session that has expired, at the next login', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = Date.now();
    set(store, 'expiring', t + 1000);
    vi.setSystemTime(t + 2000);
    set(store, 'next-login', t + MAX_AGE);
    const prepare = vi.spyOn(scratch.db, 'prepare');

    // with its expiry remembered this touch would be skipped; forgotten, it goes to the database
    touch(store, 'expiring', t + 1500);

    expect(prepare.mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/^UPDATE auth_session SET expires_at/)]);
  });
});
