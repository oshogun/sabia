// tests/flight/groundTracker.test.ts — tests src/flight/groundTracker.ts.
//
// The database barrel, the ground-sessions module and the airport lookup are
// replaced, so every row the tracker reads and every write it makes is ours
// to inspect. './groundState' is the real module and the clock is faked.
// Apart from the last block nothing here goes through FlightManager: the
// tracker returns facts, and each test reads what it did back through the
// facts and through the next call's behaviour, since its four fields are
// private.
//
// Every log and warn text is asserted whole. Operators grep these lines.
//
// The last block drives a real FlightManager (with './acarsEvents' replaced
// too) to pin what only the coordinator's sequencing can get wrong: a resume
// reaches no ground tracking at all, and from IDLE the airborne check runs
// before the parked streak is counted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CreateGroundSession, GroundSession, SimFrame } from '../../src/types';
import {
  dbMock, airportsMock, resetMocks, makeFrame, makePlannedLegWithChildren,
  northOfNm, KSBA, useFakeClock, useRealClock, T0,
} from '../helpers';

vi.mock('../../src/db', async () => (await import('../helpers')).dbMock);
vi.mock('../../src/airports', async () => (await import('../helpers')).airportsMock);
vi.mock('../../src/acarsEvents', async () => (await import('../helpers')).acarsEventsMock);
vi.mock('../../src/db/groundSessions', () => ({
  insertGroundSession: vi.fn(),
  getOpenGroundSession: vi.fn(),
  closeOpenGroundSession: vi.fn(),
  fillOpenGroundSessionGaps: vi.fn(),
}));

import * as groundSessionsModule from '../../src/db/groundSessions';
import { GROUND_DEBOUNCE_FRAMES, GROUND_REANCHOR_NM } from '../../src/groundState';
import { GroundTracker } from '../../src/flight/groundTracker';
import type { GroundLegMatcher } from '../../src/flight/groundTracker';
import { FlightManager } from '../../src/flightManager';

const insertGroundSession = vi.mocked(groundSessionsModule.insertGroundSession);
const getOpenGroundSession = vi.mocked(groundSessionsModule.getOpenGroundSession);
const closeOpenGroundSession = vi.mocked(groundSessionsModule.closeOpenGroundSession);
const fillOpenGroundSessionGaps = vi.mocked(groundSessionsModule.fillOpenGroundSessionGaps);

const logged = (): unknown[][] => vi.mocked(console.log).mock.calls;
const warned = (): unknown[][] => vi.mocked(console.warn).mock.calls;

const ENTRY_FAILED = '[FlightManager] Ground session entry failed, staying IDLE:';
const boom = new Error('database is locked');

/** A frame that satisfies isParkedFrame(): on the ground, stationary, engines off. */
const PARKED: Partial<SimFrame> = {
  onGround: true, groundSpeedKnots: 0, enginesRunning: 0, engineCount: 2, parkingBrake: false,
};
const parked = (over: Partial<SimFrame> = {}): SimFrame => makeFrame({ ...PARKED, lat: KSBA.lat, lon: KSBA.lon, ...over });

const noMatch: GroundLegMatcher = () => ({ plannedLegId: null, parkingPosition: null });

let nextSessionId = 100;

