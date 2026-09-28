// tests/settingsTokens.test.ts — src/routes/settings.ts's ingest-token,
// MCP-token and password routes, against a real scratch database (the
// tests/ingest.test.ts ephemeral-port pattern, with a stub session middleware
// standing in for express-session — a logged-in browser, never a token).
//
// The password route's success path (session regenerate + save,
// other_sessions_revoked) needs a real express-session store to exercise
// end to end; that is disproportionate for a unit file and is covered
// instead by the scratch-server curl checks the Reviewer runs. Every
// failure branch below needs no session mutation and is covered here.

import express, { type Request, type Response as ExpressResponse, type NextFunction } from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsRouter } from '../src/routes/settings';
import { createIngestToken, MAX_ACTIVE_INGEST_TOKENS } from '../src/db/ingestTokens';
import { createMcpToken, MAX_ACTIVE_MCP_TOKENS } from '../src/db/mcpTokens';
import { setAuthUser, getAuthUser } from '../src/db';
import { hashPassword, verifyPassword } from '../src/auth/password';
import type { IngestConfig, McpConfig } from '../src/config';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';

const OPERATOR_USERNAME = 'op';
const OPERATOR_PASSWORD = 'CorrectHorseBattery9';

let scratch: ScratchDb;

function stubSession(req: Request, _res: ExpressResponse, next: NextFunction): void {
  (req as unknown as { session: { user: { username: string } } }).session = { user: { username: OPERATOR_USERNAME } };
  (req as unknown as { sessionID: string }).sessionID = 'stub-sid';
  next();
}

/** fetch()'s res.json() types as unknown; every body here is read-only JSON
 *  under our own control, so a single cast point keeps every call site
 *  free of individual "as any" noise. */
async function readJson(res: Response): Promise<any> {
  return res.json();
}

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function createTestServer(
  ingest: IngestConfig = { token: null, allowUnauthenticated: false },
  mcp: McpConfig = { token: null, enabled: false },
): Promise<TestServerHandle> {
  const app = express();
  app.use(express.json());
  app.use(stubSession);
  app.use('/api', createSettingsRouter(ingest, mcp));

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Test server did not bind to a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close(error => (error ? closeReject(error) : closeResolve()));
        }),
      });
    });
    server.on('error', reject);
  });
}

const openServers: Array<() => Promise<void>> = [];

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close => close()));
  destroyScratchDb(scratch);
});

async function startServer(ingest?: IngestConfig, mcp?: McpConfig): Promise<TestServerHandle> {
  const server = await createTestServer(ingest, mcp);
  openServers.push(server.close);
  return server;
}

// ── Ingest tokens ────────────────────────────────────────────────────────────

