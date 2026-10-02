// tests/db/settings.test.ts — src/db/settings.ts against a real scratch
// database. A real database, never mocked (a file that calls
// createScratchDb() must not vi.mock('../src/db')).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthUser,
  setAuthUser,
  getAppSecret,
  getOrCreateAppSecret,
  getSetting,
  setSetting,
  sessionGet,
  sessionSet,
  sessionTouch,
  sessionDestroy,
  sessionSweep,
  sessionDestroyAllExcept,
} from '../../src/db/settings';
import { createScratchDb, destroyScratchDb, type ScratchDb } from '../helpers/db';

let scratch: ScratchDb;

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(() => {
  destroyScratchDb(scratch);
});

describe('getAuthUser() / setAuthUser()', () => {
  it('returns null when no operator account exists', () => {
    expect(getAuthUser()).toBeNull();
  });

  it('inserts the operator row on first call', () => {
    setAuthUser('pilot', 'hash1');

    const row = getAuthUser();
    expect(row).not.toBeNull();
    expect(row!.id).toBe(1);
    expect(row!.username).toBe('pilot');
    expect(row!.password_hash).toBe('hash1');
    expect(row!.created_at).toBe(row!.updated_at);
  });

  it('updates username/password and updated_at, but preserves created_at, on a later call', () => {
    setAuthUser('pilot', 'hash1');
    const first = getAuthUser()!;

    const laterSpy = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2099-01-01T00:00:00.000Z');
    setAuthUser('captain', 'hash2');
    laterSpy.mockRestore();

    const second = getAuthUser()!;
    expect(second.username).toBe('captain');
    expect(second.password_hash).toBe('hash2');
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('getAppSecret() / getOrCreateAppSecret()', () => {
  it('getAppSecret returns null when the named secret does not exist', () => {
    expect(getAppSecret('session')).toBeNull();
  });

  it('getOrCreateAppSecret generates and stores a value on a miss', () => {
    const generate = vi.fn(() => 'generated-value');

    const value = getOrCreateAppSecret('session', generate);

    expect(value).toBe('generated-value');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(getAppSecret('session')).toBe('generated-value');
  });

  it('getOrCreateAppSecret does not invoke the generator again on a hit', () => {
    const generate = vi.fn(() => 'generated-value');
    getOrCreateAppSecret('session', generate);

    const generateAgain = vi.fn(() => 'other-value');
    const value = getOrCreateAppSecret('session', generateAgain);

    expect(value).toBe('generated-value');
    expect(generateAgain).not.toHaveBeenCalled();
  });
});

describe('getSetting() / setSetting()', () => {
  it('getSetting returns null when the setting has never been set', () => {
    expect(getSetting('theme')).toBeNull();
  });

  it('setSetting inserts, and getSetting reads it back', () => {
    setSetting('theme', 'dark');
    expect(getSetting('theme')).toBe('dark');
  });

  it('setSetting upserts an existing setting', () => {
    setSetting('theme', 'dark');
    setSetting('theme', 'light');
    expect(getSetting('theme')).toBe('light');
  });

  it('setSetting(name, null) deletes the row', () => {
    setSetting('theme', 'dark');

    setSetting('theme', null);

    expect(getSetting('theme')).toBeNull();
    expect(scratch.db.prepare('SELECT * FROM app_setting WHERE name = ?').get('theme')).toBeUndefined();
  });

  it('setSetting(name, "") also deletes the row', () => {
    setSetting('theme', 'dark');

    setSetting('theme', '');

    expect(getSetting('theme')).toBeNull();
  });
});

describe('session store', () => {
  it('sessionGet returns null for an unknown sid', () => {
    expect(sessionGet('missing')).toBeNull();
  });

  it('sessionSet inserts, and sessionGet reads back data and expires_at', () => {
    sessionSet('sid-1', '{"user":"pilot"}', 1000);

    expect(sessionGet('sid-1')).toEqual({ data: '{"user":"pilot"}', expires_at: 1000 });
  });

  it('sessionSet upserts an existing sid', () => {
    sessionSet('sid-1', '{"user":"pilot"}', 1000);
    sessionSet('sid-1', '{"user":"captain"}', 2000);

    expect(sessionGet('sid-1')).toEqual({ data: '{"user":"captain"}', expires_at: 2000 });
  });

  it('sessionDestroy removes the row', () => {
    sessionSet('sid-1', '{}', 1000);

    sessionDestroy('sid-1');

    expect(sessionGet('sid-1')).toBeNull();
  });

  it('sessionDestroy on an unknown sid is a no-op', () => {
    expect(() => sessionDestroy('missing')).not.toThrow();
  });

  it('sessionSweep removes only rows with expires_at <= now and returns the count removed', () => {
    sessionSet('expired-1', '{}', 1000);
    sessionSet('expired-2', '{}', 2000);
    sessionSet('still-valid', '{}', 3000);

    const removed = sessionSweep(2000);

    expect(removed).toBe(2);
    expect(sessionGet('expired-1')).toBeNull();
    expect(sessionGet('expired-2')).toBeNull();
    expect(sessionGet('still-valid')).toEqual({ data: '{}', expires_at: 3000 });
  });

  it('sessionSweep returns 0 when nothing is expired', () => {
    sessionSet('still-valid', '{}', 3000);

    expect(sessionSweep(1000)).toBe(0);
    expect(sessionGet('still-valid')).not.toBeNull();
  });

  it('sessionDestroyAllExcept deletes every other session, keeps the named one, and returns the count deleted', () => {
    sessionSet('keep-me', '{}', 1000);
    sessionSet('other-1', '{}', 1000);
    sessionSet('other-2', '{}', 1000);

    const deleted = sessionDestroyAllExcept('keep-me');

    expect(deleted).toBe(2);
    expect(sessionGet('keep-me')).not.toBeNull();
    expect(sessionGet('other-1')).toBeNull();
    expect(sessionGet('other-2')).toBeNull();
  });

  it('sessionDestroyAllExcept returns 0 when the kept sid is the only row', () => {
    sessionSet('only-one', '{}', 1000);

    expect(sessionDestroyAllExcept('only-one')).toBe(0);
    expect(sessionGet('only-one')).not.toBeNull();
  });

  it('sessionDestroyAllExcept returns 0 on an empty session table', () => {
    expect(sessionDestroyAllExcept('nonexistent')).toBe(0);
  });

  it('sessionTouch sets expires_at, keeps the data as it was, and returns 1', () => {
    sessionSet('sid-1', '{"user":"pilot"}', 1000);

    expect(sessionTouch('sid-1', 5000)).toBe(1);
    expect(sessionGet('sid-1')).toEqual({ data: '{"user":"pilot"}', expires_at: 5000 });
  });

  it('sessionTouch lowers expires_at when given an earlier value, and returns 1', () => {
    sessionSet('sid-1', '{}', 5000);

    expect(sessionTouch('sid-1', 4999)).toBe(1);
    expect(sessionGet('sid-1')).toEqual({ data: '{}', expires_at: 4999 });
  });

  it('sessionTouch on an unknown sid returns 0 and inserts nothing', () => {
    expect(sessionTouch('missing', 5000)).toBe(0);
    expect(sessionGet('missing')).toBeNull();
  });

  it('sessionTouch does not bring back a session that sessionDestroy or sessionDestroyAllExcept deleted', () => {
    sessionSet('keep-me', '{}', 1000);
    sessionSet('logged-out', '{}', 1000);
    sessionSet('other', '{}', 1000);
    sessionDestroy('logged-out');
    sessionDestroyAllExcept('keep-me');

    expect(sessionTouch('logged-out', 5000)).toBe(0);
    expect(sessionTouch('other', 5000)).toBe(0);
    expect(sessionTouch('other', 500)).toBe(0);
    expect(sessionGet('logged-out')).toBeNull();
    expect(sessionGet('other')).toBeNull();
    expect(sessionGet('keep-me')).toEqual({ data: '{}', expires_at: 1000 });
  });
});
