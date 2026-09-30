// Branches of FlightManager that no other flightManager*.test.ts file reaches.
// The list came from an instrumented copy of src/flightManager.ts run against
// those files: every decision arm that never executed, minus the arms that
// cannot be reached through the public API (a null flight id in a private
// method whose callers all hold one, for example).
//
// Same five IO boundaries and the same harness as flightManager.callorder,
// but these tests assert values directly and have no goldens.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeCandidate, makePlannedLegWithChildren, makeLoosePlannedLegWithChildren, northOfNm, KSBA,
  useFakeClock, useRealClock,
} from './helpers';

vi.mock('../src/db', async () => (await import('./helpers/callOrder')).dbStub);
vi.mock('../src/db/groundSessions', async () => (await import('./helpers/callOrder')).groundSessionsStub);
vi.mock('../src/airports', async () => (await import('./helpers/callOrder')).airportsStub);
vi.mock('../src/acarsEvents', async () => (await import('./helpers/callOrder')).acarsEventsStub);
vi.mock('../src/acars', async (importOriginal) =>
  (await import('./helpers/callOrder')).wrapAcars(await importOriginal<typeof import('../src/acars')>()));

import { FlightManager } from '../src/flightManager';
import {
  behave, ground, takeLog, captureConsole, attachListener, resetCallOrder, makeSessionRow,
  type Entry, type ConsoleEntry,
  LANDED, iso, feed, takeoff, cruise, park, land, arrangeLeg, openRow, callsTo, thrown, warns, endState,
} from './helpers/callOrder';

function newFm(): FlightManager {
  const fm = new FlightManager();
  attachListener(fm);
  return fm;
}

const logLines = (log: Entry[]): string[] => log.filter(e => e.t === 'log').map(e => (e as ConsoleEntry).text);

const savedInterval = process.env.POSITION_REPORT_INTERVAL_MIN;

