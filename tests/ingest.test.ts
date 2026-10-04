import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// checkIngestCredential (src/auth/ingestAuth.ts) now verifies against the live
// token store on every request; this file never touches a database, so the
// store is replaced with a fixed "zero active UI tokens" answer, which
// reproduces today's env/opt-out-only behaviour for every existing assertion
// below.
vi.mock('../src/db/ingestTokens', () => ({
  verifyIngestToken: vi.fn(() => ({ activeCount: 0, matchedId: null })),
}));

import { createIngestRouter } from '../src/ingest';
import { roundAlt, roundCoord } from '../src/trafficStore';
import { makeFrame } from './helpers';
import type { TrafficObject } from '../src/types';

const TOKEN = 'test-ingest-token';

interface TestServerOptions {
  // Sets process.env.TRAFFIC_ENABLED before the router is constructed —
  // that value is read once, at construction, so the override must land
  // before createIngestRouter() runs. Omit to leave it unset (enabled).
  trafficEnabledEnv?: string;
}

interface TestServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
  flightManager: {
    appState: { connected: boolean; lastFrame: { lat: number; lon: number } | null };
    onFrame: ReturnType<typeof vi.fn>;
    onSimDisconnect: ReturnType<typeof vi.fn>;
    isHoldingFlight: ReturnType<typeof vi.fn>;
    setPaused: ReturnType<typeof vi.fn>;
    onCrash: ReturnType<typeof vi.fn>;
  };
  onFrame: ReturnType<typeof vi.fn>;
  trafficReplace: ReturnType<typeof vi.fn>;
  onStatusChanged: ReturnType<typeof vi.fn>;
}

function createTestServer(options: TestServerOptions = {}): Promise<TestServerHandle> {
  if (options.trafficEnabledEnv === undefined) {
    delete process.env.TRAFFIC_ENABLED;
  } else {
    process.env.TRAFFIC_ENABLED = options.trafficEnabledEnv;
  }

  const onFrame = vi.fn();
  const onSimDisconnect = vi.fn();
  const isHoldingFlight = vi.fn(() => false);
  const setPaused = vi.fn();
  const onCrash = vi.fn();
  const flightManager = {
    appState: { connected: false, lastFrame: null },
    onFrame,
    onSimDisconnect,
    isHoldingFlight,
    setPaused,
    onCrash,
  };
  const trafficReplace = vi.fn();
  const trafficStore = {
    replace: trafficReplace,
  } as unknown as Parameters<typeof createIngestRouter>[1];
  const ingestConfig = {
    token: TOKEN,
  } as Parameters<typeof createIngestRouter>[2];
  const onStatusChanged = vi.fn();

  const app = express();
  app.use(express.json());
  app.use(
    '/api/ingest',
    createIngestRouter(
      flightManager as unknown as Parameters<typeof createIngestRouter>[0],
      trafficStore,
      ingestConfig,
      onStatusChanged,
    ),
  );

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
        flightManager,
        onFrame,
        trafficReplace,
        onStatusChanged,
      });
    });
    server.on('error', reject);
  });
}

const openServers: Array<() => Promise<void>> = [];
const originalTrafficEnabled = process.env.TRAFFIC_ENABLED;

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close => close()));
  if (originalTrafficEnabled === undefined) delete process.env.TRAFFIC_ENABLED;
  else process.env.TRAFFIC_ENABLED = originalTrafficEnabled;
});

async function startServer(options?: TestServerOptions) {
  const server = await createTestServer(options);
  openServers.push(server.close);
  return server;
}

async function postJson(baseUrl: string, path: string, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Ingest-Token'] = token;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function readErrorBody(response: Response): Promise<{ error: unknown }> {
  return response.json() as Promise<{ error: unknown }>;
}

function validTrafficElement(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    lat: 34.1,
    lon: -119.8,
    altitudeFt: 1500,
    headingDeg: 270,
    onGround: false,
    ...over,
  };
}

const REQUIRED_FRAME_FIELDS: Array<{ field: keyof ReturnType<typeof makeFrame>; wrongType: unknown }> = [
  { field: 'lat', wrongType: 'thirty-four' },
  { field: 'lon', wrongType: 'minus-one-nineteen' },
  { field: 'altitudeFt', wrongType: '1500' },
  { field: 'airspeedKnots', wrongType: '110' },
  { field: 'groundSpeedKnots', wrongType: '105' },
  { field: 'headingDeg', wrongType: '270' },
  { field: 'verticalSpeedFpm', wrongType: '500' },
  { field: 'onGround', wrongType: 'false' },
  { field: 'simRunning', wrongType: '1' },
  { field: 'aircraft', wrongType: 42 },
];

