// tests/events.test.ts — GET /api/events: auth (same stack as every other
// gated route), topic filtering end to end over the hub, the keepalive, and
// the cleanup-on-close contract that the hub's listenerCount() hook enables.
//
// A real HTTP server on an ephemeral port (the tests/ingestCors.test.ts
// pattern), driven with Node's own http client rather than fetch: an SSE
// response never completes, so its body has to be read as a stream, and
// http.request gives req.destroy() for the close-cleanup test with no extra
// AbortController code.

import express from 'express';
import http from 'http';
import type { Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// createIngestTokenScopeGate now reads the live token store on every
// request; this file never touches a database, so it is replaced with a
// fixed "zero active UI tokens" answer, which reproduces today's
// env/opt-out-only behaviour for every existing assertion below.
vi.mock('../src/db/ingestTokens', () => ({
  verifyIngestToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import { createEventsRouter, EVENTS_MAX_STREAMS, parseTopicsParam } from '../src/routes/events';
import { EventHub } from '../src/eventHub';
import type { FlightStatePayload } from '../src/eventHub';
import { requireAuth } from '../src/auth/middleware';
import { createIngestTokenScopeGate } from '../src/auth/ingestScope';

const TOKEN = 'events-test-token';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error('condition not met within timeout');
}

interface TestServerOptions {
  keepaliveMs?: number;
  statusImpl?: () => object;
  flightStateImpl?: () => FlightStatePayload;
}

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function createTestServer(hub: EventHub, options: TestServerOptions = {}): Promise<TestServerHandle> {
  const app = express();
  // Same order as src/server.ts: the scope gate, then requireAuth, then the
  // route — so a token or a session behaves exactly as it does in production.
  app.use(createIngestTokenScopeGate({ token: TOKEN, allowUnauthenticated: false }));
  app.use('/api', requireAuth);
  app.use('/api', createEventsRouter(hub, {
    status: options.statusImpl ?? (() => ({ ok: true })),
    flightState: options.flightStateImpl ?? (() => ({ flightState: 'IDLE', currentFlightId: null, plannedLegId: null })),
  }, { keepaliveMs: options.keepaliveMs }));

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
const openStreams: Array<() => void> = [];

afterEach(async () => {
  openStreams.splice(0).forEach(close => close());
  await Promise.all(openServers.splice(0).map(close => close()));
});

async function startServer(hub: EventHub, options?: TestServerOptions) {
  const server = await createTestServer(hub, options);
  openServers.push(server.close);
  return server;
}

// ── A streamed GET, read and closed with Node's own http client ────────────

interface StreamHandle {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received since the last call, then clears the buffer. */
  read(): string;
  /** Pumps the event loop for `ms`, accumulating into the internal buffer. */
  pump(ms: number): Promise<void>;
  close(): void;
}

function openStream(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<StreamHandle> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, { headers }, res => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buffer += chunk; });
      const handle: StreamHandle = {
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        read: () => { const out = buffer; buffer = ''; return out; },
        pump: (ms: number) => sleep(ms),
        close: () => req.destroy(),
      };
      openStreams.push(handle.close);
      resolve(handle);
    });
    req.on('error', reject);
  });
}

// ── Auth: the same stack, the same bytes, as every other gated route ───────

