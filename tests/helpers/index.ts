// tests/helpers/index.ts — shared test-helpers module.
//
// One file, one owner: this module owns its defaults; other test files
// import it read-only. Defaults below are a frozen contract — a test that
// needs a different value overrides it at the call site with `over`, it does
// not edit the defaults here.
//
// No native sqlite bindings, no http/https, no live database file, no real
// wall clock dependency at module scope. useFakeClock() / useRealClock() are
// opt-in per test file, not applied here.

import { vi } from 'vitest';
import type { SimFrame, LegMatchCandidate, PlannedLegWithChildren, PlannedWaypoint } from '../../src/types';
import type { HandCloseFlight, HandCloseLeg } from '../../src/plannedLegClose';

// ── makeFrame ────────────────────────────────────────────────────────────────

export function makeFrame(over: Partial<SimFrame> = {}): SimFrame {
  return {
    lat: 34.426201,
    lon: -119.841507,
    altitudeFt: 1500,
    airspeedKnots: 110,
    groundSpeedKnots: 105,
    headingDeg: 270,
    verticalSpeedFpm: 500,
    onGround: false,
    simRunning: 1,
    aircraft: 'Cessna 172',
    ...over,
  };
}

// ── makeCandidate ────────────────────────────────────────────────────────────

export function makeCandidate(over: Partial<LegMatchCandidate> = {}): LegMatchCandidate {
  return {
    plannedLegId: 11,
    tripId: 1,
    seq: 1,
    departureIdent: 'KSBA',
    departureIsAirport: true,
    departureLat: 34.426201,
    departureLon: -119.841507,
    status: 'planned',
    linkedFlightId: null,
    aircraftType: 'C172',
    ...over,
  };
}

// ── makeHandCloseFlight / makeHandCloseLeg ───────────────────────────────────
// Structural subsets declared in src/plannedLegClose.ts:47-66, not src/types.ts.

export function makeHandCloseFlight(over: Partial<HandCloseFlight> = {}): HandCloseFlight {
  return {
    id: 900,
    end_time: '2026-09-07T17:06:00.726Z',
    planned_leg_id: 500,
    planned_leg_link_source: 'manual',
    arrival_lat: 34.426201,
    arrival_lon: -119.841507,
    ...over,
  };
}

export function makeHandCloseLeg(over: Partial<HandCloseLeg> = {}): HandCloseLeg {
  return {
    id: 500,
    status: 'planned',
    destination_lat: 36.586952,
    destination_lon: -121.843079,
    ...over,
  };
}

// ── makePlannedLegWithChildren ────────────────────────────────────────────────
// Wide row type (src/types.ts:238-242, ~40 fields); FlightManager reads only
// id, trip_id, departure_ident, destination_ident, destination_lat,
// destination_lon, waypoints[]. Every field not named above defaults
// to null. Departure first, destination last in `waypoints` — the order
// buildPlannedLegCache() (src/flightManager.ts:118) depends on.

const DEFAULT_WAYPOINTS: PlannedWaypoint[] = [
  {
    id: 1, planned_leg_id: 11, seq: 1, ident: 'KSBA', name: 'Santa Barbara Muni',
    region: null, airway: null, track: null, type: 'AIRPORT', comment: null,
    lat: 34.426201, lon: -119.841507, alt_ft: null,
  },
  {
    id: 2, planned_leg_id: 11, seq: 2, ident: 'KMRY', name: 'Monterey Rgnl',
    region: null, airway: null, track: null, type: 'AIRPORT', comment: null,
    lat: 36.586952, lon: -121.843079, alt_ft: null,
  },
];