describe('POST /frame — isValidFrame rejection', () => {
  it.each(REQUIRED_FRAME_FIELDS)('rejects a frame missing $field', async ({ field }) => {
    const { baseUrl, onFrame } = await startServer();
    const frame = makeFrame() as unknown as Record<string, unknown>;
    delete frame[field];

    const response = await postJson(baseUrl, '/api/ingest/frame', frame);

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(onFrame).not.toHaveBeenCalled();
  });

  it.each(REQUIRED_FRAME_FIELDS)('rejects a frame with $field of the wrong type', async ({ field, wrongType }) => {
    const { baseUrl, onFrame } = await startServer();
    const frame = { ...makeFrame(), [field]: wrongType };

    const response = await postJson(baseUrl, '/api/ingest/frame', frame);

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('accepts a fully valid frame as a control case', async () => {
    const { baseUrl, onFrame } = await startServer();
    const frame = makeFrame();

    const response = await postJson(baseUrl, '/api/ingest/frame', frame);

    expect(response.status).toBe(204);
    expect(onFrame).toHaveBeenCalledWith(frame);
  });
});

describe('POST /traffic — buildTrafficObjects validation', () => {
  it('rejects a non-object body (array)', async () => {
    const { baseUrl, trafficReplace } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/traffic', [1, 2, 3]);

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  it('rejects a body without an objects array', async () => {
    const { baseUrl, trafficReplace } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/traffic', { notObjects: [] });

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  it('rejects a batch exceeding MAX_BATCH_OBJECTS (200)', async () => {
    const { baseUrl, trafficReplace } = await startServer();
    const objects = Array.from({ length: 201 }, (_, i) => validTrafficElement({ id: i }));

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects });

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  const INVALID_ELEMENTS: Array<[string, Record<string, unknown>]> = [
    ['a non-integer id', validTrafficElement({ id: 1.5 })],
    ['a negative id', validTrafficElement({ id: -1 })],
    ['lat above 90', validTrafficElement({ lat: 90.1 })],
    ['lat below -90', validTrafficElement({ lat: -90.1 })],
    ['lon above 180', validTrafficElement({ lon: 180.1 })],
    ['lon below -180', validTrafficElement({ lon: -180.1 })],
    ['a non-finite altitudeFt', validTrafficElement({ altitudeFt: 'high' })],
    ['a non-finite headingDeg', validTrafficElement({ headingDeg: 'north' })],
    ['a wrong-typed onGround', validTrafficElement({ onGround: 'false' })],
  ];

  it.each(INVALID_ELEMENTS)('rejects a batch with %s', async (_label, element) => {
    const { baseUrl, trafficReplace } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [element] });

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(typeof body.error).toBe('string');
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  it('de-duplicates by id, keeping the last occurrence value at the first occurrence position', async () => {
    const { baseUrl, trafficReplace } = await startServer();
    const first = validTrafficElement({ id: 5, lat: 10.123456, altitudeFt: 1000, headingDeg: 10 });
    const middle = validTrafficElement({ id: 6, lat: 20, altitudeFt: 2000, headingDeg: 20 });
    const last = validTrafficElement({ id: 5, lat: 30.654321, altitudeFt: 3000, headingDeg: 30, onGround: true });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [first, middle, last] });

    expect(response.status).toBe(204);
    const expected: TrafficObject[] = [
      {
        id: 5,
        lat: roundCoord(last.lat as number),
        lon: roundCoord(last.lon as number),
        altitudeFt: roundAlt(last.altitudeFt as number),
        headingDeg: 30,
        onGround: true,
      },
      {
        id: 6,
        lat: roundCoord(middle.lat as number),
        lon: roundCoord(middle.lon as number),
        altitudeFt: roundAlt(middle.altitudeFt as number),
        headingDeg: 20,
        onGround: false,
      },
    ];
    expect(trafficReplace).toHaveBeenCalledTimes(1);
    expect(trafficReplace).toHaveBeenCalledWith(expected);
  });
});

describe('TRAFFIC_ENABLED kill switch', () => {
  it('reaches trafficStore.replace when unset (default enabled)', async () => {
    const { baseUrl, trafficReplace } = await startServer({ trafficEnabledEnv: undefined });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] });

    expect(response.status).toBe(204);
    expect(trafficReplace).toHaveBeenCalledTimes(1);
  });

  it.each(['0', 'off'])('returns 204 without calling replace when set to %s', async (value) => {
    const { baseUrl, trafficReplace } = await startServer({ trafficEnabledEnv: value });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] });

    expect(response.status).toBe(204);
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  it('is case- and whitespace-insensitive for a disabled value', async () => {
    const { baseUrl, trafficReplace } = await startServer({ trafficEnabledEnv: '  FALSE  ' });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] });

    expect(response.status).toBe(204);
    expect(trafficReplace).not.toHaveBeenCalled();
  });

  it('treats any other value as enabled', async () => {
    const { baseUrl, trafficReplace } = await startServer({ trafficEnabledEnv: 'nope' });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] });

    expect(response.status).toBe(204);
    expect(trafficReplace).toHaveBeenCalledTimes(1);
  });
});

describe('auth before kill switch', () => {
  it('returns 401, not 204, for an invalid token on a traffic-disabled server', async () => {
    const { baseUrl, trafficReplace } = await startServer({ trafficEnabledEnv: '0' });

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] }, 'wrong-token');

    expect(response.status).toBe(401);
    expect(trafficReplace).not.toHaveBeenCalled();
  });
});

