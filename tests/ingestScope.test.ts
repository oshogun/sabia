// tests/ingestScope.test.ts — the ingest-token route allowlist and the
// mark-aware branches it adds to requireAuth/requireSameOrigin.
//
// Nothing here touches a database or a real HTTP socket: requireAuth,
// requireSameOrigin and createIngestTokenScopeGate are synchronous functions
// over plain (req, res, next), so they are exercised directly with minimal
// fakes rather than through an express app and fetch.

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

// createIngestTokenScopeGate now verifies against the live token store on
// every request; this file never touches a database, so the store is
// replaced with a fixed "zero active UI tokens" answer, which reproduces
// today's env/opt-out-only behaviour for every existing assertion below.
vi.mock('../src/db/ingestTokens', () => ({
  verifyIngestToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import {
  INGEST_SCOPED_ROUTES, createIngestTokenScopeGate, ingestScopeOf, isIngestScopedRoute,
} from '../src/auth/ingestScope';
import { requireAuth, requireSameOrigin } from '../src/auth/middleware';
import { createAcarsRouter } from '../src/routes/acars';
import { createGroundSessionsRouter } from '../src/routes/groundSessions';
import { createSettingsRouter } from '../src/routes/settings';
import { createPlannedLegsRouter } from '../src/routes/plannedLegs';
import { createSayIntentionsRouter } from '../src/routes/sayIntentions';
import { createEventsRouter } from '../src/routes/events';
import { EventHub } from '../src/eventHub';
import type { FlightManager } from '../src/flightManager';

// A stub good enough to construct the router with — this file never opens a
// stream, only walks the router's own route table.
const stubSnapshot = { status: () => ({}), flightState: () => ({ flightState: 'IDLE' as const, currentFlightId: null, plannedLegId: null }) };

const TOKEN = 'ingest-scope-test-token';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeRequest extends Request {
  __headers: Record<string, string>;
}

function makeReq(over: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  cookie?: string;
  sessionUser?: unknown;
  origin?: string;
  host?: string;
  protocol?: string;
} = {}): FakeRequest {
  const headers = { ...(over.headers ?? {}) };
  if (over.origin !== undefined) headers.origin = over.origin;
  const req = {
    method: over.method ?? 'GET',
    path: over.path ?? '/api/status',
    protocol: over.protocol ?? 'http',
    session: over.sessionUser !== undefined ? { user: over.sessionUser } : undefined,
    headers: over.cookie !== undefined ? { cookie: over.cookie } : {},
    __headers: headers,
    get(name: string): string | undefined {
      const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
      if (key) return headers[key];
      if (name.toLowerCase() === 'host') return over.host ?? 'localhost:3100';
      return undefined;
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
  const res: Partial<FakeResponse> = {
    statusCode: 0,
    body: undefined,
    responseHeaders: {},
  };
  res.status = ((code: number) => { res.statusCode = code; return res; }) as FakeResponse['status'];
  res.json = ((body: unknown) => { res.body = body; return res; }) as FakeResponse['json'];
  res.set = ((name: string, value: string) => { res.responseHeaders![name] = value; return res; }) as FakeResponse['set'];
  return res as FakeResponse;
}

function runGate(config: { token: string | null }, req: Request, res: Response): void {
  const gate = createIngestTokenScopeGate({ token: config.token, allowUnauthenticated: config.token === null });
  let called = false;
  const next = () => { called = true; };
  gate(req, res, next as never);
  expect(called).toBe(true); // the gate never responds
}

// ── isIngestScopedRoute ──────────────────────────────────────────────────────

const NUMERIC_ID_PATHS: Array<[string, string]> = [
  ['GET', '/api/status'],
  ['GET', '/api/acars/canned-messages'],
  ['GET', '/api/flights/42/acars-messages'],
  ['POST', '/api/flights/42/acars-messages'],
  ['POST', '/api/flights/42/acars-messages/wx'],
  ['GET', '/api/planned-legs/42/acars-messages'],
  ['POST', '/api/planned-legs/42/acars-messages'],
  ['POST', '/api/planned-legs/42/acars-messages/wx'],
  ['POST', '/api/planned-legs/42/acars-messages/loadsheet'],
  ['POST', '/api/planned-legs/42/acars-messages/clearance'],
  ['GET', '/api/ground-sessions/current'],
  ['GET', '/api/events'],
];

describe('isIngestScopedRoute', () => {
  it('has exactly twenty entries, one per scoped route', () => {
    expect(INGEST_SCOPED_ROUTES).toHaveLength(20);
  });

  it.each(NUMERIC_ID_PATHS)('matches %s %s with a numeric id', (method, path) => {
    expect(isIngestScopedRoute(method, path)).toBe(true);
  });

  it.each(NUMERIC_ID_PATHS)('matches %s %s with a non-numeric id', (method, path) => {
    expect(isIngestScopedRoute(method, path.replace('42', 'not-a-number'))).toBe(true);
  });

  const OFF_LIST: Array<[string, string, string]> = [
    ['an off-list route entirely', 'GET', '/api/flights'],
    ['a trailing slash', 'GET', '/api/status/'],
    ['the wrong case', 'GET', '/API/status'],
    ['HEAD instead of GET', 'HEAD', '/api/status'],
    ['OPTIONS instead of GET', 'OPTIONS', '/api/status'],
    ['a write that was deliberately left off', 'POST', '/api/ground-sessions'],
    ['a delete that was deliberately left off', 'DELETE', '/api/ground-sessions/current'],
  ];

  it.each(OFF_LIST)('does not match %s', (_label, method, path) => {
    expect(isIngestScopedRoute(method, path)).toBe(false);
  });

  it('matches GET /api/settings/simbrief', () => {
    expect(isIngestScopedRoute('GET', '/api/settings/simbrief')).toBe(true);
  });

  it('matches POST /api/planned-legs/simbrief', () => {
    expect(isIngestScopedRoute('POST', '/api/planned-legs/simbrief')).toBe(true);
  });

  it('does not match the write sibling PUT /api/settings/simbrief', () => {
    expect(isIngestScopedRoute('PUT', '/api/settings/simbrief')).toBe(false);
  });

  it('does not match the trip-scoped sibling POST /api/trips/:id/planned-legs/simbrief', () => {
    expect(isIngestScopedRoute('POST', '/api/trips/123/planned-legs/simbrief')).toBe(false);
  });

  it('matches GET /api/settings/sayintentions', () => {
    expect(isIngestScopedRoute('GET', '/api/settings/sayintentions')).toBe(true);
  });

  it('does not match the write sibling PUT /api/settings/sayintentions', () => {
    expect(isIngestScopedRoute('PUT', '/api/settings/sayintentions')).toBe(false);
  });

  it('matches GET /api/flights/:id/sayintentions/link', () => {
    expect(isIngestScopedRoute('GET', '/api/flights/42/sayintentions/link')).toBe(true);
  });

  it('matches POST /api/flights/:id/sayintentions/link', () => {
    expect(isIngestScopedRoute('POST', '/api/flights/42/sayintentions/link')).toBe(true);
  });

  it('matches DELETE /api/flights/:id/sayintentions/link', () => {
    expect(isIngestScopedRoute('DELETE', '/api/flights/42/sayintentions/link')).toBe(true);
  });

  it('does not match PATCH /api/flights/:id/sayintentions/link, a method none of its three entries list', () => {
    expect(isIngestScopedRoute('PATCH', '/api/flights/42/sayintentions/link')).toBe(false);
  });

  it('matches POST /api/flights/:id/sayintentions/import', () => {
    expect(isIngestScopedRoute('POST', '/api/flights/42/sayintentions/import')).toBe(true);
  });

  it('does not match the read sibling GET /api/flights/:id/sayintentions/import', () => {
    expect(isIngestScopedRoute('GET', '/api/flights/42/sayintentions/import')).toBe(false);
  });

  it('matches POST /api/planned-legs/:legId/sayintentions/clearance', () => {
    expect(isIngestScopedRoute('POST', '/api/planned-legs/42/sayintentions/clearance')).toBe(true);
  });

  it('does not match the read sibling GET /api/planned-legs/:legId/sayintentions/clearance', () => {
    expect(isIngestScopedRoute('GET', '/api/planned-legs/42/sayintentions/clearance')).toBe(false);
  });

  it('does not match an arbitrary unlisted DELETE route, even though DELETE is now a valid method in the union', () => {
    expect(isIngestScopedRoute('DELETE', '/api/flights/1')).toBe(false);
  });
});

// ── createIngestTokenScopeGate ───────────────────────────────────────────────

describe('createIngestTokenScopeGate', () => {
  it('does not mark when a valid session is present, even with a correct token header', () => {
    const req = makeReq({ path: '/api/status', headers: { 'x-ingest-token': TOKEN }, sessionUser: { username: 'op' } });
    runGate({ token: TOKEN }, req, makeRes());
    expect(ingestScopeOf(req)).toBeUndefined();
  });

  it('does not mark when no token is configured', () => {
    const req = makeReq({ path: '/api/status', headers: { 'x-ingest-token': TOKEN } });
    runGate({ token: null }, req, makeRes());
    expect(ingestScopeOf(req)).toBeUndefined();
  });

  it('does not mark, and does not read the header, for an off-list route', () => {
    let headerRead = false;
    const req = makeReq({ path: '/api/flights', headers: { 'x-ingest-token': TOKEN } });
    const originalGet = req.get.bind(req);
    req.get = ((name: string) => {
      if (name.toLowerCase() === 'x-ingest-token') headerRead = true;
      return originalGet(name);
    }) as Request['get'];

    runGate({ token: TOKEN }, req, makeRes());

    expect(ingestScopeOf(req)).toBeUndefined();
    expect(headerRead).toBe(false);
  });

  it('marks "valid" for a correct token on a scoped route', () => {
    const req = makeReq({ path: '/api/status', headers: { 'x-ingest-token': TOKEN } });
    runGate({ token: TOKEN }, req, makeRes());
    expect(ingestScopeOf(req)).toBe('valid');
  });

  it('marks "invalid" for a wrong token on a scoped route', () => {
    const req = makeReq({ path: '/api/status', headers: { 'x-ingest-token': 'wrong-token' } });
    runGate({ token: TOKEN }, req, makeRes());
    expect(ingestScopeOf(req)).toBe('invalid');
  });

  it('marks "absent" for a missing token on a scoped route', () => {
    const req = makeReq({ path: '/api/status' });
    runGate({ token: TOKEN }, req, makeRes());
    expect(ingestScopeOf(req)).toBe('absent');
  });

  it('marks "absent" for an empty token header on a scoped route', () => {
    const req = makeReq({ path: '/api/status', headers: { 'x-ingest-token': '' } });
    runGate({ token: TOKEN }, req, makeRes());
    expect(ingestScopeOf(req)).toBe('absent');
  });
});

// ── requireAuth, mark-aware ──────────────────────────────────────────────────

function markedReq(scope: 'valid' | 'invalid' | 'absent' | undefined, over: Parameters<typeof makeReq>[0] = {}): FakeRequest {
  if (scope === undefined) return makeReq({ path: '/api/flights', ...over });
  const header = scope === 'absent' ? undefined : scope === 'valid' ? TOKEN : 'wrong-token';
  // Method/path must actually be on INGEST_SCOPED_ROUTES for the gate to mark
  // anything at all — default to the GET /api/status entry, but let a caller
  // that needs a POST entry (the requireSameOrigin step-3b tests) override it.
  const req = makeReq({
    method: 'GET',
    path: '/api/status',
    ...over,
    headers: header ? { 'x-ingest-token': header, ...(over.headers ?? {}) } : (over.headers ?? {}),
  });
  runGate({ token: TOKEN }, req, makeRes());
  return req;
}

describe('requireAuth, mark-aware', () => {
  it('unmarked (off-list route), no session: unchanged legacy 401, no scope header', () => {
    const req = markedReq(undefined);
    const res = makeRes();
    let called = false;
    requireAuth(req, res, (() => { called = true; }) as never);

    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(res.responseHeaders['X-Ingest-Token-Scope']).toBeUndefined();
  });

  it('marked "valid": passes through, no response sent', () => {
    const req = markedReq('valid');
    const res = makeRes();
    let called = false;
    requireAuth(req, res, (() => { called = true; }) as never);

    expect(called).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('marked "invalid": 401 with code and the scope header', () => {
    const req = markedReq('invalid');
    const res = makeRes();
    requireAuth(req, res, (() => {}) as never);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or missing ingest token', code: 'INVALID_INGEST_TOKEN' });
    expect(res.responseHeaders['X-Ingest-Token-Scope']).toBe('accepted');
  });

  it('marked "absent": 401 with the unchanged legacy body, but the scope header is present', () => {
    const req = markedReq('absent');
    const res = makeRes();
    requireAuth(req, res, (() => {}) as never);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(res.responseHeaders['X-Ingest-Token-Scope']).toBe('accepted');
  });

  it('a valid session takes precedence over any mark', () => {
    const req = markedReq('invalid', { sessionUser: { username: 'op' } });
    const res = makeRes();
    let called = false;
    requireAuth(req, res, (() => { called = true; }) as never);

    expect(called).toBe(true);
    expect(res.statusCode).toBe(0);
  });
});

// ── requireSameOrigin, step 3b ───────────────────────────────────────────────

// A POST route on the list — GET /api/status never reaches requireSameOrigin
// past step 1 (safe methods), so step 3b needs an on-list POST entry.
const SCOPED_POST = { method: 'POST', path: '/api/flights/1/acars-messages' };

describe('requireSameOrigin, step 3b', () => {
  it('exempts a "valid"-marked, cookie-less, cross-origin POST', () => {
    const req = markedReq('valid', { ...SCOPED_POST, origin: 'https://evil.example' });
    const res = makeRes();
    let called = false;
    requireSameOrigin(req, res, (() => { called = true; }) as never);

    expect(called).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('does NOT exempt a "valid"-marked request that also carries a session cookie', () => {
    const req = markedReq('valid', {
      ...SCOPED_POST, origin: 'https://evil.example', cookie: 'msfslogger.sid=abc123',
    });
    const res = makeRes();
    let called = false;
    requireSameOrigin(req, res, (() => { called = true; }) as never);

    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Cross-origin request rejected' });
  });

  it('does not exempt an "invalid"-marked request', () => {
    const req = markedReq('invalid', { ...SCOPED_POST, origin: 'https://evil.example' });
    const res = makeRes();
    let called = false;
    requireSameOrigin(req, res, (() => { called = true; }) as never);

    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('a browser session with a stale cookie and a valid token still takes the Origin check', () => {
    const req = markedReq('valid', {
      ...SCOPED_POST, origin: 'https://evil.example', cookie: 'msfslogger.sid=stale',
    });
    const res = makeRes();
    requireSameOrigin(req, res, (() => {}) as never);
    expect(res.statusCode).toBe(403);
  });
});

// ── Allowlist vs. the real route table (risk: allowlist drift) ──────────────
// GET /api/status is not part of a router (it is a literal handler in
// src/server.ts), so it is asserted by name below rather than walked.

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function routesOf(router: ReturnType<typeof createAcarsRouter>): Array<{ method: string; path: string }> {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: `/api${layer.route.path}` });
    }
  }
  return out;
}

// Substitutes a concrete value for every :param segment, the same shape a
// real request path has, so it can be tested against INGEST_SCOPED_ROUTES'
// regexes instead of the express param syntax.
function concretize(path: string): string {
  return path.replace(/:[^/]+/g, '123');
}

describe('the allowlist against the real route tables', () => {
  const acarsRoutes = routesOf(createAcarsRouter());
  const groundSessionRoutes = routesOf(
    createGroundSessionsRouter({} as unknown as FlightManager),
  );
  const settingsRoutes = routesOf(createSettingsRouter(
    { token: null, allowUnauthenticated: true },
    { token: null, enabled: false },
  ));
  const plannedLegsRoutes = routesOf(
    createPlannedLegsRouter({} as unknown as FlightManager),
  );
  const sayIntentionsRoutes = routesOf(createSayIntentionsRouter());
  const eventsRoutes = routesOf(createEventsRouter(new EventHub(), stubSnapshot));
  const allRoutes = [
    { method: 'GET', path: '/api/status' }, // not from a router; asserted by name
    ...acarsRoutes,
    ...groundSessionRoutes,
    ...settingsRoutes,
    ...plannedLegsRoutes,
    ...sayIntentionsRoutes,
    ...eventsRoutes,
  ];

  // Every route this run's design put on the list.
  const EXPECTED_SCOPED = new Set([
    'GET /api/status',
    'GET /api/acars/canned-messages',
    'GET /api/flights/:id/acars-messages',
    'POST /api/flights/:id/acars-messages',
    'POST /api/flights/:id/acars-messages/wx',
    'GET /api/planned-legs/:legId/acars-messages',
    'POST /api/planned-legs/:legId/acars-messages',
    'POST /api/planned-legs/:legId/acars-messages/wx',
    'POST /api/planned-legs/:legId/acars-messages/loadsheet',
    'POST /api/planned-legs/:legId/acars-messages/clearance',
    'GET /api/ground-sessions/current',
    'GET /api/settings/simbrief',
    'POST /api/planned-legs/simbrief',
    'GET /api/settings/sayintentions',
    'GET /api/flights/:id/sayintentions/link',
    'POST /api/flights/:id/sayintentions/link',
    'DELETE /api/flights/:id/sayintentions/link',
    'POST /api/flights/:id/sayintentions/import',
    'POST /api/planned-legs/:legId/sayintentions/clearance',
    'GET /api/events',
  ]);

  it.each(allRoutes.map(r => [`${r.method} ${r.path}`, r] as const))(
    '%s is scoped iff it is on the finalized list',
    (key, route) => {
      const expected = EXPECTED_SCOPED.has(key);
      expect(isIngestScopedRoute(route.method, concretize(route.path))).toBe(expected);
    },
  );

  it('every INGEST_SCOPED_ROUTES entry matched at least one real route above', () => {
    for (const scoped of INGEST_SCOPED_ROUTES) {
      const matchedReal = allRoutes.some(
        r => r.method === scoped.method && scoped.pattern.test(concretize(r.path)),
      );
      expect(matchedReal, `${scoped.name} (${scoped.method} ${scoped.pattern}) matched no real route`).toBe(true);
    }
  });
});
