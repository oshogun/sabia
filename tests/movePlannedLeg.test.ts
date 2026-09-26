// tests/movePlannedLeg.test.ts — PUT /api/planned-legs/:legId/trip against a
// real scratch database (never mocked) and a real HTTP server, with a fake
// FlightManager (appState.currentFlightId, refreshPlannedLegForFlight(),
// getGroundSessionStatus(), refreshGroundSession() — the four members this
// route touches) so each case can drive the in-progress-flight and
// open-ground-session branches directly. Harness copied from
// tests/legCacheRefreshOnDelete.test.ts.

import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlannedLegsRouter } from '../src/routes/plannedLegs';
import type { FlightManager } from '../src/flightManager';
import type { GroundSessionLiveStatus } from '../src/types';
import { createScratchDb, destroyScratchDb, seedTrip, seedFlight, seedPlannedLeg, type ScratchDb } from './helpers/db';

interface FakeFlightManager {
  appState: { currentFlightId: number | null };
  refreshPlannedLegForFlight: ReturnType<typeof vi.fn>;
  getGroundSessionStatus: ReturnType<typeof vi.fn>;
  refreshGroundSession: ReturnType<typeof vi.fn>;
}

function makeFlightManager(over: {
  currentFlightId?: number | null;
  refreshPlannedLegImpl?: (id: number) => void;
  groundStatus?: GroundSessionLiveStatus | null;
} = {}): FakeFlightManager {
  return {
    appState: { currentFlightId: over.currentFlightId ?? null },
    refreshPlannedLegForFlight: vi.fn(over.refreshPlannedLegImpl),
    getGroundSessionStatus: vi.fn(() => over.groundStatus ?? null),
    refreshGroundSession: vi.fn(),
  };
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function startServer(flightManager: FakeFlightManager, onChanged: () => void = () => {}): Promise<TestServer> {
  const fm = flightManager as unknown as FlightManager;
  const app = express();
  app.use(express.json());
  app.use('/api', createPlannedLegsRouter(fm, onChanged));

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
        close: () => new Promise<void>((res, rej) => {
          server.close(err => (err ? rej(err) : res()));
        }),
      });
    });
    server.on('error', reject);
  });
}