describe('GET /api/settings/ingest-tokens', () => {
  it('lists no tokens, mode closed, on a fresh database with no env token', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({ tokens: [], mode: 'closed', env_token_set: false, unauthenticated_opt_out_set: false });
  });

  it('reports env_token_set and mode env_token when INGEST_TOKEN is configured', async () => {
    const { baseUrl } = await startServer({ token: 'env-token-value', allowUnauthenticated: false });
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`);
    const body = await readJson(res);
    expect(body.mode).toBe('env_token');
    expect(body.env_token_set).toBe(true);
  });
});

describe('POST /api/settings/ingest-tokens', () => {
  it('creates a token, returns the plaintext once, and the created summary', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'MCDU' }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.secret).toMatch(/^sbi_/);
    expect(body.created.label).toBe('MCDU');
    expect(body.tokens).toHaveLength(1);
    expect(body.mode).toBe('ui_tokens');
  });

  it('trims the label before storing it', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '  MCDU  ' }),
    });
    const body = await readJson(res);
    expect(body.created.label).toBe('MCDU');
  });

  it('a subsequent list never carries the secret or a digest', async () => {
    const { baseUrl } = await startServer();
    const created = await readJson(await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'MCDU' }),
    }));

    const list = await readJson(await fetch(`${baseUrl}/api/settings/ingest-tokens`));
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(created.secret);
    expect(list.tokens[0]).not.toHaveProperty('token_digest');
  });

  it('400 INVALID_BODY for a non-object body', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: 'Invalid request body', code: 'INVALID_BODY' });
  });

  it('400 INVALID_LABEL for an empty label', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '   ' }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('INVALID_LABEL');
  });

  it('400 INVALID_LABEL for a label over 64 characters', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x'.repeat(65) }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('INVALID_LABEL');
  });

  it('400 INVALID_LABEL for a non-string label', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('INVALID_LABEL');
  });

  it('409 TOO_MANY_TOKENS at the active-token ceiling', async () => {
    for (let i = 0; i < MAX_ACTIVE_INGEST_TOKENS; i++) createIngestToken(`token-${i}`);
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'one too many' }),
    });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toEqual({
      error: `At most ${MAX_ACTIVE_INGEST_TOKENS} active ingest tokens; revoke one first`,
      code: 'TOO_MANY_TOKENS',
    });
  });
});

describe('DELETE /api/settings/ingest-tokens/:id', () => {
  it('revokes an active token and returns the post-revoke list', async () => {
    const { summary } = createIngestToken('MCDU');
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.tokens).toEqual([]);
    expect(body.mode).toBe('closed');
  });

  it('is idempotent: revoking twice is 200 both times', async () => {
    const { summary } = createIngestToken('MCDU');
    const { baseUrl } = await startServer();

    await fetch(`${baseUrl}/api/settings/ingest-tokens/${summary.id}`, { method: 'DELETE' });
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('400 INVALID_ID for a non-numeric id', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens/not-a-number`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: 'Invalid id', code: 'INVALID_ID' });
  });

  it('400 INVALID_ID for id 0', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens/0`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('404 TOKEN_NOT_FOUND for an id that never existed', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/ingest-tokens/999999`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await readJson(res)).toEqual({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
  });

  it('logs the public_id on first DELETE and nothing on idempotent re-revoke', async () => {
    const { summary } = createIngestToken('MCDU');
    const { baseUrl } = await startServer();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res1 = await fetch(`${baseUrl}/api/settings/ingest-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res1.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(`[Settings] Ingest token revoked: ${summary.public_id}`);

    logSpy.mockClear();

    const res2 = await fetch(`${baseUrl}/api/settings/ingest-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res2.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

// ── MCP tokens ───────────────────────────────────────────────────────────────

describe('GET /api/settings/mcp-tokens', () => {
  it('lists no tokens, mode disabled, on a fresh database with no env token', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens`);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ tokens: [], mode: 'disabled', env_token_set: false });
  });
});

describe('POST /api/settings/mcp-tokens', () => {
  it('creates a token, returns the plaintext once, and the created summary', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'claude' }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.secret).toMatch(/^sbm_/);
    expect(body.mode).toBe('ui_tokens');
  });

  it('400 INVALID_LABEL for an empty label', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('INVALID_LABEL');
  });

  it('409 TOO_MANY_TOKENS at the active-token ceiling', async () => {
    for (let i = 0; i < MAX_ACTIVE_MCP_TOKENS; i++) createMcpToken(`token-${i}`);
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'one too many' }),
    });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe('TOO_MANY_TOKENS');
  });
});

describe('DELETE /api/settings/mcp-tokens/:id', () => {
  it('revokes an active token and returns the post-revoke list', async () => {
    const { summary } = createMcpToken('claude');
    const { baseUrl } = await startServer();

    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await readJson(res)).tokens).toEqual([]);
  });

  it('404 TOKEN_NOT_FOUND for an id that never existed', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/mcp-tokens/999999`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await readJson(res)).code).toBe('TOKEN_NOT_FOUND');
  });

  it('logs the public_id on first DELETE and nothing on idempotent re-revoke', async () => {
    const { summary } = createMcpToken('claude');
    const { baseUrl } = await startServer();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res1 = await fetch(`${baseUrl}/api/settings/mcp-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res1.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(`[Settings] MCP token revoked: ${summary.public_id}`);

    logSpy.mockClear();

    const res2 = await fetch(`${baseUrl}/api/settings/mcp-tokens/${summary.id}`, { method: 'DELETE' });
    expect(res2.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});

// ── Password ─────────────────────────────────────────────────────────────────

describe('POST /api/settings/password', () => {
  beforeEach(() => {
    setAuthUser(OPERATOR_USERNAME, hashPassword(OPERATOR_PASSWORD));
  });

  async function changePassword(baseUrl: string, current: string, next: string): Promise<Response> {
    return fetch(`${baseUrl}/api/settings/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
  }

  it('400 INVALID_BODY when a field is missing', async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/settings/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: OPERATOR_PASSWORD }),
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: 'Invalid request body', code: 'INVALID_BODY' });
  });

  it('400 PASSWORD_TOO_SHORT for a new password under the minimum', async () => {
    const { baseUrl } = await startServer();
    const res = await changePassword(baseUrl, OPERATOR_PASSWORD, 'short');
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('PASSWORD_TOO_SHORT');
  });

  it('400 PASSWORD_TOO_LONG for a new password over the maximum', async () => {
    const { baseUrl } = await startServer();
    const res = await changePassword(baseUrl, OPERATOR_PASSWORD, 'x'.repeat(201));
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('PASSWORD_TOO_LONG');
  });

  it('400 PASSWORD_BLANK for a new password that is only whitespace', async () => {
    const { baseUrl } = await startServer();
    const res = await changePassword(baseUrl, OPERATOR_PASSWORD, ' '.repeat(20));
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('PASSWORD_BLANK');
  });

  it('400 PASSWORD_UNCHANGED when the new password equals the current one', async () => {
    const { baseUrl } = await startServer();
    const res = await changePassword(baseUrl, OPERATOR_PASSWORD, OPERATOR_PASSWORD);
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('PASSWORD_UNCHANGED');
  });

  it('403 WRONG_CURRENT_PASSWORD leaves the stored hash unchanged', async () => {
    const { baseUrl } = await startServer();
    const before = getAuthUser()!.password_hash;

    const res = await changePassword(baseUrl, 'totally-wrong-password', 'BrandNewPassw0rd!!');

    expect(res.status).toBe(403);
    expect(await readJson(res)).toEqual({ error: 'Current password is incorrect', code: 'WRONG_CURRENT_PASSWORD' });
    const after = getAuthUser()!.password_hash;
    expect(after).toBe(before);
    expect(verifyPassword(OPERATOR_PASSWORD, after)).toBe(true);
  });

  it('429 TOO_MANY_ATTEMPTS after 10 failed attempts from the same IP, with Retry-After', async () => {
    const { baseUrl } = await startServer();
    for (let i = 0; i < 10; i++) {
      const res = await changePassword(baseUrl, 'wrong-password', 'BrandNewPassw0rd!!');
      expect(res.status).toBe(403);
    }

    const res = await changePassword(baseUrl, 'wrong-password', 'BrandNewPassw0rd!!');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    const body = await readJson(res);
    expect(body.code).toBe('TOO_MANY_ATTEMPTS');
  });
});