export function makePlannedLegWithChildren(over: Partial<PlannedLegWithChildren> = {}): PlannedLegWithChildren {
  return {
    id: 11,
    trip_id: 1,
    seq: 1,
    status: 'planned',

    departure_ident: 'KSBA',
    departure_name: 'Santa Barbara Muni',
    departure_lat: 34.426201,
    departure_lon: -119.841507,
    departure_is_airport: 1,
    departure_start: null,
    departure_start_type: null,
    departure_pos_lat: null,
    departure_pos_lon: null,

    destination_ident: 'KMRY',
    destination_name: 'Monterey Rgnl',
    destination_lat: 36.586952,
    destination_lon: -121.843079,
    destination_is_airport: 1,

    is_snippet: 0,
    cruise_alt_ft: 7500,
    flightplan_type: 'VFR',
    aircraft_type: 'C172',

    sid_name: null,
    sid_runway: null,
    sid_transition: null,
    sid_type: null,
    sid_custom_distance_nm: null,

    star_name: null,
    star_runway: null,
    star_transition: null,

    approach_name: null,
    approach_runway: null,
    approach_transition: null,
    approach_type: null,
    approach_arinc: null,
    approach_suffix: null,
    approach_transition_type: null,
    approach_custom_distance_nm: null,
    approach_custom_altitude_ft: null,
    approach_custom_offset_deg: null,

    waypoint_count: 2,
    alternate_count: 0,
    approx_distance_nm: 162.5,
    arrival_deviation_nm: null,

    remarks: null,
    plan_created_at: '2026-09-04T21:08:44.000Z',
    source_filename: 'VFR Santa Barbara Muni (KSBA) to Monterey Rgnl (KMRY).lnmpln',
    source_sha256: '0'.repeat(64),
    source_program: 'Little Navmap 3.0.18',
    imported_at: '2026-09-09T12:00:00.000Z',

    linked_flight_id: null,
    alternates: [],
    waypoints: DEFAULT_WAYPOINTS.map(w => ({ ...w })),

    ...over,
  };
}

/**
 * Same fixture, but a loose leg (trip_id: null) — for a test that needs a
 * planned leg with no owning trip. Everything else is
 * makePlannedLegWithChildren's default unless overridden.
 */
export function makeLoosePlannedLegWithChildren(over: Partial<PlannedLegWithChildren> = {}): PlannedLegWithChildren {
  return makePlannedLegWithChildren({ trip_id: null, ...over });
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
// One arc-minute is NOT one nautical mile in this codebase (R=3440.065 in
// src/geo.ts) — never hardcode "/60" in this module.

export const NM_PER_DEG = (Math.PI * 3440.065) / 180; // 60.04046120432669
export const DEG_PER_NM = 1 / NM_PER_DEG; // 0.016655435148240015

export function northOfNm(pos: { lat: number; lon: number }, nm: number): { lat: number; lon: number } {
  return { lat: pos.lat + nm * DEG_PER_NM, lon: pos.lon };
}

// ── Named real positions ─────────────────────────────────────────────────────

export const KSBA = { lat: 34.426201, lon: -119.841507 };
export const KSFO = { lat: 37.618023, lon: -122.375519 };
export const KMRY = { lat: 36.586952, lon: -121.843079 };
export const KLAX = { lat: 33.942474, lon: -118.409332 };
export const KSTS = { lat: 38.509693, lon: -122.812897 };
export const KACV = { lat: 40.977814, lon: -124.108475 };

// ── Faking time ───────────────────────────────────────────────────────────────
// Opt-in per test file. Do NOT call these at module scope — a pure module
// must not acquire a hidden clock dependency.

export const T0 = '2026-09-09T12:00:00.000Z';

export function useFakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
}

export function useRealClock(): void {
  vi.useRealTimers();
}

// ── Faking module boundaries ──────────────────────────────────────────────────
//
// Consuming test files do:
//   vi.mock('../src/db',       async () => (await import('./helpers')).dbMock);
//   vi.mock('../src/airports', async () => (await import('./helpers')).airportsMock);
// The vi.mock() call itself is each consuming test file's job, not this
// module's — this module only exports the mock objects and the reset.

// All thirteen functions src/flightManager.ts imports from './db'.
export const dbMock = {
  insertFlight: vi.fn(),
  insertPoint: vi.fn(),
  closeFlight: vi.fn(),
  getFlightPlannedLegId: vi.fn(),
  getActiveTripId: vi.fn(),
  getPlannedLegCandidatesForActiveTrip: vi.fn(),
  getPlannedLegById: vi.fn(),
  linkFlightToPlannedLeg: vi.fn(),
  recordPlannedLegArrival: vi.fn(),
  getTripName: vi.fn(),
  getOpenFlight: vi.fn(),
  getFlightTrackPoints: vi.fn(),
  getLastFlightPoint: vi.fn(),
};

/**
 * getLastFlightPoint()'s default: the newest point of whatever track the test
 * scripted on getFlightTrackPoints, read through its implementation without
 * recording a call, so the two reads agree the way they do against one
 * table. Columns the track does not carry read 0 (and on_ground 0). A
 * scripted track that throws is the adoption failure that test is about, so
 * here it reads as no points. Only the persistent implementation is read: a
 * mockReturnValueOnce or mockImplementationOnce on getFlightTrackPoints is
 * not seen here.
 */
