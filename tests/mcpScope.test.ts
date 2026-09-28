// tests/mcpScope.test.ts — the MCP-token route allowlist and the gate that
// authenticates the /mcp endpoint itself.
//
// Nothing here touches a database or a real HTTP socket: createMcpTokenGate,
// isMcpScopedRoute and assertToolRoutesAreScoped are synchronous functions
// over plain (req, res, next) or plain data, so they are exercised directly
// with minimal fakes, the same style as tests/ingestScope.test.ts.

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

// This file builds both the MCP gate and the ingest gate, both of which now
// verify against a live token store on every request; it never touches a
// database, so both stores are replaced with a fixed "zero active UI tokens"
// answer, which reproduces today's env-token-only behaviour for every
// existing assertion below.
vi.mock('../src/db/mcpTokens', () => ({
  verifyMcpToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));
vi.mock('../src/db/ingestTokens', () => ({
  verifyIngestToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import {
  MCP_SCOPED_ROUTES, ROUTELESS_TOOLS, assertToolRoutesAreScoped,
  createMcpTokenGate, isMcpScopedRoute,
} from '../src/auth/mcpScope';
import { createIngestTokenScopeGate, ingestScopeOf } from '../src/auth/ingestScope';

const MCP_TOKEN = 'mcp-scope-test-token-value';
const INGEST_TOKEN = 'ingest-scope-test-token-value';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeRequest extends Request {
  __headers: Record<string, string>;
}

function makeReq(over: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  sessionUser?: unknown;
} = {}): FakeRequest {
  const headers = { ...(over.headers ?? {}) };
  const req = {
    method: over.method ?? 'POST',
    path: over.path ?? '/mcp',
    session: over.sessionUser !== undefined ? { user: over.sessionUser } : undefined,
    headers: {},
    get(name: string): string | undefined {
      const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    },
  };
  return req as unknown as FakeRequest;
}

interface FakeResponse extends Response {
  statusCode: number;
  body: unknown;
  responseHeaders: Record<string, string>;
}

function makeRes(): FakeResponse {
  const res: Partial<FakeResponse> = { statusCode: 0, body: undefined, responseHeaders: {} };
  res.status = ((code: number) => { res.statusCode = code; return res; }) as FakeResponse['status'];
  res.json = ((body: unknown) => { res.body = body; return res; }) as FakeResponse['json'];
  res.set = ((name: string, value: string) => { res.responseHeaders![name] = value; return res; }) as FakeResponse['set'];
  return res as FakeResponse;
}

// ── isMcpScopedRoute ─────────────────────────────────────────────────────────

const SCOPED: Array<[string, string]> = [
  ['GET', '/api/flights'],
  ['GET', '/api/flights/search'],
  ['GET', '/api/flights/stats'],
  ['GET', '/api/flights/42'],
  ['GET', '/api/flights/42/acars-messages'],
  ['GET', '/api/trips'],
  ['GET', '/api/trips/7'],
  ['GET', '/api/trips/7/journey'],
  ['GET', '/api/trips/7/planned-legs'],
  ['GET', '/api/planned-legs'],
  ['GET', '/api/planned-legs/9'],
  ['GET', '/api/planned-legs/9/acars-messages'],
  ['GET', '/api/acars/canned-messages'],
  ['GET', '/api/status'],
  ['GET', '/api/ground-sessions/current'],
  ['PATCH', '/api/flights/42'],
  ['POST', '/api/trips'],
  ['POST', '/api/trips/7/flights'],
  ['POST', '/api/planned-legs/simbrief'],
];

describe('MCP_SCOPED_ROUTES / isMcpScopedRoute', () => {
  it('has exactly nineteen entries, one per scoped route', () => {
    expect(MCP_SCOPED_ROUTES).toHaveLength(19);
  });

  it.each(SCOPED)('matches %s %s', (method, path) => {
    expect(isMcpScopedRoute(method, path)).toBe(true);
  });

  const OFF_LIST: Array<[string, string, string]> = [
    ['an off-list route entirely', 'GET', '/api/active-trip'],
    ['a delete, never on the list', 'DELETE', '/api/flights/42'],
    ['a trailing slash', 'GET', '/api/status/'],
    ['the wrong case', 'GET', '/API/status'],
    ['HEAD instead of GET', 'HEAD', '/api/status'],
    ['a write left off the list on purpose', 'PUT', '/api/active-trip'],
    ['the ACARS post sibling of a scoped read', 'POST', '/api/flights/42/acars-messages'],
    ['the settings write, never scoped', 'PUT', '/api/settings/simbrief'],
    ['a planned-leg status write, never scoped', 'PUT', '/api/planned-legs/9/status'],
  ];

  it.each(OFF_LIST)('does not match %s', (_label, method, path) => {
    expect(isMcpScopedRoute(method, path)).toBe(false);
  });
});

// ── assertToolRoutesAreScoped ────────────────────────────────────────────────

describe('assertToolRoutesAreScoped', () => {
  it('accepts a tool whose route/kind match an MCP_SCOPED_ROUTES entry', () => {
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'list_flights', route: 'flights-list', kind: 'read' }])
    ).not.toThrow();
  });

  it('accepts a routeless tool that is in ROUTELESS_TOOLS', () => {
    expect(ROUTELESS_TOOLS).toContain('get_weather');
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'get_weather', route: null, kind: 'read' }])
    ).not.toThrow();
  });

  it('rejects a routeless tool not in ROUTELESS_TOOLS', () => {
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'mystery_tool', route: null, kind: 'read' }])
    ).toThrow(/declares no route/);
  });

  it('rejects a tool whose route name is not on the allow-list', () => {
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'list_flights', route: 'not-a-real-route', kind: 'read' }])
    ).toThrow(/unknown route/);
  });

  it('rejects a read tool claiming a write-only route', () => {
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'sneaky_tool', route: 'trip-create', kind: 'read' }])
    ).toThrow(/declares kind "read" but route "trip-create" is "write"/);
  });

  it('rejects a write tool claiming a read-only route (the reverse direction)', () => {
    expect(() =>
      assertToolRoutesAreScoped([{ name: 'sneaky_write_tool', route: 'flights-list', kind: 'write' }])
    ).toThrow(/declares kind "write" but route "flights-list" is "read"/);
  });
});