function makeSession(over: Partial<GroundSession> = {}): GroundSession {
  return {
    id: nextSessionId++,
    source: 'auto',
    airport_icao: null,
    airport_name: null,
    lat: null,
    lon: null,
    parking_position: null,
    parking_position_source: null,
    planned_leg_id: null,
    planned_leg_link_source: null,
    aircraft: null,
    started_at: T0,
    ended_at: null,
    ended_reason: null,
    flight_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** The row the real insert would return for `input`. */
function rowFromInput(input: CreateGroundSession): GroundSession {
  return makeSession({
    source: input.source,
    airport_icao: input.airport_icao ?? null,
    airport_name: input.airport_name ?? null,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    parking_position: input.parking_position ?? null,
    parking_position_source: input.parking_position_source ?? null,
    planned_leg_id: input.planned_leg_id ?? null,
    planned_leg_link_source: input.planned_leg_link_source ?? null,
    aircraft: input.aircraft ?? null,
    started_at: input.started_at ?? T0,
  });
}

/** The real fill's rule: a patch value only lands in a column that is still null. */
function fillGaps(patch: Partial<CreateGroundSession>): GroundSession | null {
  const current = getOpenGroundSession() as unknown as Record<string, unknown> | null;
  if (!current) return null;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (current[key] !== null) continue;
    merged[key] = value;
  }
  return merged as unknown as GroundSession;
}

beforeEach(() => {
  resetMocks();
  useFakeClock();
  nextSessionId = 100;
  getOpenGroundSession.mockReset().mockReturnValue(null);
  insertGroundSession.mockReset().mockImplementation(rowFromInput);
  closeOpenGroundSession.mockReset().mockReturnValue(null);
  fillOpenGroundSessionGaps.mockReset().mockImplementation(fillGaps);
});

afterEach(() => {
  useRealClock();
});

/** A tracker that has entered by inserting a fresh auto session at KSBA. */
function enteredTracker(over: Partial<GroundSession> = {}): GroundTracker {
  const tracker = new GroundTracker();
  insertGroundSession.mockImplementationOnce(input => ({ ...rowFromInput(input), ...over }));
  expect(tracker.enter(parked(), noMatch)).toBe('entered');
  insertGroundSession.mockClear();
  vi.mocked(console.log).mockClear();
  return tracker;
}

/** Runs observeIdle over `n` parked frames and returns the last fact. */
function idleFrames(tracker: GroundTracker, n: number): string {
  let fact = 'not-yet';
  for (let i = 0; i < n; i++) fact = tracker.observeIdle(parked());
  return fact;
}

describe('GroundTracker.observeIdle', () => {
  it('meets the debounce on the GROUND_DEBOUNCE_FRAMES-th consecutive parked frame, not before', () => {
    const tracker = new GroundTracker();
    for (let i = 1; i < GROUND_DEBOUNCE_FRAMES; i++) {
      expect(tracker.observeIdle(parked())).toBe('not-yet');
    }
    expect(tracker.observeIdle(parked())).toBe('debounce-met');
  });

  it('keeps reporting debounce-met while the aircraft stays parked', () => {
    const tracker = new GroundTracker();
    expect(idleFrames(tracker, GROUND_DEBOUNCE_FRAMES)).toBe('debounce-met');
    expect(tracker.observeIdle(parked())).toBe('debounce-met');
  });

  it('restarts the whole window after one frame that is not parked', () => {
    const tracker = new GroundTracker();
    idleFrames(tracker, GROUND_DEBOUNCE_FRAMES - 1);
    expect(tracker.observeIdle(parked({ groundSpeedKnots: 12 }))).toBe('not-yet');
    expect(idleFrames(tracker, GROUND_DEBOUNCE_FRAMES - 1)).toBe('not-yet');
    expect(tracker.observeIdle(parked())).toBe('debounce-met');
  });

  it('starts the window again after a successful entry', () => {
    const tracker = new GroundTracker();
    idleFrames(tracker, GROUND_DEBOUNCE_FRAMES);
    expect(tracker.enter(parked(), noMatch)).toBe('entered');
    expect(tracker.observeIdle(parked())).toBe('not-yet');
  });

  it('starts the window again after a failed entry', () => {
    const tracker = new GroundTracker();
    idleFrames(tracker, GROUND_DEBOUNCE_FRAMES);
    getOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    expect(tracker.enter(parked(), noMatch)).toBe('failed');
    expect(tracker.observeIdle(parked())).toBe('not-yet');
  });
});

describe('GroundTracker.enter — insert', () => {
  it('inserts an auto session at the frame position with the resolved airport and the matched leg', () => {
    const tracker = new GroundTracker();
    airportsMock.findNearestAirport.mockReturnValue({ icao: 'KSBA', name: 'Santa Barbara Muni' });
    const matchLeg = vi.fn<GroundLegMatcher>(() => ({ plannedLegId: 11, parkingPosition: 'Gate 4' }));
    const frame = parked({ aircraft: 'Cessna 172' });

    expect(tracker.enter(frame, matchLeg)).toBe('entered');

    expect(insertGroundSession).toHaveBeenCalledTimes(1);
    expect(insertGroundSession).toHaveBeenCalledWith({
      source: 'auto',
      airport_icao: 'KSBA',
      airport_name: 'Santa Barbara Muni',
      lat: KSBA.lat,
      lon: KSBA.lon,
      parking_position: 'Gate 4',
      parking_position_source: 'auto',
      planned_leg_id: 11,
      planned_leg_link_source: 'auto',
      aircraft: 'Cessna 172',
      started_at: T0,
    });
    expect(fillOpenGroundSessionGaps).not.toHaveBeenCalled();
    expect(logged()).toEqual([['[FlightManager] Ground session #100 — KSBA (Santa Barbara Muni)']]);
  });

  it('hands the matcher the frame and the same startedAt the row is written with', () => {
    const tracker = new GroundTracker();
    const matchLeg = vi.fn<GroundLegMatcher>(noMatch);
    const frame = parked();
    tracker.enter(frame, matchLeg);
    expect(matchLeg).toHaveBeenCalledTimes(1);
    expect(matchLeg).toHaveBeenCalledWith(frame, T0);
    expect(insertGroundSession.mock.calls[0][0].started_at).toBe(T0);
  });

  it('leaves the leg and stand columns and their sources null when the match found nothing', () => {
    const tracker = new GroundTracker();
    tracker.enter(parked(), noMatch);
    expect(insertGroundSession.mock.calls[0][0]).toMatchObject({
      parking_position: null, parking_position_source: null,
      planned_leg_id: null, planned_leg_link_source: null,
    });
  });

  it('marks a stand found without a leg, and a leg found without a stand, each on its own', () => {
    new GroundTracker().enter(parked(), () => ({ plannedLegId: null, parkingPosition: 'B2' }));
    expect(insertGroundSession.mock.calls[0][0]).toMatchObject({
      parking_position: 'B2', parking_position_source: 'auto',
      planned_leg_id: null, planned_leg_link_source: null,
    });
    new GroundTracker().enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));
    expect(insertGroundSession.mock.calls[1][0]).toMatchObject({
      parking_position: null, parking_position_source: null,
      planned_leg_id: 11, planned_leg_link_source: 'auto',
    });
  });

  it('logs the absence of an airport when none is within range, and stores null columns', () => {
    const tracker = new GroundTracker();
    expect(tracker.enter(parked(), noMatch)).toBe('entered');
    expect(insertGroundSession.mock.calls[0][0]).toMatchObject({ airport_icao: null, airport_name: null });
    expect(logged()).toEqual([['[FlightManager] Ground session #100 — no airport within 10 nm']]);
  });

  it('caches the live status of the new row', () => {
    const tracker = new GroundTracker();
    airportsMock.findNearestAirport.mockReturnValue({ icao: 'KSBA', name: 'Santa Barbara Muni' });
    tracker.enter(parked(), () => ({ plannedLegId: null, parkingPosition: 'Gate 4' }));
    expect(tracker.status()).toEqual({
      groundSessionId: 100,
      source: 'auto',
      airportIcao: 'KSBA',
      airportName: 'Santa Barbara Muni',
      parkingPosition: 'Gate 4',
      parkingPositionSource: 'auto',
      plannedLegId: null,
      plannedLegLinkSource: null,
      tripId: null,
      tripName: null,
      departureIdent: null,
      destinationIdent: null,
      startedAt: T0,
    });
  });
});