async function putTrip(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Every 4xx of this route must leave the world exactly as it found it — no
 * cache refresh, no scope notification — since nothing was written. Asserted
 * against a FlightManager primed to fire on all three (an in-progress flight
 * AND an open ground session on this very leg), so a bug that skips the
 * early return would be caught here even though the "happy path" tests above
 * only prime one branch at a time.
 */
function expectNoSideEffects(flightManager: FakeFlightManager, onChanged: ReturnType<typeof vi.fn>): void {
  expect(flightManager.refreshPlannedLegForFlight).not.toHaveBeenCalled();
  expect(flightManager.refreshGroundSession).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
}

let scratch: ScratchDb;
let server: TestServer | undefined;

beforeEach(() => {
  scratch = createScratchDb();
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  destroyScratchDb(scratch);
});

describe('PUT /api/planned-legs/:legId/trip', () => {
  it('400 INVALID_ID for a non-numeric leg id', async () => {
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/abc/trip`, { tripId: null });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid id', code: 'INVALID_ID' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it.each([
    { name: 'missing tripId', body: {} },
    { name: 'string tripId', body: { tripId: '3' } },
    { name: 'non-integer tripId', body: { tripId: 1.5 } },
  ])('400 INVALID_TRIP_ID for $name', async ({ body: reqBody }) => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, reqBody);

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'tripId must be an integer or null', code: 'INVALID_TRIP_ID' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('404 LEG_NOT_FOUND for an unknown leg id', async () => {
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: 999999 } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/999999/trip`, { tripId: null });

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Planned leg not found', code: 'LEG_NOT_FOUND' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('404 TRIP_NOT_FOUND for an unknown target trip', async () => {
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: 999999 });

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Trip not found', code: 'TRIP_NOT_FOUND' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('400 SAME_POOL for a no-op move (loose -> loose)', async () => {
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: null });

    expect(status).toBe(400);
    expect(body).toEqual({ error: `Planned leg ${legId} is already a loose leg`, code: 'SAME_POOL' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('400 SAME_POOL for a no-op move (trip -> same trip)', async () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId });

    expect(status).toBe(400);
    expect(body).toEqual({ error: `Planned leg ${legId} is already in this trip`, code: 'SAME_POOL' });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('409 LINKED_FLIGHT for a leg with a linked flight', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(409);
    expect(body).toEqual({
      error: `Planned leg ${legId} cannot be moved: linked to flight ${flightId}. Unlink the flight first.`,
      code: 'LINKED_FLIGHT',
    });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('409 NOT_MOVABLE_STATUS for an unlinked flown leg', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, status: 'flown', source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(409);
    expect(body).toEqual({
      error: `Planned leg ${legId} cannot be moved: its status is 'flown'. Only a planned or skipped leg can be moved.`,
      code: 'NOT_MOVABLE_STATUS',
    });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('409 DUPLICATE_IN_TARGET when the target trip already holds the same plan', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const sha = 'ab'.repeat(32);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: sha });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 5, source_sha256: sha });
    const flightManager = makeFlightManager({ currentFlightId: 12, groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(409);
    expect(body).toEqual({
      error: `Planned leg ${legId} cannot be moved: the target trip already holds the same plan as leg 5`,
      code: 'DUPLICATE_IN_TARGET',
    });
    expectNoSideEffects(flightManager, onChanged);
  });

  it('200 trip -> trip: body reports the new trip_id and seq, onChanged called once', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'b'.repeat(64) });
    const flightManager = makeFlightManager();
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect((body as { trip_id: number }).trip_id).toBe(tripB);
    expect((body as { seq: number }).seq).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('200 trip -> loose: body reports trip_id null and the loose pool\'s next seq', async () => {
    const tripA = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'b'.repeat(64) });
    const flightManager = makeFlightManager();
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: null });

    expect(status).toBe(200);
    expect((body as { trip_id: number | null }).trip_id).toBeNull();
    expect((body as { seq: number }).seq).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('200 loose -> trip: body reports the target trip_id and its next seq', async () => {
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'b'.repeat(64) });
    const flightManager = makeFlightManager();
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status, body } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect((body as { trip_id: number }).trip_id).toBe(tripB);
    expect((body as { seq: number }).seq).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a current flight in progress calls refreshPlannedLegForFlight(currentFlightId) once', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: 12 });
    server = await startServer(flightManager);

    const { status } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect(flightManager.refreshPlannedLegForFlight).toHaveBeenCalledTimes(1);
    expect(flightManager.refreshPlannedLegForFlight).toHaveBeenCalledWith(12);
  });

  it('currentFlightId null does not call refreshPlannedLegForFlight', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ currentFlightId: null });
    server = await startServer(flightManager);

    const { status } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect(flightManager.refreshPlannedLegForFlight).not.toHaveBeenCalled();
  });

  it('refreshPlannedLegForFlight throwing still answers 200 and onChanged fires once', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flightManager = makeFlightManager({
      currentFlightId: 12,
      refreshPlannedLegImpl: () => { throw new Error('cache refresh boom'); },
    });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect(flightManager.refreshPlannedLegForFlight).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('getGroundSessionStatus throwing still answers 200 and onChanged fires once', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flightManager = makeFlightManager();
    flightManager.getGroundSessionStatus = vi.fn(() => { throw new Error('ground status boom'); });
    const onChanged = vi.fn();
    server = await startServer(flightManager, onChanged);

    const { status } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('an open ground session on this leg calls refreshGroundSession() once', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({
      groundStatus: { plannedLegId: legId } as GroundSessionLiveStatus,
    });
    server = await startServer(flightManager);

    const { status } = await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(status).toBe(200);
    expect(flightManager.refreshGroundSession).toHaveBeenCalledTimes(1);
  });

  it('an open ground session on a different leg does not call refreshGroundSession()', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({
      groundStatus: { plannedLegId: legId + 1 } as GroundSessionLiveStatus,
    });
    server = await startServer(flightManager);

    await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(flightManager.refreshGroundSession).not.toHaveBeenCalled();
  });

  it('no open ground session does not call refreshGroundSession()', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager({ groundStatus: null });
    server = await startServer(flightManager);

    await putTrip(`${server.baseUrl}/api/planned-legs/${legId}/trip`, { tripId: tripB });

    expect(flightManager.refreshGroundSession).not.toHaveBeenCalled();
  });

  // Regression: PATCH /api/planned-legs/:legId must stay exactly as it was —
  // it still only ever accepts `status`, never `tripId`.
  it('regression: PATCH /api/planned-legs/:legId with {tripId} is unaffected, still 400s on tripId', async () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: 'a'.repeat(64) });
    const flightManager = makeFlightManager();
    server = await startServer(flightManager);

    const res = await fetch(`${server.baseUrl}/api/planned-legs/${legId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tripId: tripB }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "status must be 'planned' or 'skipped'" });
    const leg = scratch.db.prepare('SELECT trip_id FROM planned_legs WHERE id = ?').get(legId) as { trip_id: number | null };
    expect(leg.trip_id).toBe(tripA);
  });
});