export function lastPointOfTrack(
  readTrack: ((id: number) => unknown) | undefined, flightId: number,
): Record<string, unknown> | null {
  let track: unknown;
  try {
    track = readTrack?.(flightId);
  } catch {
    return null;
  }
  if (!Array.isArray(track) || track.length === 0) return null;
  return {
    ground_speed_kts: 0, heading_deg: 0, vertical_speed_fpm: 0, on_ground: 0,
    ...(track[track.length - 1] as Record<string, unknown>),
  };
}

// The one function (plus initAirports) src/flightManager.ts imports
// from './airports'.
export const airportsMock = {
  findNearestAirport: vi.fn(),
  initAirports: vi.fn(),
};

// The one function src/flightManager.ts imports from './acarsEvents'. Mocked
// wholesale so a consuming test never reaches the real emitter, which would
// otherwise hit './db/acarsMessages' -> './db/connection' -> better-sqlite3
// before initDb() has ever run.
export const acarsEventsMock = {
  fileAcarsMessageOnce: vi.fn(),
};

// insertFlight issues ids from a module-level counter starting at 1, reset
// by resetMocks(). nextFlightId() lets a test read the next id without
// calling insertFlight itself.
let flightIdCounter = 1;

export function nextFlightId(): number {
  return flightIdCounter;
}

// mockReset() (not mockImplementation() alone) both wipes any implementation
// a test installed and clears call history — vitest's config `restoreMocks:
// true` only restores vi.spyOn() spies (nothing here is one), so this is the
// only thing that gives a consuming test a clean dbMock/airportsMock between
// runs; see the resetMocks() doc comment below.
function installDbMockDefaults(): void {
  dbMock.insertFlight.mockReset().mockImplementation(() => flightIdCounter++);
  dbMock.insertPoint.mockReset().mockImplementation(() => undefined);
  dbMock.closeFlight.mockReset().mockImplementation(() => undefined);
  dbMock.getFlightPlannedLegId.mockReset().mockImplementation(() => null);
  dbMock.getActiveTripId.mockReset().mockImplementation(() => null);
  dbMock.getPlannedLegCandidatesForActiveTrip.mockReset().mockImplementation(() => []);
  dbMock.getPlannedLegById.mockReset().mockImplementation(() => null);
  dbMock.linkFlightToPlannedLeg.mockReset().mockImplementation(() => undefined);
  dbMock.recordPlannedLegArrival.mockReset().mockImplementation(() => undefined);
  dbMock.getTripName.mockReset().mockImplementation(() => 'Test Trip');
  dbMock.getOpenFlight.mockReset().mockImplementation(() => null);
  dbMock.getFlightTrackPoints.mockReset().mockImplementation(() => []);
  dbMock.getLastFlightPoint.mockReset().mockImplementation((id: number) =>
    lastPointOfTrack(dbMock.getFlightTrackPoints.getMockImplementation(), id));
}

function installAirportsMockDefaults(): void {
  airportsMock.findNearestAirport.mockReset().mockImplementation(() => null);
  airportsMock.initAirports.mockReset().mockImplementation(() => Promise.resolve());
}

// Default: every call "succeeds" (a row would have been created), so a test
// that doesn't care about ACARS filing sees no warnings and no special-casing.
function installAcarsEventsMockDefaults(): void {
  acarsEventsMock.fileAcarsMessageOnce.mockReset().mockImplementation(() => true);
}

installDbMockDefaults();
installAirportsMockDefaults();
installAcarsEventsMockDefaults();

/**
 * vitest.config.ts sets `restoreMocks: true`, i.e. `vi.restoreAllMocks()`
 * before every test. Verified against node_modules/@vitest/spy/dist/index.js
 * (4.1.11): that call only restores vi.spyOn() spies (its MOCK_RESTORE set) —
 * it does NOT touch plain vi.fn() objects like dbMock/airportsMock, so it
 * clears neither their installed implementation nor their call history
 * between tests. resetMocks() is therefore the only thing that gives a
 * consuming test a clean dbMock/airportsMock/acarsEventsMock: it RE-INSTALLS every default
 * implementation above via mockReset()+mockImplementation() (which also
 * clears call history, unlike mockImplementation() alone), and resets the
 * flight-id counter to 1. Call this in a consuming test file's
 * beforeEach/afterEach, not here.
 */
export function resetMocks(): void {
  flightIdCounter = 1;
  installDbMockDefaults();
  installAirportsMockDefaults();
  installAcarsEventsMockDefaults();
}