describe('GroundTracker.enter — adopt', () => {
  it('fills only the blank columns of the open row and never inserts', () => {
    const tracker = new GroundTracker();
    const open = makeSession({ id: 7, source: 'manual', airport_icao: null, parking_position: 'Hangar 9', parking_position_source: 'manual' });
    getOpenGroundSession.mockReturnValue(open);
    airportsMock.findNearestAirport.mockReturnValue({ icao: 'KSBA', name: 'Santa Barbara Muni' });

    expect(tracker.enter(parked({ aircraft: 'Cessna 172' }), () => ({ plannedLegId: 11, parkingPosition: 'Gate 4' }))).toBe('entered');

    expect(insertGroundSession).not.toHaveBeenCalled();
    expect(fillOpenGroundSessionGaps).toHaveBeenCalledTimes(1);
    expect(fillOpenGroundSessionGaps).toHaveBeenCalledWith({
      airport_icao: 'KSBA',
      airport_name: 'Santa Barbara Muni',
      lat: KSBA.lat,
      lon: KSBA.lon,
      parking_position: 'Gate 4',
      parking_position_source: 'auto',
      planned_leg_id: 11,
      planned_leg_link_source: 'auto',
      aircraft: 'Cessna 172',
    });
    expect(logged()).toEqual([['[FlightManager] Ground session #7 adopted (manual)']]);
    // The operator's stand survived; the source is never rewritten.
    expect(tracker.status()).toMatchObject({
      groundSessionId: 7, source: 'manual', airportIcao: 'KSBA',
      parkingPosition: 'Hangar 9', parkingPositionSource: 'manual',
    });
  });

  it('leaves the stand and leg sources null on an empty match, and marks each found one on its own', () => {
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    new GroundTracker().enter(parked(), noMatch);
    expect(fillOpenGroundSessionGaps.mock.calls[0][0]).toMatchObject({
      parking_position: null, parking_position_source: null,
      planned_leg_id: null, planned_leg_link_source: null,
    });
    new GroundTracker().enter(parked(), () => ({ plannedLegId: null, parkingPosition: 'B2' }));
    expect(fillOpenGroundSessionGaps.mock.calls[1][0]).toMatchObject({
      parking_position: 'B2', parking_position_source: 'auto',
      planned_leg_id: null, planned_leg_link_source: null,
    });
    new GroundTracker().enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));
    expect(fillOpenGroundSessionGaps.mock.calls[2][0]).toMatchObject({
      parking_position: null, parking_position_source: null,
      planned_leg_id: 11, planned_leg_link_source: 'auto',
    });
  });

  it('falls back to the open row itself when the fill returns nothing', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ id: 8, source: 'manual', airport_icao: 'KMRY', airport_name: 'Monterey Rgnl' }));
    fillOpenGroundSessionGaps.mockReturnValue(null);
    expect(tracker.enter(parked(), noMatch)).toBe('entered');
    expect(logged()).toEqual([['[FlightManager] Ground session #8 adopted (manual)']]);
    expect(tracker.status()).toMatchObject({ groundSessionId: 8, airportIcao: 'KMRY' });
  });

  describe('the airport-disagreement rule', () => {
    const DETECTED = { icao: 'KSBA', name: 'Santa Barbara Muni' };

    function adopt(recorded: string | null, detected: typeof DETECTED | null): void {
      getOpenGroundSession.mockReturnValue(makeSession({ id: 7, source: 'manual', airport_icao: recorded }));
      airportsMock.findNearestAirport.mockReturnValue(detected);
      expect(new GroundTracker().enter(parked(), noMatch)).toBe('entered');
    }

    it('fills the detected code and name when the row has no airport yet', () => {
      adopt(null, DETECTED);
      expect(fillOpenGroundSessionGaps.mock.calls[0][0]).toMatchObject({ airport_icao: 'KSBA', airport_name: 'Santa Barbara Muni' });
      expect(logged()).toEqual([['[FlightManager] Ground session #7 adopted (manual)']]);
    });

    it('sends null code and name when nothing was detected', () => {
      adopt('KMRY', null);
      expect(fillOpenGroundSessionGaps.mock.calls[0][0]).toMatchObject({ airport_icao: null, airport_name: null });
      expect(logged()).toEqual([['[FlightManager] Ground session #7 adopted (manual)']]);
    });

    it('fills the detected code and name when the recorded code agrees', () => {
      adopt('KSBA', DETECTED);
      expect(fillOpenGroundSessionGaps.mock.calls[0][0]).toMatchObject({ airport_icao: 'KSBA', airport_name: 'Santa Barbara Muni' });
      expect(logged()).toEqual([['[FlightManager] Ground session #7 adopted (manual)']]);
    });

    it('keeps the operator code and attaches no name at all when the detected airport differs', () => {
      adopt('KMRY', DETECTED);
      expect(fillOpenGroundSessionGaps.mock.calls[0][0]).toMatchObject({ airport_icao: null, airport_name: null });
      expect(logged()).toEqual([
        ['[FlightManager] Ground session #7 — detected airport KSBA disagrees with recorded KMRY; keeping KMRY'],
        ['[FlightManager] Ground session #7 adopted (manual)'],
      ]);
    });

    it('never logs a disagreement on the insert path', () => {
      airportsMock.findNearestAirport.mockReturnValue(DETECTED);
      new GroundTracker().enter(parked(), noMatch);
      expect(logged().some(([line]) => String(line).includes('disagrees'))).toBe(false);
    });
  });
});

