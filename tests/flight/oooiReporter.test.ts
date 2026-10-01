// tests/flight/oooiReporter.test.ts — tests src/flight/oooiReporter.ts.
//
// The emitter (src/acarsEvents.ts) and the airport lookup are replaced, so the
// only thing observed is what the reporter hands to fileAcarsMessageOnce().
// The message builders (src/acars.ts) stay real but are wrapped, which lets the
// tests pin both the exact input of every build and the order of build and file
// calls: each message is built immediately before it is filed.
//
// The position-report tests drive maybePositionReport() with a fake
// LegStatusSource and explicit elapsed milliseconds, so every window boundary
// is a literal. The interval is 30 000 ms there (POSITION_REPORT_INTERVAL_MIN
// = 0.5), which is the smallest the parser allows.
//
// The last block drives a real FlightManager (with the database replaced too)
// for the one rule only the coordinator can get wrong: touchdown ON is filed on
// the first on-ground frame, whatever its ground speed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { PlannedLegLiveStatus } from '../../src/types';
import {
  airportsMock, acarsEventsMock, resetMocks, makeFrame, T0, useFakeClock, useRealClock,
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
vi.mock('../../src/acars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/acars')>();
  return {
    ...actual,
    buildOooiMessage: vi.fn(actual.buildOooiMessage),
    buildPositionReportMessage: vi.fn(actual.buildPositionReportMessage),
  };
});

import { buildOooiMessage, buildPositionReportMessage } from '../../src/acars';
import { OooiReporter } from '../../src/flight/oooiReporter';
import { FlightManager } from '../../src/flightManager';
import type { LegStatusSource } from '../../src/flight/oooiReporter';
import type { LegRefs } from '../../src/flight/plannedLegLink';
import type { OutBlocks } from '../../src/flight/groundTracker';

const build = vi.mocked(buildOooiMessage);
const buildReport = vi.mocked(buildPositionReportMessage);
const file = acarsEventsMock.fileAcarsMessageOnce;
const findNearestAirport = airportsMock.findNearestAirport;

const FLIGHT = 7;
const FRAME = makeFrame({
  lat: 10.5, lon: -20.25, altitudeFt: 35000, groundSpeedKnots: 450, headingDeg: 91, aircraft: 'Airbus A320',
});
const REFS: LegRefs = { destinationIdent: 'KSFO', plannedLegId: 11 };
const UNLINKED: LegRefs = { destinationIdent: null, plannedLegId: null };
const DEP = { icao: 'KMRY', name: 'Monterey Rgnl' };
const ARR = { icao: 'KLAX', name: 'Los Angeles Intl' };
const OFF_BLOCKS = '2026-09-09T11:50:00.000Z';
const OUT_WITH_MEMO: OutBlocks = { outAt: OFF_BLOCKS, airportIcao: 'KSBA', stand: 'A12' };
const OUT_WITHOUT_MEMO: OutBlocks = { outAt: null, airportIcao: 'KSBA', stand: 'A12' };
const END_TIME = '2026-09-09T14:30:00.000Z';
// Deliberately different from the clock and from every other instant here.
const POINT_TS = '2026-09-09T12:05:07.000Z';

const STATUS: PlannedLegLiveStatus = {
  plannedLegId: 11,
  tripId: 3,
  tripName: 'Test Trip',
  destinationIdent: 'KSFO',
  nextWaypointIdent: 'WPT1',
  remainingDistanceNm: 123.4,
  distanceIsApproximate: true,
};

const INTERVAL_MS = 30_000;
const boom = new Error('route table is locked');

const logged = (): unknown[][] => vi.mocked(console.log).mock.calls;
const warned = (): unknown[][] => vi.mocked(console.warn).mock.calls;

interface FakeLeg extends LegStatusSource {
  currentLegId: Mock<() => number | null>;
  status: Mock<(lat: number, lon: number) => PlannedLegLiveStatus | null>;
}

/** A fake link: linked to leg 11 and reporting STATUS unless a test says otherwise. */
function fakeLeg(): FakeLeg {
  return {
    currentLegId: vi.fn<() => number | null>(() => 11),
    status: vi.fn<(lat: number, lon: number) => PlannedLegLiveStatus | null>(() => STATUS),
  };
}

/** What each fileAcarsMessageOnce() call was given, as [builtMessage, context]. */
const filedCalls = (): unknown[][] => file.mock.calls;
const contexts = (): unknown[] => file.mock.calls.map(c => c[1]);