// ── createMcpTokenGate ───────────────────────────────────────────────────────

function runGate(token: string | null, req: Request, res: Response): boolean {
  const gate = createMcpTokenGate({ token, enabled: token !== null });
  let called = false;
  gate(req, res, (() => { called = true; }) as never);
  return called;
}

/** Captures the exact argument next() was called with — 'router' and no
 *  argument at all are different signals to Express. */
function runGateCapturingNext(token: string | null, req: Request, res: Response): unknown[] {
  const gate = createMcpTokenGate({ token, enabled: token !== null });
  const calls: unknown[] = [];
  gate(req, res, ((arg?: unknown) => { calls.push(arg); }) as never);
  return calls;
}

describe('createMcpTokenGate', () => {
  it('passes through a correct bearer token', () => {
    const req = makeReq({ headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('rejects a missing Authorization header with 401 and the fixed body', () => {
    const req = makeReq();
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or missing MCP token', code: 'INVALID_MCP_TOKEN' });
    expect(res.responseHeaders['WWW-Authenticate']).toBe('Bearer realm="msfslogger-mcp"');
  });

  it('rejects a wrong bearer token with the same 401 body', () => {
    const req = makeReq({ headers: { authorization: 'Bearer wrong-token' } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a header that is not the Bearer scheme', () => {
    const req = makeReq({ headers: { authorization: MCP_TOKEN } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(false);
  });

  it('leaves the router when no MCP credential is configured anywhere — same as an unmounted /mcp, not a 401', () => {
    const req = makeReq({ headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    const res = makeRes();
    expect(runGateCapturingNext(null, req, res)).toEqual(['router']);
    expect(res.statusCode).toBe(0);
  });

  // Session cookie: the gate never reads req.session at all — a session,
  // valid or not, never substitutes for the bearer token, and its presence
  // makes no difference once the token itself is correct.
  it('a session on the request does not grant access without a correct token', () => {
    const req = makeReq({ sessionUser: { username: 'op' } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('a session on the request does not block access when the token is correct', () => {
    const req = makeReq({ headers: { authorization: `Bearer ${MCP_TOKEN}` }, sessionUser: { username: 'op' } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(true);
    expect(res.statusCode).toBe(0);
  });
});

// ── Success criterion 4: revoking one token must not affect the other ────────

describe('MCP_TOKEN and INGEST_TOKEN are independent credentials', () => {
  it('an MCP_TOKEN-valid header never satisfies an ingest-scoped route', () => {
    // The ingest gate only ever reads x-ingest-token; presenting the MCP
    // token there is checked against the configured INGEST_TOKEN digest and
    // must fail, regardless of the fact that it is a "valid" MCP credential
    // in its own scope.
    const ingestGate = createIngestTokenScopeGate({ token: INGEST_TOKEN, allowUnauthenticated: false });
    const req = makeReq({ method: 'GET', path: '/api/status', headers: { 'x-ingest-token': MCP_TOKEN } });
    let called = false;
    ingestGate(req, makeRes(), (() => { called = true; }) as never);
    expect(called).toBe(true); // the gate never responds itself
    expect(ingestScopeOf(req)).toBe('invalid');
  });

  it('an INGEST_TOKEN-valid header never satisfies an mcp-scoped route', () => {
    // createMcpTokenGate only ever reads Authorization: Bearer; presenting
    // the ingest token there is checked against the configured MCP_TOKEN
    // digest and must fail.
    const req = makeReq({ headers: { authorization: `Bearer ${INGEST_TOKEN}` } });
    const res = makeRes();
    expect(runGate(MCP_TOKEN, req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('revoking MCP_TOKEN (unconfiguring it) has no effect on an unrelated, still-configured INGEST_TOKEN', () => {
    const ingestGate = createIngestTokenScopeGate({ token: INGEST_TOKEN, allowUnauthenticated: false });
    const req = makeReq({ method: 'GET', path: '/api/status', headers: { 'x-ingest-token': INGEST_TOKEN } });
    ingestGate(req, makeRes(), (() => {}) as never);
    expect(ingestScopeOf(req)).toBe('valid');
  });
});