describe('GroundTracker.enter — the cached leg lookup', () => {
  const LEG = makePlannedLegWithChildren({ id: 11, trip_id: 3, departure_ident: 'KSBA', destination_ident: 'KMRY' });

  it('reads the leg, then its trip name, into the cache when the session carries a leg', () => {
    const tracker = new GroundTracker();
    dbMock.getPlannedLegById.mockReturnValue(LEG);
    dbMock.getTripName.mockReturnValue('Coast hop');
    tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));

    expect(dbMock.getPlannedLegById).toHaveBeenCalledTimes(1);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(11);
    expect(dbMock.getTripName).toHaveBeenCalledTimes(1);
    expect(dbMock.getTripName).toHaveBeenCalledWith(3);
    expect(tracker.status()).toMatchObject({
      plannedLegId: 11, plannedLegLinkSource: 'auto',
      tripId: 3, tripName: 'Coast hop', departureIdent: 'KSBA', destinationIdent: 'KMRY',
    });
  });

  it('reads no leg at all for a session with none', () => {
    new GroundTracker().enter(parked(), noMatch);
    expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
    expect(dbMock.getTripName).not.toHaveBeenCalled();
  });

  it('reads no trip name for a loose leg, and reports a null one', () => {
    const tracker = new GroundTracker();
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 11, trip_id: null }));
    tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));
    expect(dbMock.getTripName).not.toHaveBeenCalled();
    expect(tracker.status()).toMatchObject({ tripId: null, tripName: null, departureIdent: 'KSBA', destinationIdent: 'KMRY' });
  });

  it('reports a null trip name when the trip row is gone', () => {
    const tracker = new GroundTracker();
    dbMock.getPlannedLegById.mockReturnValue(LEG);
    dbMock.getTripName.mockReturnValue(undefined);
    tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));
    expect(tracker.status()).toMatchObject({ tripId: 3, tripName: null });
  });

  it('keeps the leg id but nulls everything derived from it when the leg row is gone', () => {
    const tracker = new GroundTracker();
    dbMock.getPlannedLegById.mockReturnValue(null);
    tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }));
    expect(dbMock.getTripName).not.toHaveBeenCalled();
    expect(tracker.status()).toMatchObject({
      plannedLegId: 11, tripId: null, tripName: null, departureIdent: null, destinationIdent: null,
    });
  });
});

describe('GroundTracker.enter — call order', () => {
  it('looks up the open session, then the airport, then runs the match, then writes, then reads the leg', () => {
    const tracker = new GroundTracker();
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 11, trip_id: 3 }));
    const matchLeg = vi.fn<GroundLegMatcher>(() => ({ plannedLegId: 11, parkingPosition: null }));

    tracker.enter(parked(), matchLeg);

    const order = (fn: { mock: { invocationCallOrder: number[] } }): number => fn.mock.invocationCallOrder[0];
    expect(order(getOpenGroundSession)).toBeLessThan(order(airportsMock.findNearestAirport));
    expect(order(airportsMock.findNearestAirport)).toBeLessThan(order(matchLeg));
    expect(order(matchLeg)).toBeLessThan(order(insertGroundSession));
    expect(order(insertGroundSession)).toBeLessThan(order(dbMock.getPlannedLegById));
    expect(order(dbMock.getPlannedLegById)).toBeLessThan(order(dbMock.getTripName));
  });

  it('runs the match before the adopt write too', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    const matchLeg = vi.fn<GroundLegMatcher>(noMatch);
    tracker.enter(parked(), matchLeg);
    expect(matchLeg.mock.invocationCallOrder[0]).toBeLessThan(fillOpenGroundSessionGaps.mock.invocationCallOrder[0]);
  });
});