describe('stale-disconnect timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks disconnected after STALE_TIMEOUT_MS with no further frame', async () => {
    const { baseUrl, flightManager } = await startServer();

    await postJson(baseUrl, '/api/ingest/frame', makeFrame());
    expect(flightManager.appState.connected).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(flightManager.appState.connected).toBe(false);
    expect(flightManager.onSimDisconnect).toHaveBeenCalledTimes(1);
  });

  it('stays connected when advanced by less than STALE_TIMEOUT_MS after a fresh frame', async () => {
    const { baseUrl, flightManager } = await startServer();

    await postJson(baseUrl, '/api/ingest/frame', makeFrame());
    await vi.advanceTimersByTimeAsync(7_000);
    expect(flightManager.appState.connected).toBe(true);

    await postJson(baseUrl, '/api/ingest/frame', makeFrame());
    await vi.advanceTimersByTimeAsync(4_000);

    expect(flightManager.appState.connected).toBe(true);
    expect(flightManager.onSimDisconnect).not.toHaveBeenCalled();
  });
});

describe('onStatusChanged', () => {
  it('is called once after a valid frame, not on a rejected one', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const ok = await postJson(baseUrl, '/api/ingest/frame', makeFrame());
    expect(ok.status).toBe(204);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);

    const bad = { ...makeFrame(), lat: 'not-a-number' };
    const rejected = await postJson(baseUrl, '/api/ingest/frame', bad);
    expect(rejected.status).toBe(400);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('is not called for a frame rejected by auth', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/frame', makeFrame(), 'wrong-token');

    expect(response.status).toBe(401);
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it.each(['connected', 'disconnected', 'paused', 'unpaused', 'crashed'])(
    'is called once after an accepted "%s" event',
    async (type) => {
      const { baseUrl, onStatusChanged } = await startServer();

      const response = await postJson(baseUrl, '/api/ingest/event', { type });

      expect(response.status).toBe(204);
      expect(onStatusChanged).toHaveBeenCalledTimes(1);
    },
  );

  it('is called once after a valid "pause" event', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/event', { type: 'pause', flags: 4 });

    expect(response.status).toBe(204);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('is not called for an unknown event type (400) or a bad "pause" payload (400)', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const unknown = await postJson(baseUrl, '/api/ingest/event', { type: 'bogus' });
    expect(unknown.status).toBe(400);

    const badPause = await postJson(baseUrl, '/api/ingest/event', { type: 'pause', flags: 'not-a-number' });
    expect(badPause.status).toBe(400);

    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it('is not called for an event rejected by auth', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/event', { type: 'connected' }, 'wrong-token');

    expect(response.status).toBe(401);
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it('is never called from POST /traffic', async () => {
    const { baseUrl, onStatusChanged } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/traffic', { objects: [validTrafficElement()] });

    expect(response.status).toBe(204);
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  describe('stale-disconnect timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is called once when the timer marks the agent disconnected', async () => {
      const { baseUrl, onStatusChanged } = await startServer();

      await postJson(baseUrl, '/api/ingest/frame', makeFrame());
      onStatusChanged.mockClear(); // isolate the timer's own call from the frame's

      await vi.advanceTimersByTimeAsync(15_000);

      expect(onStatusChanged).toHaveBeenCalledTimes(1);
    });

    it('never fires from the timer while nothing is connected (nothing to mark stale)', async () => {
      const { onStatusChanged } = await startServer();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(onStatusChanged).not.toHaveBeenCalled();
    });
  });
});

describe('events while a flight is held after the sim went silent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['pause', { type: 'pause', flags: 4 }],
    ['connected', { type: 'connected' }],
  ])('a %s event does not mark the agent connected while holding', async (type, body) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { baseUrl, flightManager, onStatusChanged } = await startServer();
    flightManager.isHoldingFlight.mockReturnValue(true);

    const response = await postJson(baseUrl, '/api/ingest/event', body);

    expect(response.status).toBe(204);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(flightManager.appState.connected).toBe(false);
    expect(log.mock.calls.some(([line]) => String(line).includes('[Ingest] Agent connected'))).toBe(false);
    if (type === 'pause') expect(flightManager.setPaused).toHaveBeenCalledWith(true, 4);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(flightManager.onSimDisconnect).not.toHaveBeenCalled();
  });

  it.each([
    ['pause', { type: 'pause', flags: 4 }],
    ['connected', { type: 'connected' }],
  ])('a %s event marks the agent connected when no flight is held', async (_type, body) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { baseUrl, flightManager } = await startServer();

    const response = await postJson(baseUrl, '/api/ingest/event', body);

    expect(response.status).toBe(204);
    expect(flightManager.appState.connected).toBe(true);
    expect(log.mock.calls.some(([line]) => String(line).includes('[Ingest] Agent connected'))).toBe(true);
  });

  it('a disconnected event calls onSimDisconnect once', async () => {
    const { baseUrl, flightManager } = await startServer();
    await postJson(baseUrl, '/api/ingest/frame', makeFrame());

    const response = await postJson(baseUrl, '/api/ingest/event', { type: 'disconnected' });

    expect(response.status).toBe(204);
    expect(flightManager.onSimDisconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(flightManager.onSimDisconnect).toHaveBeenCalledTimes(1);
  });
});
