// tests/db/ingestTokens.test.ts — src/db/ingestTokens.ts against a real
// scratch database. A real database, never mocked (a file that calls
// createScratchDb() must not vi.mock('../src/db')).

import { createHash, timingSafeEqual } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIngestToken, listIngestTokens, countActiveIngestTokens, revokeIngestToken, verifyIngestToken,
  INGEST_TOKEN_LAST_USED_RESOLUTION_MS,
} from '../../src/db/ingestTokens';
import { createScratchDb, destroyScratchDb, type ScratchDb } from '../helpers/db';

let scratch: ScratchDb;

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(() => {
  destroyScratchDb(scratch);
});

function columnsOf(table: string): string[] {
  return (scratch.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
}

describe('createIngestToken()', () => {
  it('returns a secret matching the frozen shape', () => {
    const { secret } = createIngestToken('MCDU');
    expect(secret).toMatch(/^sbi_[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the digest of the secret — the row column never holds the plaintext', () => {
    const { secret, summary } = createIngestToken('MCDU');

    const row = scratch.db.prepare('SELECT token_digest FROM ingest_tokens WHERE id = ?').get(summary.id) as { token_digest: Buffer };
    expect(row.token_digest).toEqual(createHash('sha256').update(secret, 'utf8').digest());
    expect(columnsOf('ingest_tokens')).not.toEqual(expect.arrayContaining(['secret', 'plaintext', 'token']));
  });

  it('public_id is 8 lowercase hex characters and is never a substring of the secret', () => {
    const { secret, summary } = createIngestToken('MCDU');
    expect(summary.public_id).toMatch(/^[0-9a-f]{8}$/);
    expect(secret).not.toContain(summary.public_id);
  });

  it('returns the created summary with created_at set and last_used_at null', () => {
    const now = new Date('2026-09-28T10:00:00.000Z');
    const { summary } = createIngestToken('MCDU', now);
    expect(summary.label).toBe('MCDU');
    expect(summary.created_at).toBe('2026-09-28T10:00:00.000Z');
    expect(summary.last_used_at).toBeNull();
  });
});

describe('listIngestTokens()', () => {
  it('returns only active tokens, and never a digest or a secret key', () => {
    const active = createIngestToken('active');
    const revoked = createIngestToken('revoked');
    revokeIngestToken(revoked.summary.id);

    const list = listIngestTokens();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(active.summary.id);
    expect(list[0]).not.toHaveProperty('token_digest');
    expect(list[0]).not.toHaveProperty('secret');
  });

  it('is empty on a fresh database', () => {
    expect(listIngestTokens()).toEqual([]);
  });
});

describe('countActiveIngestTokens()', () => {
  it('counts only non-revoked rows', () => {
    createIngestToken('a');
    const { summary } = createIngestToken('b');
    createIngestToken('c');
    revokeIngestToken(summary.id);

    expect(countActiveIngestTokens()).toBe(2);
  });
});

describe('revokeIngestToken()', () => {
  it('sets revoked_at and removes the row from the active list', () => {
    const { summary } = createIngestToken('MCDU');
    const now = new Date('2026-09-28T11:00:00.000Z');

    const result = revokeIngestToken(summary.id, now);

    expect(result).toBe(true);
    expect(listIngestTokens()).toEqual([]);
    const row = scratch.db.prepare('SELECT revoked_at FROM ingest_tokens WHERE id = ?').get(summary.id) as { revoked_at: string };
    expect(row.revoked_at).toBe('2026-09-28T11:00:00.000Z');
  });

  it('is idempotent: revoking an already-revoked row returns true and keeps the row', () => {
    const { summary } = createIngestToken('MCDU');
    revokeIngestToken(summary.id);

    expect(revokeIngestToken(summary.id)).toBe(true);
    const row = scratch.db.prepare('SELECT id FROM ingest_tokens WHERE id = ?').get(summary.id);
    expect(row).toBeDefined();
  });

  it('returns false for an id that never existed', () => {
    expect(revokeIngestToken(999999)).toBe(false);
  });

  it('never deletes the row', () => {
    const { summary } = createIngestToken('MCDU');
    revokeIngestToken(summary.id);
    const row = scratch.db.prepare('SELECT id FROM ingest_tokens WHERE id = ?').get(summary.id);
    expect(row).toBeDefined();
  });
});

describe('verifyIngestToken()', () => {
  it('matches a correct secret and reports the matched id and the active count', () => {
    const { secret, summary } = createIngestToken('MCDU');

    const result = verifyIngestToken(secret);

    expect(result).toEqual({ activeCount: 1, matchedId: summary.id });
  });

  it('writes last_used_at on the first match', () => {
    const { secret, summary } = createIngestToken('MCDU');
    const now = new Date('2026-09-28T12:00:00.000Z');

    verifyIngestToken(secret, now);

    const row = scratch.db.prepare('SELECT last_used_at FROM ingest_tokens WHERE id = ?').get(summary.id) as { last_used_at: string };
    expect(row.last_used_at).toBe('2026-09-28T12:00:00.000Z');
  });

  it('does not re-write last_used_at within the resolution window', () => {
    const { secret } = createIngestToken('MCDU');
    const t0 = new Date('2026-09-28T12:00:00.000Z');
    verifyIngestToken(secret, t0);

    const t1 = new Date(t0.getTime() + 30_000);
    verifyIngestToken(secret, t1);

    const list = listIngestTokens();
    expect(list[0].last_used_at).toBe(t0.toISOString());
  });

  it('re-writes last_used_at once the resolution window has fully elapsed', () => {
    const { secret } = createIngestToken('MCDU');
    const t0 = new Date('2026-09-28T12:00:00.000Z');
    verifyIngestToken(secret, t0);

    const t1 = new Date(t0.getTime() + INGEST_TOKEN_LAST_USED_RESOLUTION_MS);
    verifyIngestToken(secret, t1);

    const list = listIngestTokens();
    expect(list[0].last_used_at).toBe(t1.toISOString());
  });

  it('a revoked token never matches, even with the right secret', () => {
    const { secret, summary } = createIngestToken('MCDU');
    revokeIngestToken(summary.id);

    const result = verifyIngestToken(secret);

    expect(result).toEqual({ activeCount: 0, matchedId: null });
  });

  it('a wrong secret does not match and does not write last_used_at', () => {
    createIngestToken('MCDU');

    const result = verifyIngestToken('sbi_wrong-secret-value');

    expect(result.matchedId).toBeNull();
    expect(result.activeCount).toBe(1);
    expect(listIngestTokens()[0].last_used_at).toBeNull();
  });

  it('an empty string does not match and does not hash', () => {
    createIngestToken('MCDU');
    expect(verifyIngestToken('')).toEqual({ activeCount: 1, matchedId: null });
  });

  it('undefined does not match', () => {
    createIngestToken('MCDU');
    expect(verifyIngestToken(undefined)).toEqual({ activeCount: 1, matchedId: null });
  });

  it('checks every active row (no early exit) and matches the right one among several', () => {
    const first = createIngestToken('a');
    const second = createIngestToken('b');
    const third = createIngestToken('c');

    expect(verifyIngestToken(third.secret).matchedId).toBe(third.summary.id);
    expect(verifyIngestToken(first.secret).matchedId).toBe(first.summary.id);
    expect(verifyIngestToken(second.secret).matchedId).toBe(second.summary.id);
  });

  it('activeCount reflects only non-revoked rows', () => {
    const a = createIngestToken('a');
    createIngestToken('b');
    revokeIngestToken(a.summary.id);

    expect(verifyIngestToken(undefined).activeCount).toBe(1);
  });

  it('the stored digest really is sha256 of the secret, comparable with timingSafeEqual', () => {
    const { secret, summary } = createIngestToken('MCDU');
    const row = scratch.db.prepare('SELECT token_digest FROM ingest_tokens WHERE id = ?').get(summary.id) as { token_digest: Buffer };
    expect(timingSafeEqual(row.token_digest, createHash('sha256').update(secret, 'utf8').digest())).toBe(true);
  });
});