describe('GroundTracker.enter — failure', () => {
  const fail = (): never => { throw boom; };

  it.each([
    ['the open-session lookup', () => { getOpenGroundSession.mockImplementationOnce(fail); }],
    ['the airport lookup', () => { airportsMock.findNearestAirport.mockImplementationOnce(fail); }],
    ['the insert', () => { insertGroundSession.mockImplementationOnce(fail); }],
    ['the adopt fill', () => {
      getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
      fillOpenGroundSessionGaps.mockImplementationOnce(fail);
    }],
    ['the cache build leg lookup', () => {
      dbMock.getPlannedLegById.mockImplementationOnce(fail);
    }],
    ['the cache build trip-name lookup', () => {
      dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 11, trip_id: 3 }));
      dbMock.getTripName.mockImplementationOnce(fail);
    }],
  ])('returns failed, warns once and stays without a session when %s throws', (_name, arrange) => {
    const tracker = new GroundTracker();
    arrange();

    expect(tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }))).toBe('failed');

    expect(warned()).toEqual([[ENTRY_FAILED, boom]]);
    expect(tracker.status()).toBeNull();
  });

  it('runs the leg match inside the same boundary: a matcher throw returns failed with the same warn and writes nothing', () => {
    const tracker = new GroundTracker();
    const matchLeg = vi.fn<GroundLegMatcher>(() => { throw boom; });

    expect(tracker.enter(parked(), matchLeg)).toBe('failed');

    expect(warned()).toEqual([[ENTRY_FAILED, boom]]);
    expect(insertGroundSession).not.toHaveBeenCalled();
    expect(fillOpenGroundSessionGaps).not.toHaveBeenCalled();
    expect(tracker.status()).toBeNull();
  });

  it('does not run the match when an earlier lookup already failed', () => {
    const matchLeg = vi.fn<GroundLegMatcher>(noMatch);
    getOpenGroundSession.mockImplementationOnce(fail);
    new GroundTracker().enter(parked(), matchLeg);
    expect(matchLeg).not.toHaveBeenCalled();
  });

  it('leaves the previous cache in place when the failure comes before the cache is rebuilt', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    const before = tracker.status();
    expect(before).not.toBeNull();

    insertGroundSession.mockImplementationOnce(fail);
    expect(tracker.enter(parked(), noMatch)).toBe('failed');

    expect(tracker.status()).toBe(before);
  });

  it('leaves the previous cache in place when the cache build itself throws', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    const before = tracker.status();

    dbMock.getPlannedLegById.mockImplementationOnce(fail);
    expect(tracker.enter(parked(), () => ({ plannedLegId: 11, parkingPosition: null }))).toBe('failed');

    expect(tracker.status()).toBe(before);
  });

  it('has already moved the anchor when the cache build throws, as the entry sets it first', () => {
    const tracker = enteredTracker();
    const elsewhere = northOfNm(KSBA, GROUND_REANCHOR_NM + 5);

    dbMock.getPlannedLegById.mockImplementationOnce(fail);
    tracker.enter(parked(elsewhere), () => ({ plannedLegId: 11, parkingPosition: null }));

    expect(tracker.observeGround(parked(elsewhere))).toBe('at-anchor');
    expect(tracker.observeGround(parked())).toBe('left-anchor');
  });

  it('forgets an off-blocks memo on a successful entry', () => {
    const tracker = enteredTracker();
    tracker.observeGround(parked({ groundSpeedKnots: 8 }));
    expect(tracker.enter(parked(), noMatch)).toBe('entered');
    expect(tracker.handOffToFlight(1).outAt).toBeNull();
  });
});

describe('GroundTracker.observeGround', () => {
  it('reports at-anchor on the entry position', () => {
    expect(enteredTracker().observeGround(parked())).toBe('at-anchor');
  });

  it('never reports left-anchor before any entry has set one', () => {
    const tracker = new GroundTracker();
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 50)))).toBe('at-anchor');
  });

  it('reports at-anchor just inside GROUND_REANCHOR_NM and left-anchor just outside it', () => {
    const tracker = enteredTracker();
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM - 0.5)))).toBe('at-anchor');
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 0.5)))).toBe('left-anchor');
  });

  it('measures from the entry position, not from the previous frame', () => {
    const tracker = enteredTracker();
    for (let nm = 2; nm <= 8; nm += 2) {
      expect(tracker.observeGround(parked(northOfNm(KSBA, nm)))).toBe('at-anchor');
    }
    expect(tracker.observeGround(parked(northOfNm(KSBA, 12)))).toBe('left-anchor');
  });

  it('measures from the adopted row\'s frame position too', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    tracker.enter(parked(), noMatch);
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 0.5)))).toBe('left-anchor');
  });

  describe('the off-blocks memo', () => {
    it('is not set at 2.9 kt', () => {
      const tracker = enteredTracker();
      tracker.observeGround(parked({ groundSpeedKnots: 2.9 }));
      expect(tracker.handOffToFlight(1).outAt).toBeNull();
    });

    it('is set at exactly 3 kt, to the instant of that frame', () => {
      const tracker = enteredTracker();
      vi.advanceTimersByTime(4000);
      expect(tracker.observeGround(parked({ groundSpeedKnots: 3 }))).toBe('at-anchor');
      expect(tracker.handOffToFlight(1).outAt).toBe('2026-09-09T12:00:04.000Z');
    });

    it('keeps the first instant when later frames are also at taxi speed', () => {
      const tracker = enteredTracker();
      vi.advanceTimersByTime(4000);
      tracker.observeGround(parked({ groundSpeedKnots: 5 }));
      vi.advanceTimersByTime(9000);
      tracker.observeGround(parked({ groundSpeedKnots: 15 }));
      expect(tracker.handOffToFlight(1).outAt).toBe('2026-09-09T12:00:04.000Z');
    });

    it('is not set by a fast frame that is not on the ground', () => {
      const tracker = enteredTracker();
      tracker.observeGround(parked({ groundSpeedKnots: 40, onGround: false }));
      expect(tracker.handOffToFlight(1).outAt).toBeNull();
    });

    it('is not set by the frame that reports the jump away from the anchor', () => {
      const tracker = enteredTracker();
      const far = northOfNm(KSBA, GROUND_REANCHOR_NM + 5);
      expect(tracker.observeGround(parked({ ...far, groundSpeedKnots: 20 }))).toBe('left-anchor');
      expect(tracker.handOffToFlight(1).outAt).toBeNull();
    });
  });
});

