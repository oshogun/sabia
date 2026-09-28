// tests/db/mcpTokens.test.ts — src/db/mcpTokens.ts against a real scratch
// database. A real database, never mocked (a file that calls
// createScratchDb() must not vi.mock('../src/db')).

import { createHash, timingSafeEqual } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMcpToken, listMcpTokens, countActiveMcpTokens, revokeMcpToken, verifyMcpToken,
  MCP_TOKEN_LAST_USED_RESOLUTION_MS,
} from '../../src/db/mcpTokens';
import { createIngestToken, verifyIngestToken } from '../../src/db/ingestTokens';
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

describe('createMcpToken()', () => {
  it('returns a secret matching the frozen shape', () => {
    const { secret } = createMcpToken('claude');
    expect(secret).toMatch(/^sbm_[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the digest of the secret — the row column never holds the plaintext', () => {
    const { secret, summary } = createMcpToken('claude');

    const row = scratch.db.prepare('SELECT token_digest FROM mcp_tokens WHERE id = ?').get(summary.id) as { token_digest: Buffer };
    expect(row.token_digest).toEqual(createHash('sha256').update(secret, 'utf8').digest());
    expect(columnsOf('mcp_tokens')).not.toEqual(expect.arrayContaining(['secret', 'plaintext', 'token']));
  });

  it('public_id is 8 lowercase hex characters and is never a substring of the secret', () => {
    const { secret, summary } = createMcpToken('claude');
    expect(summary.public_id).toMatch(/^[0-9a-f]{8}$/);
    expect(secret).not.toContain(summary.public_id);
  });

  it('returns the created summary with created_at set and last_used_at null', () => {
    const now = new Date('2026-09-28T10:00:00.000Z');
    const { summary } = createMcpToken('claude', now);
    expect(summary.label).toBe('claude');
    expect(summary.created_at).toBe('2026-09-28T10:00:00.000Z');
    expect(summary.last_used_at).toBeNull();
  });
});

describe('listMcpTokens()', () => {
  it('returns only active tokens, and never a digest or a secret key', () => {
    const active = createMcpToken('active');
    const revoked = createMcpToken('revoked');
    revokeMcpToken(revoked.summary.id);

    const list = listMcpTokens();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(active.summary.id);
    expect(list[0]).not.toHaveProperty('token_digest');
    expect(list[0]).not.toHaveProperty('secret');
  });

  it('is empty on a fresh database', () => {
    expect(listMcpTokens()).toEqual([]);
  });
});

describe('countActiveMcpTokens()', () => {
  it('counts only non-revoked rows', () => {
    createMcpToken('a');
    const { summary } = createMcpToken('b');
    createMcpToken('c');
    revokeMcpToken(summary.id);

    expect(countActiveMcpTokens()).toBe(2);
  });
});

describe('revokeMcpToken()', () => {
  it('sets revoked_at and removes the row from the active list', () => {
    const { summary } = createMcpToken('claude');
    const now = new Date('2026-09-28T11:00:00.000Z');

    const result = revokeMcpToken(summary.id, now);

    expect(result).toBe(true);
    expect(listMcpTokens()).toEqual([]);
    const row = scratch.db.prepare('SELECT revoked_at FROM mcp_tokens WHERE id = ?').get(summary.id) as { revoked_at: string };
    expect(row.revoked_at).toBe('2026-09-28T11:00:00.000Z');
  });

  it('is idempotent: revoking an already-revoked row returns true and keeps the row', () => {
    const { summary } = createMcpToken('claude');
    revokeMcpToken(summary.id);

    expect(revokeMcpToken(summary.id)).toBe(true);
    const row = scratch.db.prepare('SELECT id FROM mcp_tokens WHERE id = ?').get(summary.id);
    expect(row).toBeDefined();
  });

  it('returns false for an id that never existed', () => {
    expect(revokeMcpToken(999999)).toBe(false);
  });

  it('never deletes the row', () => {
    const { summary } = createMcpToken('claude');
    revokeMcpToken(summary.id);
    const row = scratch.db.prepare('SELECT id FROM mcp_tokens WHERE id = ?').get(summary.id);
    expect(row).toBeDefined();
  });
});

describe('verifyMcpToken()', () => {
  it('matches a correct secret and reports the matched id and the active count', () => {
    const { secret, summary } = createMcpToken('claude');

    const result = verifyMcpToken(secret);

    expect(result).toEqual({ activeCount: 1, matchedId: summary.id });
  });

  it('writes last_used_at on the first match', () => {
    const { secret, summary } = createMcpToken('claude');
    const now = new Date('2026-09-28T12:00:00.000Z');

    verifyMcpToken(secret, now);

    const row = scratch.db.prepare('SELECT last_used_at FROM mcp_tokens WHERE id = ?').get(summary.id) as { last_used_at: string };
    expect(row.last_used_at).toBe('2026-09-28T12:00:00.000Z');
  });

  it('does not re-write last_used_at within the resolution window', () => {
    const { secret } = createMcpToken('claude');
    const t0 = new Date('2026-09-28T12:00:00.000Z');
    verifyMcpToken(secret, t0);

    const t1 = new Date(t0.getTime() + 30_000);
    verifyMcpToken(secret, t1);

    const list = listMcpTokens();
    expect(list[0].last_used_at).toBe(t0.toISOString());
  });

  it('re-writes last_used_at once the resolution window has fully elapsed', () => {
    const { secret } = createMcpToken('claude');
    const t0 = new Date('2026-09-28T12:00:00.000Z');
    verifyMcpToken(secret, t0);

    const t1 = new Date(t0.getTime() + MCP_TOKEN_LAST_USED_RESOLUTION_MS);
    verifyMcpToken(secret, t1);

    const list = listMcpTokens();
    expect(list[0].last_used_at).toBe(t1.toISOString());
  });

  it('a revoked token never matches, even with the right secret', () => {
    const { secret, summary } = createMcpToken('claude');
    revokeMcpToken(summary.id);

    const result = verifyMcpToken(secret);

    expect(result).toEqual({ activeCount: 0, matchedId: null });
  });

  it('a wrong secret does not match and does not write last_used_at', () => {
    createMcpToken('claude');

    const result = verifyMcpToken('sbm_wrong-secret-value');

    expect(result.matchedId).toBeNull();
    expect(result.activeCount).toBe(1);
    expect(listMcpTokens()[0].last_used_at).toBeNull();
  });

  it('an empty string does not match and does not hash', () => {
    createMcpToken('claude');
    expect(verifyMcpToken('')).toEqual({ activeCount: 1, matchedId: null });
  });

  it('undefined does not match', () => {
    createMcpToken('claude');
    expect(verifyMcpToken(undefined)).toEqual({ activeCount: 1, matchedId: null });
  });

  it('checks every active row (no early exit) and matches the right one among several', () => {
    const first = createMcpToken('a');
    const second = createMcpToken('b');
    const third = createMcpToken('c');

    expect(verifyMcpToken(third.secret).matchedId).toBe(third.summary.id);
    expect(verifyMcpToken(first.secret).matchedId).toBe(first.summary.id);
    expect(verifyMcpToken(second.secret).matchedId).toBe(second.summary.id);
  });

  it('an ingest secret never matches an MCP token, and vice versa, with both tables populated', () => {
    const ingest = createIngestToken('MCDU');
    const mcp = createMcpToken('claude');

    expect(verifyMcpToken(ingest.secret).matchedId).toBeNull();
    expect(verifyIngestToken(mcp.secret).matchedId).toBeNull();
    // Each store still finds its own token.
    expect(verifyMcpToken(mcp.secret).matchedId).toBe(mcp.summary.id);
    expect(verifyIngestToken(ingest.secret).matchedId).toBe(ingest.summary.id);
  });
});