beforeEach(() => {
  resetCallOrder();
  useFakeClock();
  captureConsole();
  delete process.env.POSITION_REPORT_INTERVAL_MIN;
});
afterEach(() => {
  useRealClock();
  if (savedInterval === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
  else process.env.POSITION_REPORT_INTERVAL_MIN = savedInterval;
});

const wp = (ident: string, at: { lat: number; lon: number }, seq: number) => ({
  ...makePlannedLegWithChildren().waypoints[0], id: seq, seq, ident, lat: at.lat, lon: at.lon,
});

describe('uncovered branches', () => {
  it('G-01 a route with two identical consecutive waypoints still reports a finite next waypoint', () => {
    const kmry = makePlannedLegWithChildren().waypoints[1];
    arrangeLeg({ waypoints: [wp('KSBA', KSBA, 1), wp('DUPWP', KSBA, 2), wp('KMRY', kmry, 3)], waypoint_count: 3 });
    const fm = newFm();
    takeoff(fm);
    const south = northOfNm(KSBA, -5);
    const north = northOfNm(KSBA, 5);
    const behind = fm.getPlannedLegStatus(south.lat, south.lon);
    const ahead = fm.getPlannedLegStatus(north.lat, north.lon);
    // South of the zero-length segment the nearest point of both segments is
    // the shared waypoint, and the first one listed wins the tie.
    expect(behind?.nextWaypointIdent).toBe('DUPWP');
    expect(Number.isFinite(behind?.remainingDistanceNm)).toBe(true);
    // North of it the second segment is the nearer one.
    expect(ahead?.nextWaypointIdent).toBe('KMRY');
    expect(ahead?.plannedLegId).toBe(11);
  });

  it('G-02 two eligible legs at the departure field log AMBIGUOUS with both ids', () => {
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = () => [
      makeCandidate({ plannedLegId: 11, seq: 1 }),
      makeCandidate({ plannedLegId: 12, seq: 2 }),
    ];
    const fm = newFm();
    takeoff(fm);
    const log = takeLog();
    expect(logLines(log)).toContain('[FlightManager] Flight #1 not linked — AMBIGUOUS (legs 11, 12 within 10 nm)');
    expect(callsTo(log, 'db.linkFlightToPlannedLeg')).toEqual([]);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('G-03 a planned departure 50 nm away logs NO_LEG_IN_RADIUS with the nearest distance', () => {
    const far = northOfNm(KSBA, 50);
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = () => [makeCandidate({ departureLat: far.lat, departureLon: far.lon })];
    const fm = newFm();
    takeoff(fm);
    const log = takeLog();
    expect(logLines(log)).toContain('[FlightManager] Flight #1 not linked — NO_LEG_IN_RADIUS (nearest planned departure 50.0 nm away)');
    expect(callsTo(log, 'db.linkFlightToPlannedLeg')).toEqual([]);
  });

  it('G-04 a linked takeoff whose trip name is missing reports an empty trip name', () => {
    arrangeLeg();
    behave.db.getTripName = () => null;
    const fm = newFm();
    takeoff(fm);
    const status = fm.getPlannedLegStatus(KSBA.lat, KSBA.lon);
    expect(status?.plannedLegId).toBe(11);
    expect(status?.tripId).toBe(1);
    expect(status?.tripName).toBe('');
  });

  it('G-05 a ground entry matched to a loose leg has no trip and never asks for a trip name', () => {
    arrangeLeg();
    behave.db.getPlannedLegById = (id: number) => (id === 11 ? makeLoosePlannedLegWithChildren({ departure_start: 'GATE 3' }) : null);
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    const status = fm.getGroundSessionStatus();
    expect(status).toMatchObject({ plannedLegId: 11, tripId: null, tripName: null, departureIdent: 'KSBA', destinationIdent: 'KMRY' });
    expect(callsTo(log, 'db.getTripName')).toEqual([]);
  });

  it('G-06 a ground entry whose leg has a trip that no longer has a name reports a null trip name', () => {
    arrangeLeg();
    behave.db.getTripName = () => null;
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    expect(fm.getGroundSessionStatus()).toMatchObject({ plannedLegId: 11, tripId: 1, tripName: null });
    expect(callsTo(log, 'db.getTripName').map(c => c.args)).toEqual([[1]]);
  });

  it('G-07 adopting a manual session with a matched leg that has a stand fills the stand as auto', () => {
    arrangeLeg();
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA' });
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    const fills = callsTo(log, 'groundSessions.fillOpenGroundSessionGaps');
    expect(fills).toHaveLength(1);
    expect(fills[0].args[0]).toMatchObject({
      parking_position: 'GATE 3', parking_position_source: 'auto', planned_leg_id: 11, planned_leg_link_source: 'auto',
    });
    expect(fm.getGroundSessionStatus()).toMatchObject({ groundSessionId: 100, parkingPosition: 'GATE 3', parkingPositionSource: 'auto' });
  });

  it('G-08 adopting a session when the gap fill returns nothing keeps the open row', () => {
    ground.open = makeSessionRow({ source: 'manual', airport_icao: 'KSBA', parking_position: 'STAND 7', parking_position_source: 'manual' });
    behave.groundSessions.fillOpenGroundSessionGaps = () => null;
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    expect(logLines(log)).toContain('[FlightManager] Ground session #100 adopted (manual)');
    expect(endState(fm, log).flightState).toBe('GROUND');
    expect(fm.getGroundSessionStatus()).toMatchObject({ groundSessionId: 100, source: 'manual', parkingPosition: 'STAND 7' });
  });

  it('G-09 a ground match whose leg cannot be read logs the match without a route and records no stand', () => {
    arrangeLeg();
    behave.db.getPlannedLegById = () => null;
    const fm = newFm();
    park(fm); park(fm, 3);
    const log = takeLog();
    expect(logLines(log)).toContain('[FlightManager] Ground session matched planned leg #11 (0.0 nm, MATCHED)');
    expect(callsTo(log, 'groundSessions.insertGroundSession')[0].args[0]).toMatchObject({
      planned_leg_id: 11, planned_leg_link_source: 'auto', parking_position: null, parking_position_source: null,
    });
    expect(fm.getGroundSessionStatus()).toMatchObject({ plannedLegId: 11, tripId: null, tripName: null, departureIdent: null });
  });

  it('G-10 a resumed track skips unparseable, equal and over-long gaps for time but counts all of the distance', () => {
    const pt = (nm: number, ts: string) => {
      const p = northOfNm(KSBA, nm);
      return { lat: p.lat, lon: p.lon, altitude_ft: 3000, airspeed_kts: 120, ts };
    };
    behave.db.getOpenFlight = () => openRow();
    behave.db.getFlightTrackPoints = () => [
      pt(0, iso(-600_000)),
      pt(1, 'not a date'),
      pt(2, iso(-590_000)),
      pt(3, iso(-590_000)),
      pt(4, iso(-470_000)),
      pt(5, iso(-465_000)),
    ];
    const fm = newFm();
    feed(fm, 1, northOfNm(KSBA, 6));
    const log = takeLog();
    expect(logLines(log)).toContain(
      '[FlightManager] Flight #77 resumed after restart — 6 points, 5.0 nm, 5s counted before the interruption',
    );
    expect(endState(fm, log)).toMatchObject({ flightState: 'FLYING', currentFlightId: 77 });
  });

  it('G-11 a resumed row with an unparseable start time falls back to the resume instant', () => {
    behave.db.getOpenFlight = () => openRow({ start_time: 'not a date' });
    const fm = newFm();
    const threw = thrown(() => feed(fm, 1, northOfNm(KSBA, 5)));
    cruise(fm, 2, northOfNm(KSBA, 6));
    fm.setPaused(true, 8); cruise(fm, 4, northOfNm(KSBA, 6)); fm.setPaused(false);
    cruise(fm, 2, northOfNm(KSBA, 6));
    feed(fm, 1, { simRunning: 0 });
    const log = takeLog();
    expect(threw).toBeNull();
    expect(endState(fm, log)).toMatchObject({ flightState: 'IDLE', currentFlightId: null });
    // 41 s elapsed since the resume frame and 16 s of it counted, so the 25 s
    // interruption is the only excluded time. A start time left as NaN would
    // drop the excluded-seconds suffix altogether.
    expect(logLines(log)).toContain(
      '[FlightManager] Flight #77 ended — 5 points, 1.0 nm, 16s (25s interrupted, excluded)',
    );
  });

  it('G-12 an auto-link whose leg cannot be read still writes the link but keeps no leg status', () => {
    behave.db.getActiveTripId = () => 1;
    behave.db.getPlannedLegCandidatesForActiveTrip = () => [makeCandidate()];
    const fm = newFm();
    takeoff(fm);
    const log = takeLog();
    expect(callsTo(log, 'db.linkFlightToPlannedLeg').map(c => c.args)).toEqual([[1, 11, 'auto']]);
    expect(logLines(log)).toContain('[FlightManager] Flight #1 linked to planned leg #11 (0.0 nm, MATCHED)');
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
    expect(warns(log)).toEqual([]);
  });

  it('G-13 a landing whose linked leg has vanished records no arrival and logs no landed line', () => {
    arrangeLeg();
    behave.db.getFlightPlannedLegId = () => 11;
    const inTheAir = behave.db.getPlannedLegById;
    let legGone = false;
    behave.db.getPlannedLegById = (id: number) => (legGone ? null : inTheAir(id));
    const fm = newFm();
    takeoff(fm); cruise(fm);
    legGone = true;
    land(fm); feed(fm, 3, LANDED);
    const log = takeLog();
    expect(endState(fm, log)).toMatchObject({ flightState: 'IDLE', currentFlightId: null });
    expect(callsTo(log, 'db.getFlightPlannedLegId').length).toBeGreaterThan(0);
    expect(callsTo(log, 'db.recordPlannedLegArrival')).toEqual([]);
    expect(logLines(log).filter(l => l.includes('landed'))).toEqual([]);
    expect(warns(log)).toEqual([]);
  });
});