describe('GroundTracker.handOffToFlight', () => {
  it('returns the memo, airport and stand, and closes the session as flight-started with the flight id', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA', parking_position: 'Gate 4' });
    vi.advanceTimersByTime(3000);
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));

    expect(tracker.handOffToFlight(42)).toEqual({
      outAt: '2026-09-09T12:00:03.000Z', airportIcao: 'KSBA', stand: 'Gate 4',
    });
    expect(closeOpenGroundSession).toHaveBeenCalledTimes(1);
    expect(closeOpenGroundSession).toHaveBeenCalledWith('flight-started', 42);
  });

  it('returns nulls for a tracker that never entered, and still closes', () => {
    const tracker = new GroundTracker();
    expect(tracker.handOffToFlight(5)).toEqual({ outAt: null, airportIcao: null, stand: null });
    expect(closeOpenGroundSession).toHaveBeenCalledWith('flight-started', 5);
  });

  it('closes without reading the open row, whatever its source', () => {
    const tracker = enteredTracker();
    getOpenGroundSession.mockClear();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    tracker.handOffToFlight(3);
    expect(getOpenGroundSession).not.toHaveBeenCalled();
    expect(closeOpenGroundSession).toHaveBeenCalledWith('flight-started', 3);
  });

  it('still returns the captured values, and warns, when the close throws', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA', parking_position: 'Gate 4' });
    vi.advanceTimersByTime(2000);
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    closeOpenGroundSession.mockImplementationOnce(() => { throw boom; });

    expect(tracker.handOffToFlight(9)).toEqual({
      outAt: '2026-09-09T12:00:02.000Z', airportIcao: 'KSBA', stand: 'Gate 4',
    });
    expect(warned()).toEqual([['[FlightManager] Flight #9 ground session close failed:', boom]]);
  });

  it('forgets everything even when the close throws', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA', parking_position: 'Gate 4' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    closeOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    tracker.handOffToFlight(9);

    expect(tracker.status()).toBeNull();
    expect(tracker.handOffToFlight(10)).toEqual({ outAt: null, airportIcao: null, stand: null });
  });

  it('runs the close while the cache and the memo are still there, and clears them only afterwards', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA', parking_position: 'Gate 4' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    let statusDuringClose: unknown = 'not called';
    closeOpenGroundSession.mockImplementationOnce(() => { statusDuringClose = tracker.status(); return null; });

    tracker.handOffToFlight(9);

    expect(statusDuringClose).not.toBeNull();
    expect(statusDuringClose).toMatchObject({ airportIcao: 'KSBA', parkingPosition: 'Gate 4' });
    expect(tracker.status()).toBeNull();
  });

  it('clears the anchor: a jump after the hand-off reports nothing', () => {
    const tracker = enteredTracker();
    tracker.handOffToFlight(1);
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 50)))).toBe('at-anchor');
  });

  it('clears the parked streak: a full window is needed again', () => {
    const tracker = new GroundTracker();
    idleFrames(tracker, GROUND_DEBOUNCE_FRAMES - 1);
    tracker.handOffToFlight(1);
    expect(tracker.observeIdle(parked())).toBe('not-yet');
  });

  it('clears the memo: a second hand-off reports no off-blocks instant', () => {
    const tracker = enteredTracker();
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    expect(tracker.handOffToFlight(1).outAt).not.toBeNull();
    expect(tracker.handOffToFlight(2).outAt).toBeNull();
  });

  it('reports the airport and stand of a session adopted by refresh while the tracker was idle', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({
      id: 12, source: 'manual', airport_icao: 'KMRY', parking_position: 'Ramp 2', parking_position_source: 'manual',
    }));
    expect(tracker.refresh()).toBe('updated');

    expect(tracker.handOffToFlight(4)).toEqual({ outAt: null, airportIcao: 'KMRY', stand: 'Ramp 2' });
    expect(tracker.status()).toBeNull();
  });
});