/** Asserts that filed call n carries exactly the n-th built OOOI message, under `context`. */
function expectFiledBuilt(fileIndex: number, buildIndex: number, context: string): void {
  expect(filedCalls()[fileIndex][0]).toBe(build.mock.results[buildIndex].value);
  expect(filedCalls()[fileIndex][1]).toBe(context);
}

/** Asserts that every build of the given indexes happened right before the file call of the same index. */
function expectBuildImmediatelyBeforeFile(pairs: number): void {
  for (let i = 0; i < pairs; i++) {
    const built = build.mock.invocationCallOrder[i];
    const filed = file.mock.invocationCallOrder[i];
    expect(built).toBeLessThan(filed);
    if (i + 1 < pairs) expect(filed).toBeLessThan(build.mock.invocationCallOrder[i + 1]);
  }
}

const savedInterval = process.env.POSITION_REPORT_INTERVAL_MIN;

beforeEach(() => {
  resetMocks();
  build.mockClear();
  buildReport.mockClear();
  delete process.env.POSITION_REPORT_INTERVAL_MIN;
  useFakeClock();
});

afterEach(() => {
  useRealClock();
  if (savedInterval === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
  else process.env.POSITION_REPORT_INTERVAL_MIN = savedInterval;
});

/** A reporter whose flight began with the interval env at `intervalMin` (null: unset); the begin's log line is forgotten. */
function begun(intervalMin: string | null = '0.5'): OooiReporter {
  const reporter = new OooiReporter();
  if (intervalMin === null) delete process.env.POSITION_REPORT_INTERVAL_MIN;
  else process.env.POSITION_REPORT_INTERVAL_MIN = intervalMin;
  reporter.beginFlight(FLIGHT);
  vi.mocked(console.log).mockClear();
  return reporter;
}

describe('beginFlight', () => {
  it.each([
    ['0.5', '0.5'],
    ['1', '1.0'],
    ['2.5', '2.5'],
    [undefined, '10.0'],
  ])('logs the resolved interval, in minutes with one decimal (env %s)', (env, text) => {
    if (env === undefined) delete process.env.POSITION_REPORT_INTERVAL_MIN;
    else process.env.POSITION_REPORT_INTERVAL_MIN = env;
    new OooiReporter().beginFlight(FLIGHT);
    expect(logged()).toEqual([[`[FlightManager] Flight #7 position reports every ${text} min`]]);
    expect(warned()).toEqual([]);
  });

  it('logs the disabled line, and only that, when the interval is 0', () => {
    process.env.POSITION_REPORT_INTERVAL_MIN = '0';
    new OooiReporter().beginFlight(FLIGHT);
    expect(logged()).toEqual([['[FlightManager] Flight #7 position reports disabled (POSITION_REPORT_INTERVAL_MIN=0)']]);
    expect(warned()).toEqual([]);
  });

  it('files nothing', () => {
    new OooiReporter().beginFlight(FLIGHT);
    expect(file).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: 'beginFlight', restart: (r: OooiReporter) => r.beginFlight(8) },
  { name: 'resumeFlight', restart: (r: OooiReporter) => r.resumeFlight() },
])('$name resets the previous flight', ({ restart }) => {
  it('clears the ON flag, so the next touchdown files ON again', () => {
    const reporter = begun();
    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    expect(file).toHaveBeenCalledTimes(1);

    restart(reporter);
    reporter.onTouchdown(8, FRAME, REFS);
    expect(contexts()).toEqual(['Flight #7 ON', 'Flight #8 ON']);
  });

  it('clears the ON flag that the arrival fallback set', () => {
    const reporter = begun();
    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    expect(contexts()).toEqual(['Flight #7 ON', 'Flight #7 IN']);

    restart(reporter);
    reporter.onTouchdown(8, FRAME, REFS);
    expect(contexts()).toEqual(['Flight #7 ON', 'Flight #7 IN', 'Flight #8 ON']);
  });

  it('clears the report window, so the first window of the next flight files again', () => {
    const reporter = begun();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 3 * INTERVAL_MS, fakeLeg());
    expect(buildReport).toHaveBeenCalledTimes(1);

    restart(reporter);
    reporter.maybePositionReport(8, FRAME, POINT_TS, INTERVAL_MS, fakeLeg());
    expect(buildReport).toHaveBeenCalledTimes(2);
    expect(buildReport.mock.calls[1][0]).toMatchObject({ flightId: 8, windowIndex: 1 });
  });

  it('resolves the interval from the environment again, not once per reporter', () => {
    const reporter = begun('0');
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(buildReport).not.toHaveBeenCalled();

    process.env.POSITION_REPORT_INTERVAL_MIN = '0.5';
    restart(reporter);
    reporter.maybePositionReport(8, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(1);

    process.env.POSITION_REPORT_INTERVAL_MIN = '0';
    restart(reporter);
    reporter.maybePositionReport(9, FRAME, POINT_TS, 10 * INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(1);
  });

});

describe('resumeFlight', () => {
  it('writes no log line, whether the interval is on or off', () => {
    const reporter = begun();
    reporter.resumeFlight();
    process.env.POSITION_REPORT_INTERVAL_MIN = '0';
    reporter.resumeFlight();

    expect(logged()).toEqual([]);
    expect(warned()).toEqual([]);
    expect(file).not.toHaveBeenCalled();
  });
});

describe('fileOutOff', () => {
  it('files OUT at the off-blocks instant with the ground session\'s airport and stand, then OFF at takeoff', () => {
    new OooiReporter().fileOutOff(FLIGHT, FRAME, OUT_WITH_MEMO, T0, DEP, REFS);

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, {
      flightId: 7, event: 'OUT', at: OFF_BLOCKS, airportIcao: 'KSBA', stand: 'A12',
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: false,
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      flightId: 7, event: 'OFF', at: T0, airportIcao: 'KMRY', stand: null,
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: false,
    });
    expect(file).toHaveBeenCalledTimes(2);
    expectFiledBuilt(0, 0, 'Flight #7 OUT');
    expectFiledBuilt(1, 1, 'Flight #7 OFF');
    expectBuildImmediatelyBeforeFile(2);
  });

  it('takes OUT at the takeoff instant and marks it estimated when no off-blocks instant was recorded', () => {
    new OooiReporter().fileOutOff(FLIGHT, FRAME, OUT_WITHOUT_MEMO, T0, DEP, REFS);

    expect(build).toHaveBeenNthCalledWith(1, {
      flightId: 7, event: 'OUT', at: T0, airportIcao: 'KSBA', stand: 'A12',
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: true,
    });
    expect(build.mock.calls[1][0]).toMatchObject({ event: 'OFF', at: T0, estimated: false });
    expect(JSON.parse(build.mock.results[0].value.payload_json)).toMatchObject({ at: T0, estimated: true });
  });

  it('keeps an empty ground session out of OUT and a missing departure airport out of OFF', () => {
    const noSession: OutBlocks = { outAt: null, airportIcao: null, stand: null };
    new OooiReporter().fileOutOff(FLIGHT, FRAME, noSession, T0, null, UNLINKED);

    expect(build).toHaveBeenNthCalledWith(1, {
      flightId: 7, event: 'OUT', at: T0, airportIcao: null, stand: null,
      aircraft: 'Airbus A320', destinationIdent: null, plannedLegId: null, estimated: true,
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      flightId: 7, event: 'OFF', at: T0, airportIcao: null, stand: null,
      aircraft: 'Airbus A320', destinationIdent: null, plannedLegId: null, estimated: false,
    });
  });

  it('never carries the stand over to OFF, and files both for the flight it was given', () => {
    new OooiReporter().fileOutOff(12, FRAME, OUT_WITH_MEMO, T0, DEP, REFS);
    expect(build.mock.calls[1][0]).toMatchObject({ flightId: 12, stand: null });
    expect(contexts()).toEqual(['Flight #12 OUT', 'Flight #12 OFF']);
  });

  it('does not look up an airport, log, or mark ON as filed', () => {
    const reporter = new OooiReporter();
    reporter.fileOutOff(FLIGHT, FRAME, OUT_WITH_MEMO, T0, DEP, REFS);
    expect(findNearestAirport).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);

    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    expect(contexts()).toEqual(['Flight #7 OUT', 'Flight #7 OFF', 'Flight #7 ON']);
  });
});

describe('onTouchdown', () => {
  it('files ON at the current instant, at the nearest airport, with the leg\'s refs', () => {
    findNearestAirport.mockReturnValue(ARR);
    new OooiReporter().onTouchdown(FLIGHT, FRAME, REFS);

    expect(findNearestAirport).toHaveBeenCalledTimes(1);
    expect(findNearestAirport).toHaveBeenCalledWith(10.5, -20.25);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith({
      flightId: 7, event: 'ON', at: T0, airportIcao: 'KLAX', stand: null,
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: false,
    });
    expect(file).toHaveBeenCalledTimes(1);
    expectFiledBuilt(0, 0, 'Flight #7 ON');
  });

  it('files ON with no airport when none is in range, and with null refs when unlinked', () => {
    findNearestAirport.mockReturnValue(null);
    new OooiReporter().onTouchdown(FLIGHT, FRAME, UNLINKED);

    expect(build).toHaveBeenCalledWith({
      flightId: 7, event: 'ON', at: T0, airportIcao: null, stand: null,
      aircraft: 'Airbus A320', destinationIdent: null, plannedLegId: null, estimated: false,
    });
  });

  it('reads the clock before the airport lookup', () => {
    findNearestAirport.mockImplementation(() => {
      vi.advanceTimersByTime(5000);
      return ARR;
    });
    new OooiReporter().onTouchdown(FLIGHT, FRAME, REFS);

    expect(build.mock.calls[0][0]).toMatchObject({ at: T0 });
  });

  it('files ON once however many on-ground frames follow', () => {
    const reporter = new OooiReporter();
    for (let i = 0; i < 5; i++) reporter.onTouchdown(FLIGHT, FRAME, REFS);

    expect(file).toHaveBeenCalledTimes(1);
    expect(findNearestAirport).toHaveBeenCalledTimes(1);
  });

  it('sets the flag before the currentFlightId null guard: a null id files nothing but still counts as filed', () => {
    const reporter = new OooiReporter();
    reporter.onTouchdown(null, FRAME, REFS);
    expect(file).not.toHaveBeenCalled();
    expect(findNearestAirport).not.toHaveBeenCalled();

    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    expect(file).not.toHaveBeenCalled();
    expect(findNearestAirport).not.toHaveBeenCalled();

    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    expect(contexts()).toEqual(['Flight #7 IN']);
  });

  it('sets the flag before the airport lookup: a throw propagates, ON is never retried and the arrival adds no ON', () => {
    findNearestAirport.mockImplementationOnce(() => { throw boom; });
    const reporter = new OooiReporter();

    expect(() => reporter.onTouchdown(FLIGHT, FRAME, REFS)).toThrow(boom);
    expect(file).not.toHaveBeenCalled();
    expect(warned()).toEqual([]);

    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    expect(findNearestAirport).toHaveBeenCalledTimes(1);
    expect(file).not.toHaveBeenCalled();

    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    expect(contexts()).toEqual(['Flight #7 IN']);
  });
});

describe('fileArrival', () => {
  it('files an estimated ON at the end instant when no touchdown was seen, then IN', () => {
    new OooiReporter().fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, {
      flightId: 7, event: 'ON', at: END_TIME, airportIcao: 'KLAX', stand: null,
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: true,
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      flightId: 7, event: 'IN', at: END_TIME, airportIcao: 'KLAX', stand: null,
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: false,
    });
    expect(file).toHaveBeenCalledTimes(2);
    expectFiledBuilt(0, 0, 'Flight #7 ON');
    expectFiledBuilt(1, 1, 'Flight #7 IN');
    expectBuildImmediatelyBeforeFile(2);
  });

  it('files only IN once the touchdown ON is filed', () => {
    const reporter = new OooiReporter();
    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    file.mockClear();
    build.mockClear();

    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith({
      flightId: 7, event: 'IN', at: END_TIME, airportIcao: 'KLAX', stand: null,
      aircraft: 'Airbus A320', destinationIdent: 'KSFO', plannedLegId: 11, estimated: false,
    });
    expect(contexts()).toEqual(['Flight #7 IN']);
  });

  it('marks ON as filed, so a second arrival and a later touchdown add no ON', () => {
    const reporter = new OooiReporter();
    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    reporter.fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    reporter.onTouchdown(FLIGHT, FRAME, REFS);

    expect(contexts()).toEqual(['Flight #7 ON', 'Flight #7 IN', 'Flight #7 IN']);
    expect(findNearestAirport).not.toHaveBeenCalled();
  });

  it('files IN even when ON was not created, and with no airport and no leg when there is none', () => {
    file.mockReturnValueOnce(false);
    new OooiReporter().fileArrival(FLIGHT, FRAME, END_TIME, null, UNLINKED);

    expect(build).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'ON', airportIcao: null, destinationIdent: null, plannedLegId: null, estimated: true,
    }));
    expect(build).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'IN', airportIcao: null, destinationIdent: null, plannedLegId: null, estimated: false,
    }));
    expect(contexts()).toEqual(['Flight #7 ON', 'Flight #7 IN']);
  });

  it('does not look up an airport or log', () => {
    new OooiReporter().fileArrival(FLIGHT, FRAME, END_TIME, ARR, REFS);
    expect(findNearestAirport).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });
});