describe('GET /api/events — authentication', () => {
  it('401s with the plain body when no cookie and no ingest token are sent', async () => {
    const { baseUrl } = await startServer(new EventHub());

    const response = await fetch(`${baseUrl}/api/events`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required' });
  });

  it('401s with the invalid-token body and scope header for a wrong token', async () => {
    const { baseUrl } = await startServer(new EventHub());

    const response = await fetch(`${baseUrl}/api/events`, { headers: { 'x-ingest-token': 'wrong-token' } });

    expect(response.status).toBe(401);
    expect(response.headers.get('x-ingest-token-scope')).toBe('accepted');
    expect(await response.json()).toEqual({ error: 'Invalid or missing ingest token', code: 'INVALID_INGEST_TOKEN' });
  });

  it('a valid x-ingest-token with no cookie opens a 200 text/event-stream connection', async () => {
    const hub = new EventHub();
    const { baseUrl } = await startServer(hub);

    const stream = await openStream(baseUrl, '/api/events', { 'x-ingest-token': TOKEN });
    await stream.pump(80);

    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(stream.read()).toContain('retry: 3000');
  });
});

// ── Topic filtering, end to end over a real hub ─────────────────────────────

describe('GET /api/events — topic filter', () => {
  it('a stream whose filter excludes "status" never sees it, while a subscribed topic arrives every time', async () => {
    const hub = new EventHub();
    const { baseUrl } = await startServer(hub);

    const stream = await openStream(baseUrl, '/api/events?topics=flight-state', { 'x-ingest-token': TOKEN });
    await stream.pump(80);
    const preamble = stream.read();
    expect(preamble).toContain('event: flight-state'); // the open-stream snapshot
    expect(preamble).not.toContain('event: status');

    hub.publish('status', { a: 1 });
    hub.publish('status', { a: 2 });
    hub.publish('status', { a: 3 });
    hub.publish('flight-state', { flightState: 'FLYING', currentFlightId: 7, plannedLegId: null });
    await stream.pump(80);

    const afterPublish = stream.read();
    expect(afterPublish).not.toContain('event: status');
    expect(afterPublish.match(/event: flight-state/g)).toHaveLength(1);
    expect(afterPublish).toContain('"flightState":"FLYING"');
  });

  it('with no topics param, the stream gets both the status and flight-state snapshots', async () => {
    const hub = new EventHub();
    const { baseUrl } = await startServer(hub, {
      statusImpl: () => ({ connected: true }),
    });

    const stream = await openStream(baseUrl, '/api/events', { 'x-ingest-token': TOKEN });
    await stream.pump(80);

    const preamble = stream.read();
    expect(preamble).toContain('event: status');
    expect(preamble).toContain('event: flight-state');
  });
});

// ── Keepalive ────────────────────────────────────────────────────────────────

describe('GET /api/events — keepalive', () => {
  it('writes a keepalive comment line within the configured interval', async () => {
    const hub = new EventHub();
    const { baseUrl } = await startServer(hub, { keepaliveMs: 50 });

    const stream = await openStream(baseUrl, '/api/events?topics=acars', { 'x-ingest-token': TOKEN });
    stream.read(); // drop the open-stream preamble (retry line, no snapshot for 'acars')
    await stream.pump(220);

    const body = stream.read();
    expect(body.match(/^: keepalive$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// ── Cleanup on close ─────────────────────────────────────────────────────────

describe('GET /api/events — cleanup on close', () => {
  it('closing the client connection drives the hub back to zero listeners', async () => {
    const hub = new EventHub();
    const { baseUrl } = await startServer(hub);

    const stream = await openStream(baseUrl, '/api/events', { 'x-ingest-token': TOKEN });
    await stream.pump(50);
    expect(hub.listenerCount()).toBe(1);

    stream.close();

    await waitUntil(() => hub.listenerCount() === 0);
    expect(hub.listenerCount()).toBe(0);
  });
});

// ── Errors: bad topics, and the stream limit (503 when the hub is full) ─────

describe('GET /api/events — 400 on a bad topics param', () => {
  it('names the unknown topic', async () => {
    const { baseUrl } = await startServer(new EventHub());
    const response = await fetch(`${baseUrl}/api/events?topics=status,foo`, { headers: { 'x-ingest-token': TOKEN } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Unknown topic: foo', code: 'INVALID_TOPICS' });
  });

  it('refuses an empty topics value', async () => {
    const { baseUrl } = await startServer(new EventHub());
    const response = await fetch(`${baseUrl}/api/events?topics=`, { headers: { 'x-ingest-token': TOKEN } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'topics must name at least one topic', code: 'INVALID_TOPICS' });
  });

  it('refuses a repeated topics param', async () => {
    const { baseUrl } = await startServer(new EventHub());
    const response = await fetch(`${baseUrl}/api/events?topics=acars&topics=status`, { headers: { 'x-ingest-token': TOKEN } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'topics must be given once', code: 'INVALID_TOPICS' });
  });

  it('is answered before the stream-limit check — a bad query is a 400 even against a full hub', async () => {
    const hub = new EventHub();
    for (let i = 0; i < EVENTS_MAX_STREAMS; i++) hub.subscribe(new Set(['status']), () => {});
    const { baseUrl } = await startServer(hub);

    const response = await fetch(`${baseUrl}/api/events?topics=foo`, { headers: { 'x-ingest-token': TOKEN } });

    expect(response.status).toBe(400);
  });
});

describe('GET /api/events — stream limit', () => {
  it('503s with Retry-After when the hub already holds EVENTS_MAX_STREAMS listeners', async () => {
    const hub = new EventHub();
    for (let i = 0; i < EVENTS_MAX_STREAMS; i++) hub.subscribe(new Set(['status']), () => {});
    const { baseUrl } = await startServer(hub);

    const response = await fetch(`${baseUrl}/api/events`, { headers: { 'x-ingest-token': TOKEN } });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({ error: 'Too many event streams', code: 'EVENTS_STREAM_LIMIT' });
  });
});

// HEAD is not on INGEST_SCOPED_ROUTES (only GET /api/events is — the same
// convention every other GET-scoped route in this file's allowlist follows,
// see tests/ingestScope.test.ts's OFF_LIST case for /api/status), so a HEAD
// probe needs a session, not a token, to clear requireAuth. That is an auth
// question, already covered above; this block isolates the router's own HEAD
// handling: HEAD requests answer with SSE headers but do not subscribe to the hub.
describe('GET /api/events — HEAD (router behaviour, no auth stack)', () => {
  it('answers the SSE headers with no body and does not subscribe', async () => {
    const hub = new EventHub();
    const app = express();
    app.use(createEventsRouter(hub, {
      status: () => ({ ok: true }),
      flightState: () => ({ flightState: 'IDLE', currentFlightId: null, plannedLegId: null }),
    }));
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    openServers.push(() => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))));

    const response = await fetch(`${baseUrl}/events`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toBe('');
    expect(hub.listenerCount()).toBe(0);
  });
});

// ── parseTopicsParam directly ────────────────────────────────────────────────

describe('parseTopicsParam()', () => {
  it('defaults to all five topics when absent', () => {
    const result = parseTopicsParam(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.topics).toEqual(new Set(['status', 'flight-state', 'acars', 'flights-changed', 'navdata-demand']));
  });

  it('trims whitespace and collapses duplicates', () => {
    const result = parseTopicsParam(' status , acars ,status');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.topics).toEqual(new Set(['status', 'acars']));
  });

  it('rejects an array (repeated query key)', () => {
    const result = parseTopicsParam(['status', 'acars']);
    expect(result).toEqual({ ok: false, error: 'topics must be given once' });
  });
});