describe('GroundTracker.closeAny and closeAutoOnly', () => {
  it('closeAny closes whatever is open with the reason, without reading the row', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    tracker.closeAny('slew');
    expect(closeOpenGroundSession).toHaveBeenCalledTimes(1);
    expect(closeOpenGroundSession).toHaveBeenCalledWith('slew');
    expect(getOpenGroundSession).not.toHaveBeenCalled();
  });

  it('closeAny warns with the reason and swallows a failing close', () => {
    const tracker = new GroundTracker();
    closeOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    expect(() => tracker.closeAny('superseded')).not.toThrow();
    expect(warned()).toEqual([['[FlightManager] Ground session close (superseded) failed:', boom]]);
  });

  it('closeAutoOnly closes an open auto session', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'auto' }));
    tracker.closeAutoOnly('crash');
    expect(closeOpenGroundSession).toHaveBeenCalledTimes(1);
    expect(closeOpenGroundSession).toHaveBeenCalledWith('crash');
  });

  it('closeAutoOnly leaves a manual session open', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    tracker.closeAutoOnly('sim-exit');
    expect(getOpenGroundSession).toHaveBeenCalledTimes(1);
    expect(closeOpenGroundSession).not.toHaveBeenCalled();
  });

  it('closeAutoOnly closes nothing when no session is open', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(null);
    tracker.closeAutoOnly('crash');
    expect(closeOpenGroundSession).not.toHaveBeenCalled();
  });

  it('closeAutoOnly reads the row, not the cache: an auto cache over a row turned manual is left open', () => {
    const tracker = enteredTracker();
    expect(tracker.status()).toMatchObject({ source: 'auto' });
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual' }));
    tracker.closeAutoOnly('crash');
    expect(closeOpenGroundSession).not.toHaveBeenCalled();
  });

  it('closeAutoOnly closes an auto row even when the tracker never cached one', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'auto' }));
    tracker.closeAutoOnly('crash');
    expect(closeOpenGroundSession).toHaveBeenCalledWith('crash');
  });

  it('closeAutoOnly warns and swallows when the lookup throws, and does not close', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    expect(() => tracker.closeAutoOnly('crash')).not.toThrow();
    expect(warned()).toEqual([['[FlightManager] Ground session close (crash) failed:', boom]]);
    expect(closeOpenGroundSession).not.toHaveBeenCalled();
  });

  it('closeAutoOnly warns and swallows when the close throws', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'auto' }));
    closeOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    expect(() => tracker.closeAutoOnly('sim-exit')).not.toThrow();
    expect(warned()).toEqual([['[FlightManager] Ground session close (sim-exit) failed:', boom]]);
  });

  it('neither close touches the tracked fields', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    const before = tracker.status();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'auto' }));

    tracker.closeAny('slew');
    tracker.closeAutoOnly('crash');

    expect(tracker.status()).toBe(before);
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 5)))).toBe('left-anchor');
    expect(tracker.handOffToFlight(1).outAt).not.toBeNull();
  });
});

describe('GroundTracker.refresh', () => {
  it('adopts an open row into the cache on a tracker that never entered', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ id: 21, source: 'manual', airport_icao: 'KSBA', airport_name: 'Santa Barbara Muni' }));

    expect(tracker.refresh()).toBe('updated');
    expect(tracker.status()).toMatchObject({ groundSessionId: 21, source: 'manual', airportIcao: 'KSBA' });
  });

  it('replaces a cache built at entry with the row as it is now', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    getOpenGroundSession.mockReturnValue(makeSession({ id: 22, source: 'manual', airport_icao: 'KMRY', parking_position: 'Ramp 2' }));

    expect(tracker.refresh()).toBe('updated');
    expect(tracker.status()).toMatchObject({ groundSessionId: 22, airportIcao: 'KMRY', parkingPosition: 'Ramp 2' });
  });

  it('builds the leg details the row now carries', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual', planned_leg_id: 11, planned_leg_link_source: 'manual' }));
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 11, trip_id: 3 }));
    dbMock.getTripName.mockReturnValue('Coast hop');

    tracker.refresh();

    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(11);
    expect(tracker.status()).toMatchObject({ plannedLegId: 11, tripId: 3, tripName: 'Coast hop' });
  });

  it('returns closed and changes nothing when no row is open', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    const before = tracker.status();
    getOpenGroundSession.mockReturnValue(null);

    expect(tracker.refresh()).toBe('closed');

    expect(tracker.status()).toBe(before);
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 5)))).toBe('left-anchor');
    expect(tracker.handOffToFlight(1)).toMatchObject({ airportIcao: 'KSBA' });
    expect(tracker.handOffToFlight(2)).toEqual({ outAt: null, airportIcao: null, stand: null });
  });

  it('returns closed on a tracker that never entered, and stays empty', () => {
    const tracker = new GroundTracker();
    expect(tracker.refresh()).toBe('closed');
    expect(tracker.status()).toBeNull();
  });

  it('reports closed or updated from the row alone, whatever the tracker held before', () => {
    const tracker = enteredTracker();
    tracker.handOffToFlight(1);
    getOpenGroundSession.mockReturnValue(null);
    expect(tracker.refresh()).toBe('closed');
    getOpenGroundSession.mockReturnValue(makeSession({ id: 30, source: 'manual' }));
    expect(tracker.refresh()).toBe('updated');
    expect(tracker.status()).toMatchObject({ groundSessionId: 30 });
  });

  it('throws through when the row lookup throws, leaving the cache as it was', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    const before = tracker.status();
    getOpenGroundSession.mockImplementationOnce(() => { throw boom; });

    expect(() => tracker.refresh()).toThrow(boom);
    expect(tracker.status()).toBe(before);
    expect(warned()).toEqual([]);
  });

  it('throws through when the cache build throws, leaving the cache as it was', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    const before = tracker.status();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual', planned_leg_id: 11 }));
    dbMock.getPlannedLegById.mockImplementationOnce(() => { throw boom; });

    expect(() => tracker.refresh()).toThrow(boom);
    expect(tracker.status()).toBe(before);
    expect(warned()).toEqual([]);
  });
});