describe('maybePositionReport', () => {
  it('files the report for the first window with the point\'s own timestamp and the leg\'s status', () => {
    const reporter = begun();
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);

    expect(leg.status).toHaveBeenCalledTimes(1);
    expect(leg.status).toHaveBeenCalledWith(10.5, -20.25);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(buildReport).toHaveBeenCalledWith({
      flightId: 7, windowIndex: 1, at: POINT_TS, lat: 10.5, lon: -20.25, altitudeFt: 35000,
      groundSpeedKnots: 450, headingDeg: 91, nextWaypointIdent: 'WPT1', destinationIdent: 'KSFO',
      remainingDistanceNm: 123.4, plannedLegId: 11,
    });
    expect(file).toHaveBeenCalledTimes(1);
    expect(filedCalls()[0][0]).toBe(buildReport.mock.results[0].value);
    expect(filedCalls()[0][1]).toBe('Flight #7 position report');
    expect(buildReport.mock.invocationCallOrder[0]).toBeLessThan(file.mock.invocationCallOrder[0]);
    expect(logged()).toEqual([]);
    expect(warned()).toEqual([]);
  });

  it('stamps the report with the timestamp it was given, not the clock', () => {
    const reporter = begun();
    vi.advanceTimersByTime(3_600_000);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, fakeLeg());

    expect(buildReport.mock.calls[0][0].at).toBe(POINT_TS);
    expect(filedCalls()[0][0]).toMatchObject({ sent_at: POINT_TS });
  });

  it('counts windows by whole intervals elapsed: nothing before the first, and a report exactly on a boundary', () => {
    const reporter = begun();
    const leg = fakeLeg();

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 0, leg);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS - 1, leg);
    expect(leg.status).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(buildReport.mock.calls[0][0].windowIndex).toBe(1);
  });

  it('files one report per window: later points in the same window, even past its midpoint, file nothing', () => {
    const reporter = begun();
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    for (const elapsed of [INTERVAL_MS + 1, 1.5 * INTERVAL_MS, 2 * INTERVAL_MS - 1]) {
      reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, elapsed, leg);
    }
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(leg.status).toHaveBeenCalledTimes(1);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 2 * INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(2);
    expect(buildReport.mock.calls[1][0].windowIndex).toBe(2);
    expect(file).toHaveBeenCalledTimes(2);
  });

  it('never files a window it has already passed, and files a later one even when windows were skipped', () => {
    const reporter = begun();
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 5 * INTERVAL_MS, leg);
    expect(buildReport.mock.calls[0][0].windowIndex).toBe(5);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 4 * INTERVAL_MS, leg);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 5 * INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(leg.status).toHaveBeenCalledTimes(1);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 6 * INTERVAL_MS, leg);
    expect(buildReport.mock.calls[1][0].windowIndex).toBe(6);
  });

  it('files nothing and reads nothing from the link while the interval is 0', () => {
    const reporter = begun('0');
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 10 * 60 * 60_000, leg);

    expect(leg.currentLegId).not.toHaveBeenCalled();
    expect(leg.status).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
    expect(warned()).toEqual([]);
  });

  it('defaults to ten-minute windows when the interval is not configured', () => {
    const reporter = begun(null);
    const leg = fakeLeg();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 600_000 - 1, leg);
    expect(file).not.toHaveBeenCalled();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 600_000, leg);
    expect(file).toHaveBeenCalledTimes(1);
  });

  it('files nothing for an unlinked flight, reads no status, and does not use up the window', () => {
    const reporter = begun();
    const leg = fakeLeg();
    leg.currentLegId.mockReturnValue(null);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(leg.currentLegId).toHaveBeenCalledTimes(1);
    expect(leg.status).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
    expect(warned()).toEqual([]);

    leg.currentLegId.mockReturnValue(11);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(buildReport.mock.calls[0][0].windowIndex).toBe(1);
  });

  it('uses the window up when the status throws: warned once, and the rest of that window neither asks nor warns again', () => {
    const reporter = begun();
    const leg = fakeLeg();
    leg.status.mockImplementationOnce(() => { throw boom; });

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toHaveLength(2);
    expect(warned()[0][0]).toBe('[FlightManager] Position report not filed:');
    expect(warned()[0][1]).toBe(boom);
    expect(file).not.toHaveBeenCalled();

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS + 5000, leg);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 2 * INTERVAL_MS - 1, leg);
    expect(leg.status).toHaveBeenCalledTimes(1);
    expect(warned()).toHaveLength(1);
    expect(file).not.toHaveBeenCalled();

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 2 * INTERVAL_MS, leg);
    expect(leg.status).toHaveBeenCalledTimes(2);
    expect(buildReport.mock.calls[0][0].windowIndex).toBe(2);
    expect(file).toHaveBeenCalledTimes(1);
    expect(warned()).toHaveLength(1);
  });

  it('uses the window up when the status is null: nothing filed, no warning, and the rest of that window does not ask again', () => {
    const reporter = begun();
    const leg = fakeLeg();
    leg.status.mockReturnValueOnce(null);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg);
    expect(leg.status).toHaveBeenCalledTimes(1);
    expect(file).not.toHaveBeenCalled();
    expect(warned()).toEqual([]);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS + 5000, leg);
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 2 * INTERVAL_MS - 1, leg);
    expect(leg.status).toHaveBeenCalledTimes(1);
    expect(warned()).toEqual([]);

    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, 2 * INTERVAL_MS, leg);
    expect(leg.status).toHaveBeenCalledTimes(2);
    expect(buildReport.mock.calls[0][0].windowIndex).toBe(2);
    expect(file).toHaveBeenCalledTimes(1);
  });

  it('swallows a degenerate status from the report builder: warned, nothing filed, nothing thrown', () => {
    const reporter = begun();
    const leg = fakeLeg();
    leg.status.mockReturnValue({ ...STATUS, remainingDistanceNm: undefined as unknown as number });

    expect(() => reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg)).not.toThrow();
    expect(warned()).toHaveLength(1);
    expect(warned()[0][0]).toBe('[FlightManager] Position report not filed:');
    expect(warned()[0][1]).toBeInstanceOf(TypeError);
    expect(file).not.toHaveBeenCalled();
  });

  it('swallows an error from the link check as well', () => {
    const reporter = begun();
    const leg = fakeLeg();
    leg.currentLegId.mockImplementationOnce(() => { throw boom; });

    expect(() => reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, leg)).not.toThrow();
    expect(warned()).toEqual([['[FlightManager] Position report not filed:', boom]]);
    expect(leg.status).not.toHaveBeenCalled();
  });

  it('does not touch the ON flag', () => {
    const reporter = begun();
    reporter.maybePositionReport(FLIGHT, FRAME, POINT_TS, INTERVAL_MS, fakeLeg());
    file.mockClear();

    reporter.onTouchdown(FLIGHT, FRAME, REFS);
    expect(contexts()).toEqual(['Flight #7 ON']);
  });
});

describe('through the coordinator', () => {
  it('files touchdown ON on the first on-ground frame even at a high ground speed, and the arrival then adds only IN', () => {
    const fm = new FlightManager();
    for (let i = 0; i < 3; i++) fm.onFrame(makeFrame());
    file.mockClear();
    build.mockClear();
    findNearestAirport.mockClear();

    vi.advanceTimersByTime(1000);
    fm.onFrame(makeFrame({ onGround: true, groundSpeedKnots: 60, airspeedKnots: 60 }));
    expect(contexts()).toEqual(['Flight #1 ON']);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toMatchObject({
      flightId: 1, event: 'ON', at: '2026-09-09T12:00:01.000Z', estimated: false,
    });

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1000);
      fm.onFrame(makeFrame({ onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 }));
    }
    expect(contexts()).toEqual(['Flight #1 ON', 'Flight #1 IN']);
    expect(findNearestAirport).toHaveBeenCalledTimes(2);
  });
});