describe('GroundTracker.clearCache, status, openSessionLegId and reset', () => {
  it('status is null before anything is tracked', () => {
    expect(new GroundTracker().status()).toBeNull();
  });

  it('clearCache drops only the cache: the anchor and the memo survive', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));

    tracker.clearCache();

    expect(tracker.status()).toBeNull();
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 5)))).toBe('left-anchor');
    expect(tracker.handOffToFlight(1)).toEqual({ outAt: T0, airportIcao: null, stand: null });
  });

  it('openSessionLegId reads the open row on every call', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual', planned_leg_id: 11 }));
    expect(tracker.openSessionLegId()).toBe(11);
    getOpenGroundSession.mockReturnValue(makeSession({ source: 'manual', planned_leg_id: 12 }));
    expect(tracker.openSessionLegId()).toBe(12);
    expect(getOpenGroundSession).toHaveBeenCalledTimes(2);
  });

  it('openSessionLegId is null for no row and for a row with no leg', () => {
    const tracker = new GroundTracker();
    getOpenGroundSession.mockReturnValue(null);
    expect(tracker.openSessionLegId()).toBeNull();
    getOpenGroundSession.mockReturnValue(makeSession({ planned_leg_id: null }));
    expect(tracker.openSessionLegId()).toBeNull();
  });

  it('openSessionLegId ignores the cache and throws through when the read throws', () => {
    const tracker = enteredTracker();
    getOpenGroundSession.mockReturnValue(null);
    expect(tracker.openSessionLegId()).toBeNull();
    getOpenGroundSession.mockImplementationOnce(() => { throw boom; });
    expect(() => tracker.openSessionLegId()).toThrow(boom);
  });

  it('reset clears the cache, the anchor, the streak and the memo, and closes nothing', () => {
    const tracker = enteredTracker({ airport_icao: 'KSBA' });
    tracker.observeGround(parked({ groundSpeedKnots: 6 }));
    idleFrames(tracker, GROUND_DEBOUNCE_FRAMES - 1);

    tracker.reset();

    expect(tracker.status()).toBeNull();
    expect(tracker.observeGround(parked(northOfNm(KSBA, GROUND_REANCHOR_NM + 5)))).toBe('at-anchor');
    expect(tracker.observeIdle(parked())).toBe('not-yet');
    expect(tracker.handOffToFlight(1).outAt).toBeNull();
    expect(closeOpenGroundSession).toHaveBeenCalledTimes(1);
    expect(closeOpenGroundSession).toHaveBeenCalledWith('flight-started', 1);
  });
});

describe('GroundTracker under the coordinator', () => {
  it('a session adopted while IDLE survives a resume: the resume reaches no ground tracking', () => {
    const fm = new FlightManager();
    getOpenGroundSession.mockReturnValue(makeSession({ id: 61, source: 'manual', airport_icao: 'KSBA' }));
    fm.refreshGroundSession();
    expect(fm.getGroundSessionStatus()).toMatchObject({ groundSessionId: 61, airportIcao: 'KSBA' });
    dbMock.getOpenFlight.mockReturnValue({
      id: 77, aircraft: 'A320', start_time: T0, departure_lat: KSBA.lat, departure_lon: KSBA.lon,
    });

    fm.onFrame(makeFrame());

    expect(fm.appState.flightState).toBe('FLYING');
    expect(dbMock.insertFlight).not.toHaveBeenCalled();
    expect(closeOpenGroundSession).not.toHaveBeenCalled();
    expect(fm.getGroundSessionStatus()).toMatchObject({ groundSessionId: 61, airportIcao: 'KSBA' });
  });

  it('a flight resumed on a parked first frame leaves no parked streak behind: after it lands, GROUND takes the full debounce', () => {
    const fm = new FlightManager();
    dbMock.getOpenFlight.mockReturnValue({
      id: 77, aircraft: 'A320', start_time: T0, departure_lat: KSBA.lat, departure_lon: KSBA.lon,
    });
    const feedParked = (): void => {
      vi.advanceTimersByTime(1000);
      fm.onFrame(parked());
    };

    fm.onFrame(parked());
    expect(fm.appState.flightState).toBe('FLYING');
    for (let i = 0; i < 50 && fm.appState.flightState === 'FLYING'; i++) feedParked();
    expect(fm.appState.flightState).toBe('IDLE');

    for (let i = 1; i < GROUND_DEBOUNCE_FRAMES; i++) {
      feedParked();
      expect(fm.appState.flightState).toBe('IDLE');
    }
    feedParked();
    expect(fm.appState.flightState).toBe('GROUND');
  });
});
