// tests/flight/plannedLegLink.test.ts — tests src/flight/plannedLegLink.ts.
//
// The matcher (src/legMatcher.ts) and the route arithmetic (./legProgress) are
// real: they are pure, and the refusal texts are built from their output. Only
// the database barrel is replaced, so the candidates and leg rows are ours.
// haversineNm is wrapped rather than replaced: it runs the real arithmetic
// unless a test pins one distance to land exactly on the flown/diverted
// radius, which no coordinate pair reliably does.
//
// Every log and warn text is asserted whole. Operators grep these lines.
//
// The last block drives a real FlightManager (with './airports' and
// './acarsEvents' replaced too) to pin what only the coordinator does with the
// link: it clears it, and it tells the scope listener after every refresh.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { PlannedWaypoint, SimFrame } from '../../src/types';
import {
  dbMock, resetMocks, makeFrame, makeCandidate, makePlannedLegWithChildren,
  makeLoosePlannedLegWithChildren, northOfNm, KSBA, KMRY, useFakeClock, useRealClock,
} from '../helpers';

vi.mock('../../src/db', async () => (await import('../helpers')).dbMock);
vi.mock('../../src/airports', async () => (await import('../helpers')).airportsMock);
vi.mock('../../src/acarsEvents', async () => (await import('../helpers')).acarsEventsMock);
vi.mock('../../src/geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/geo')>();
  return { ...actual, haversineNm: vi.fn(actual.haversineNm) };
});

import { haversineNm } from '../../src/geo';
import { ARRIVAL_RADIUS_NM } from '../../src/legMatcher';
import { PlannedLegLink } from '../../src/flight/plannedLegLink';
import { FlightManager } from '../../src/flightManager';

const FLIGHT = 1;
const TRIP = 7;
const START = '2026-09-09T12:00:00.000Z';
const AT_KSBA = makeFrame({ lat: KSBA.lat, lon: KSBA.lon });

const wp = (seq: number, ident: string, lat: number, lon: number): PlannedWaypoint => ({
  id: seq, planned_leg_id: 11, seq, ident, name: ident,
  region: null, airway: null, track: null, type: 'WAYPOINT', comment: null,
  lat, lon, alt_ft: null,
});

/** Four waypoints due north of KSBA: a straight route with three segments. */
const NORTH_ROUTE = [
  wp(1, 'KSBA', KSBA.lat, KSBA.lon),
  wp(2, 'WPT1', 35.0, KSBA.lon),
  wp(3, 'WPT2', 36.0, KSBA.lon),
  wp(4, 'KEND', 37.0, KSBA.lon),
];

/** Sum of the great-circle chain from waypoints[i] to the last waypoint. */
function chainFrom(waypoints: PlannedWaypoint[], i: number): number {
  let sum = 0;
  for (let k = i; k < waypoints.length - 1; k++) {
    sum += haversineNm(waypoints[k].lat, waypoints[k].lon, waypoints[k + 1].lat, waypoints[k + 1].lon);
  }
  return sum;
}

let realHaversine: typeof haversineNm;

beforeAll(async () => {
  realHaversine = (await vi.importActual<typeof import('../../src/geo')>('../../src/geo')).haversineNm;
});

beforeEach(() => {
  resetMocks();
  vi.mocked(haversineNm).mockReset().mockImplementation(realHaversine);
});

const logged = (): unknown[][] => vi.mocked(console.log).mock.calls;
const warned = (): unknown[][] => vi.mocked(console.warn).mock.calls;

/**
 * An active trip with one eligible candidate departing exactly at `from`, and
 * the leg row the link path reads back.
 */
function arrangeMatch(
  leg = makePlannedLegWithChildren({ trip_id: TRIP }),
  from: { lat: number; lon: number } = KSBA,
): void {
  dbMock.getActiveTripId.mockReturnValue(TRIP);
  dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
    makeCandidate({ plannedLegId: leg.id, tripId: TRIP, departureLat: from.lat, departureLon: from.lon }),
  ]);
  dbMock.getPlannedLegById.mockReturnValue(leg);
}

/** Puts `leg` in the link's cache the way a manual link does, then forgets the calls that took. */
function seedCache(link: PlannedLegLink, leg = makePlannedLegWithChildren({ id: 99, destination_ident: 'KOLD' })): void {
  dbMock.getFlightPlannedLegId.mockReturnValueOnce(leg.id);
  dbMock.getPlannedLegById.mockReturnValueOnce(leg);
  link.refreshForFlight(FLIGHT, FLIGHT);
  for (const fn of Object.values(dbMock)) fn.mockClear();
  vi.mocked(console.log).mockClear();
  vi.mocked(console.warn).mockClear();
}

const SEEDED = { destinationIdent: 'KOLD', plannedLegId: 99 };

/** The three refusal shapes a refusal's parenthetical can take, plus the bare one. */
const REFUSALS: { name: string; arrange: () => void; text: string }[] = [
  {
    name: 'no active trip: the bare reason, no parenthetical',
    arrange: () => { dbMock.getActiveTripId.mockReturnValue(null); },
    text: 'NO_ACTIVE_TRIP',
  },
  {
    name: 'an active trip with no candidates: the bare reason',
    arrange: () => { dbMock.getActiveTripId.mockReturnValue(TRIP); },
    text: 'NO_PLANNED_LEGS',
  },
  {
    name: 'nothing in the radius: only the nearest planned departure is reported',
    arrange: () => {
      dbMock.getActiveTripId.mockReturnValue(TRIP);
      dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
        makeCandidate({ tripId: TRIP, departureLat: northOfNm(KSBA, 42).lat, departureLon: KSBA.lon }),
      ]);
    },
    text: 'NO_LEG_IN_RADIUS (nearest planned departure 42.0 nm away)',
  },
  {
    name: 'ambiguous: the eligible choices are named, with no distance',
    arrange: () => {
      dbMock.getActiveTripId.mockReturnValue(TRIP);
      dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
        makeCandidate({ plannedLegId: 11, tripId: TRIP }),
        makeCandidate({ plannedLegId: 12, tripId: TRIP, seq: 2 }),
      ]);
    },
    text: 'AMBIGUOUS (legs 11, 12 within 10 nm)',
  },
  {
    name: 'one ineligible leg nearby: singular, with the distance to it',
    arrange: () => {
      dbMock.getActiveTripId.mockReturnValue(TRIP);
      dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
        makeCandidate({ plannedLegId: 11, tripId: TRIP, status: 'flown' }),
      ]);
    },
    text: 'LEG_ALREADY_FLOWN (leg 11 within 10 nm, nearest 0.0 nm)',
  },
  {
    name: 'several ineligible legs nearby: plural, with the distance to the nearest',
    arrange: () => {
      dbMock.getActiveTripId.mockReturnValue(TRIP);
      dbMock.getPlannedLegCandidatesForActiveTrip.mockReturnValue([
        makeCandidate({ plannedLegId: 11, tripId: TRIP, status: 'flown', departureLat: northOfNm(KSBA, 5).lat }),
        makeCandidate({ plannedLegId: 12, tripId: TRIP, status: 'skipped', seq: 2 }),
      ]);
    },
    text: 'LEG_SKIPPED (legs 11, 12 within 10 nm, nearest 0.0 nm)',
  },
];

describe('PlannedLegLink.autoLink', () => {
  it('links the matched leg, caches it and logs the whole route', () => {
    arrangeMatch();
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.linkFlightToPlannedLeg).toHaveBeenCalledTimes(1);
    expect(dbMock.linkFlightToPlannedLeg).toHaveBeenCalledWith(FLIGHT, 11, 'auto');
    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 linked to planned leg #11 (KSBA→KMRY, 0.0 nm, MATCHED)'],
    ]);
    expect(warned()).toEqual([]);
    expect(link.refs()).toEqual({ destinationIdent: 'KMRY', plannedLegId: 11 });
    expect(link.currentLegId()).toBe(11);
  });

  it('asks for the active trip and the candidates once each, and the leg row once', () => {
    arrangeMatch();

    new PlannedLegLink().autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.getActiveTripId).toHaveBeenCalledTimes(1);
    expect(dbMock.getPlannedLegCandidatesForActiveTrip).toHaveBeenCalledTimes(1);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledTimes(1);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(11);
  });

  it('reads the leg row before it writes the link', () => {
    arrangeMatch();

    new PlannedLegLink().autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.getPlannedLegById.mock.invocationCallOrder[0])
      .toBeLessThan(dbMock.linkFlightToPlannedLeg.mock.invocationCallOrder[0]);
  });

  it('logs the departure distance to one decimal', () => {
    arrangeMatch(undefined, northOfNm(KSBA, 4.56));

    new PlannedLegLink().autoLink(FLIGHT, AT_KSBA, START);

    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 linked to planned leg #11 (KSBA→KMRY, 4.6 nm, MATCHED)'],
    ]);
  });

  it('caches the trip id and name, and the route the status block reads', () => {
    dbMock.getTripName.mockReturnValue('Coast hop');
    arrangeMatch(makePlannedLegWithChildren({ trip_id: TRIP, waypoints: NORTH_ROUTE, waypoint_count: 4 }));
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.getTripName).toHaveBeenCalledWith(TRIP);
    const status = link.status(34.7, -119.79);
    expect(status).toMatchObject({ plannedLegId: 11, tripId: TRIP, tripName: 'Coast hop', destinationIdent: 'KMRY', nextWaypointIdent: 'WPT1' });
  });

  it('caches an empty trip name, not null, for a trip that has no name row', () => {
    dbMock.getTripName.mockReturnValue(null);
    arrangeMatch();
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, AT_KSBA, START);

    expect(link.status(KSBA.lat, KSBA.lon)!.tripName).toBe('');
  });

  it('caches a null trip name, and never looks one up, for a loose leg', () => {
    arrangeMatch(makeLoosePlannedLegWithChildren());
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.getTripName).not.toHaveBeenCalled();
    expect(link.status(KSBA.lat, KSBA.lon)).toMatchObject({ tripId: null, tripName: null });
  });

  it('still links, and logs without a route, when the leg row is gone; it caches nothing', () => {
    arrangeMatch();
    dbMock.getPlannedLegById.mockReturnValue(null);
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, AT_KSBA, START);

    expect(dbMock.linkFlightToPlannedLeg).toHaveBeenCalledWith(FLIGHT, 11, 'auto');
    expect(logged()).toEqual([['[FlightManager] Flight #1 linked to planned leg #11 (0.0 nm, MATCHED)']]);
    expect(link.currentLegId()).toBeNull();
  });

  it('replaces the cache it inherited when it links, and does not clear it first when it does not', () => {
    const link = new PlannedLegLink();
    seedCache(link);

    arrangeMatch();
    link.autoLink(FLIGHT, AT_KSBA, START);
    expect(link.refs()).toEqual({ destinationIdent: 'KMRY', plannedLegId: 11 });

    seedCache(link);
    arrangeMatch();
    dbMock.getPlannedLegById.mockReturnValue(null);
    link.autoLink(FLIGHT, AT_KSBA, START);
    expect(link.refs()).toEqual(SEEDED);
  });

  describe.each(REFUSALS)('refuses', ({ name, arrange, text }) => {
    it(`${name}`, () => {
      const link = new PlannedLegLink();
      seedCache(link);
      arrange();

      link.autoLink(FLIGHT, AT_KSBA, START);

      expect(logged()).toEqual([[`[FlightManager] Flight #1 not linked — ${text}`]]);
      expect(warned()).toEqual([]);
      expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
      expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
      expect(link.refs()).toEqual(SEEDED);
    });
  });

  it('measures the radius from the frame, not from anywhere else', () => {
    arrangeMatch();
    const link = new PlannedLegLink();

    link.autoLink(FLIGHT, makeFrame({ lat: northOfNm(KSBA, 42).lat, lon: KSBA.lon }), START);

    expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 not linked — NO_LEG_IN_RADIUS (nearest planned departure 42.0 nm away)'],
    ]);
  });

  describe('a database throw', () => {
    const SITES: { name: string; fail: (err: Error) => void; linkWritten: boolean }[] = [
      { name: 'the active trip lookup', fail: err => { dbMock.getActiveTripId.mockImplementation(() => { throw err; }); }, linkWritten: false },
      { name: 'the candidates lookup', fail: err => { dbMock.getPlannedLegCandidatesForActiveTrip.mockImplementation(() => { throw err; }); }, linkWritten: false },
      { name: 'the leg row read', fail: err => { dbMock.getPlannedLegById.mockImplementation(() => { throw err; }); }, linkWritten: false },
      { name: 'the link write', fail: err => { dbMock.linkFlightToPlannedLeg.mockImplementation(() => { throw err; }); }, linkWritten: true },
      { name: 'the trip name read while the cache is built', fail: err => { dbMock.getTripName.mockImplementation(() => { throw err; }); }, linkWritten: true },
    ];

    it.each(SITES)('from $name is swallowed and warned, and leaves the flight unlinked', ({ fail, linkWritten }) => {
      const err = new Error('disk I/O error');
      arrangeMatch();
      fail(err);
      const link = new PlannedLegLink();

      expect(() => link.autoLink(FLIGHT, AT_KSBA, START)).not.toThrow();

      expect(warned()).toHaveLength(1);
      expect(warned()[0][0]).toBe('[FlightManager] Flight #1 auto-link failed, flight recorded unlinked:');
      expect(warned()[0][1]).toBe(err);
      expect(logged()).toEqual([]);
      expect(link.currentLegId()).toBeNull();
      expect(dbMock.linkFlightToPlannedLeg).toHaveBeenCalledTimes(linkWritten ? 1 : 0);
    });
  });
});

describe('PlannedLegLink.matchForGround', () => {
  it('returns the matched leg and its filed departure stand, and logs the route', () => {
    arrangeMatch(makePlannedLegWithChildren({ trip_id: TRIP, departure_start: 'Ramp 3' }));

    const match = new PlannedLegLink().matchForGround(AT_KSBA, START);

    expect(match).toEqual({ plannedLegId: 11, parkingPosition: 'Ramp 3' });
    expect(logged()).toEqual([
      ['[FlightManager] Ground session matched planned leg #11 (KSBA→KMRY, 0.0 nm, MATCHED)'],
    ]);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledTimes(1);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(11);
  });

  it('reports no stand when the leg filed none', () => {
    arrangeMatch(makePlannedLegWithChildren({ trip_id: TRIP, departure_start: null }));

    expect(new PlannedLegLink().matchForGround(AT_KSBA, START)).toEqual({ plannedLegId: 11, parkingPosition: null });
  });

  it('still returns the leg, with no stand and no route in the log, when the leg row is gone', () => {
    arrangeMatch();
    dbMock.getPlannedLegById.mockReturnValue(null);

    const match = new PlannedLegLink().matchForGround(AT_KSBA, START);

    expect(match).toEqual({ plannedLegId: 11, parkingPosition: null });
    expect(logged()).toEqual([['[FlightManager] Ground session matched planned leg #11 (0.0 nm, MATCHED)']]);
  });

  it('never consumes the leg: no link write, no arrival write, no cache change', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    arrangeMatch();

    link.matchForGround(AT_KSBA, START);

    expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
    expect(dbMock.recordPlannedLegArrival).not.toHaveBeenCalled();
    expect(dbMock.getFlightPlannedLegId).not.toHaveBeenCalled();
    expect(link.refs()).toEqual(SEEDED);

    const empty = new PlannedLegLink();
    arrangeMatch();
    empty.matchForGround(AT_KSBA, START);
    expect(empty.currentLegId()).toBeNull();
  });

  describe.each(REFUSALS)('refuses', ({ name, arrange, text }) => {
    it(`${name}`, () => {
      arrange();

      const match = new PlannedLegLink().matchForGround(AT_KSBA, START);

      expect(match).toEqual({ plannedLegId: null, parkingPosition: null });
      expect(logged()).toEqual([[`[FlightManager] Ground session not linked to a planned leg — ${text}`]]);
      expect(warned()).toEqual([]);
      expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
      expect(dbMock.linkFlightToPlannedLeg).not.toHaveBeenCalled();
    });
  });

  describe('a database throw', () => {
    const SITES: { name: string; fail: (err: Error) => void }[] = [
      { name: 'the active trip lookup', fail: err => { dbMock.getActiveTripId.mockImplementation(() => { throw err; }); } },
      { name: 'the candidates lookup', fail: err => { dbMock.getPlannedLegCandidatesForActiveTrip.mockImplementation(() => { throw err; }); } },
      { name: 'the leg row read', fail: err => { dbMock.getPlannedLegById.mockImplementation(() => { throw err; }); } },
    ];

    it.each(SITES)('from $name is swallowed and warned; nothing is matched', ({ fail }) => {
      const err = new Error('disk I/O error');
      arrangeMatch();
      fail(err);

      let match: unknown;
      expect(() => { match = new PlannedLegLink().matchForGround(AT_KSBA, START); }).not.toThrow();

      expect(match).toEqual({ plannedLegId: null, parkingPosition: null });
      expect(warned()).toHaveLength(1);
      expect(warned()[0][0]).toBe('[FlightManager] Ground session leg match failed:');
      expect(warned()[0][1]).toBe(err);
      expect(logged()).toEqual([]);
    });
  });
});

describe('PlannedLegLink.refreshForFlight', () => {
  it('does nothing, and asks nothing, for a flight that is not the current one', () => {
    const link = new PlannedLegLink();
    seedCache(link);

    link.refreshForFlight(2, FLIGHT);
    link.refreshForFlight(FLIGHT, null);

    for (const fn of Object.values(dbMock)) expect(fn).not.toHaveBeenCalled();
    expect(link.refs()).toEqual(SEEDED);
  });

  it('rebuilds the cache from the flight row for the current flight', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(22);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 22, destination_ident: 'KNEW' }));

    link.refreshForFlight(FLIGHT, FLIGHT);

    expect(dbMock.getFlightPlannedLegId).toHaveBeenCalledWith(FLIGHT);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(22);
    expect(link.refs()).toEqual({ destinationIdent: 'KNEW', plannedLegId: 22 });
    expect(logged()).toEqual([]);
    expect(warned()).toEqual([]);
  });

  it('clears the cache when the row has no link, without reading a leg', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(null);

    link.refreshForFlight(FLIGHT, FLIGHT);

    expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
    expect(link.refs()).toEqual({ destinationIdent: null, plannedLegId: null });
  });

  it('clears the cache when the linked leg row is gone', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(22);
    dbMock.getPlannedLegById.mockReturnValue(null);

    link.refreshForFlight(FLIGHT, FLIGHT);

    expect(link.currentLegId()).toBeNull();
  });

  const SITES: { name: string; fail: (err: Error) => void }[] = [
    { name: 'the flight row link read', fail: err => { dbMock.getFlightPlannedLegId.mockImplementation(() => { throw err; }); } },
    { name: 'the leg row read', fail: err => { dbMock.getPlannedLegById.mockImplementation(() => { throw err; }); } },
    { name: 'the trip name read', fail: err => { dbMock.getTripName.mockImplementation(() => { throw err; }); } },
  ];

  it.each(SITES)('lets a throw from $name through and leaves the cache as it was', ({ fail }) => {
    const err = new Error('disk I/O error');
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(22);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 22, trip_id: TRIP }));
    fail(err);

    expect(() => link.refreshForFlight(FLIGHT, FLIGHT)).toThrow(err);

    expect(link.refs()).toEqual(SEEDED);
    expect(warned()).toEqual([]);
  });
});

describe('PlannedLegLink.recordArrival', () => {
  it('marks the leg flown, with the deviation rounded to a tenth, when the frame is at the destination', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());

    new PlannedLegLink().recordArrival(FLIGHT, makeFrame({ lat: KMRY.lat, lon: KMRY.lon }));

    expect(dbMock.getFlightPlannedLegId).toHaveBeenCalledWith(FLIGHT);
    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(11);
    expect(dbMock.recordPlannedLegArrival).toHaveBeenCalledTimes(1);
    expect(dbMock.recordPlannedLegArrival).toHaveBeenCalledWith(11, 'flown', 0);
    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 landed 0.0 nm from planned KMRY — leg #11 marked flown'],
    ]);
  });

  it('marks the leg diverted, and keeps the deviation, when the frame is far from the destination', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());

    new PlannedLegLink().recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival).toHaveBeenCalledWith(11, 'diverted', 162.5);
    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 landed 162.5 nm from planned KMRY — leg #11 marked diverted'],
    ]);
  });

  it('counts a landing exactly on the radius as flown and one just past it as diverted', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());
    const link = new PlannedLegLink();

    vi.mocked(haversineNm).mockReturnValueOnce(ARRIVAL_RADIUS_NM);
    link.recordArrival(FLIGHT, AT_KSBA);
    vi.mocked(haversineNm).mockReturnValueOnce(ARRIVAL_RADIUS_NM + 0.001);
    link.recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival.mock.calls).toEqual([
      [11, 'flown', 10],
      [11, 'diverted', 10],
    ]);
  });

  it('writes the deviation rounded half up to a tenth and logs the unrounded value to one decimal', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());
    vi.mocked(haversineNm).mockReturnValueOnce(12.35);

    new PlannedLegLink().recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival).toHaveBeenCalledWith(11, 'diverted', 12.4);
    expect(logged()).toEqual([
      ['[FlightManager] Flight #1 landed 12.3 nm from planned KMRY — leg #11 marked diverted'],
    ]);
  });

  it('writes the arrival before it logs it', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());

    new PlannedLegLink().recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(console.log).mock.invocationCallOrder[0]);
  });

  it('reads the link from the flight row, not from the cache', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(22);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 22, destination_ident: 'KNEW' }));

    link.recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.getPlannedLegById).toHaveBeenCalledWith(22);
    expect(dbMock.recordPlannedLegArrival.mock.calls[0][0]).toBe(22);
    expect(logged()[0][0]).toContain('planned KNEW — leg #22 marked');
    expect(link.refs()).toEqual(SEEDED);
  });

  it('records against the row link even when nothing is cached', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(22);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren({ id: 22 }));
    const link = new PlannedLegLink();

    link.recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival.mock.calls[0][0]).toBe(22);
    expect(link.currentLegId()).toBeNull();
  });

  it('writes nothing when the row says the flight was unlinked, whatever the cache holds', () => {
    const link = new PlannedLegLink();
    seedCache(link);
    dbMock.getFlightPlannedLegId.mockReturnValue(null);

    link.recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
    expect(dbMock.recordPlannedLegArrival).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
    expect(link.refs()).toEqual(SEEDED);
  });

  it('writes and logs nothing when the linked leg row is gone', () => {
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(null);

    new PlannedLegLink().recordArrival(FLIGHT, AT_KSBA);

    expect(dbMock.recordPlannedLegArrival).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
    expect(warned()).toEqual([]);
  });

  const SITES: { name: string; fail: (err: Error) => void }[] = [
    { name: 'the flight row link read', fail: err => { dbMock.getFlightPlannedLegId.mockImplementation(() => { throw err; }); } },
    { name: 'the leg row read', fail: err => { dbMock.getPlannedLegById.mockImplementation(() => { throw err; }); } },
    { name: 'the arrival write', fail: err => { dbMock.recordPlannedLegArrival.mockImplementation(() => { throw err; }); } },
  ];

  it.each(SITES)('a throw from $name is swallowed and warned, with no landing line', ({ fail }) => {
    const err = new Error('disk I/O error');
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());
    fail(err);

    expect(() => new PlannedLegLink().recordArrival(FLIGHT, AT_KSBA)).not.toThrow();

    expect(warned()).toHaveLength(1);
    expect(warned()[0][0]).toBe('[FlightManager] Flight #1 arrival not recorded on its planned leg:');
    expect(warned()[0][1]).toBe(err);
    expect(logged()).toEqual([]);
  });
});

describe('PlannedLegLink.status, refs, currentLegId and clear', () => {
  it('reads as unlinked before anything is cached, without a query', () => {
    const link = new PlannedLegLink();

    expect(link.status(KSBA.lat, KSBA.lon)).toBeNull();
    expect(link.refs()).toEqual({ destinationIdent: null, plannedLegId: null });
    expect(link.currentLegId()).toBeNull();
    for (const fn of Object.values(dbMock)) expect(fn).not.toHaveBeenCalled();
  });

  it('reports the cached leg and the progress along it, in a fixed key order, from the cache alone', () => {
    const link = new PlannedLegLink();
    seedCache(link, makePlannedLegWithChildren({
      id: 11, trip_id: TRIP, waypoints: NORTH_ROUTE, waypoint_count: 4, destination_ident: 'KEND',
    }));

    const beside1 = link.status(34.7, -119.79)!;
    const beside3 = link.status(36.5, -119.79)!;

    expect(Object.keys(beside1)).toEqual([
      'plannedLegId', 'tripId', 'tripName', 'destinationIdent',
      'nextWaypointIdent', 'remainingDistanceNm', 'distanceIsApproximate',
    ]);
    expect(beside1).toEqual({
      plannedLegId: 11,
      tripId: TRIP,
      tripName: 'Test Trip',
      destinationIdent: 'KEND',
      nextWaypointIdent: 'WPT1',
      remainingDistanceNm: Math.round((haversineNm(34.7, -119.79, 35.0, KSBA.lon) + chainFrom(NORTH_ROUTE, 1)) * 10) / 10,
      distanceIsApproximate: true,
    });
    expect(beside3.nextWaypointIdent).toBe('KEND');
    expect(beside3.remainingDistanceNm).toBe(Math.round(haversineNm(36.5, -119.79, 37.0, KSBA.lon) * 10) / 10);
    for (const fn of Object.values(dbMock)) expect(fn).not.toHaveBeenCalled();
  });

  it('rounds the remaining distance to a tenth', () => {
    const link = new PlannedLegLink();
    seedCache(link, makePlannedLegWithChildren({ id: 11, waypoints: NORTH_ROUTE, waypoint_count: 4 }));
    vi.mocked(haversineNm).mockReturnValueOnce(3.04);

    const status = link.status(34.7, -119.79)!;

    expect(status.remainingDistanceNm).toBe(Math.round((3.04 + chainFrom(NORTH_ROUTE, 1)) * 10) / 10);
  });

  it('lets a route with one waypoint throw through instead of swallowing it', () => {
    const link = new PlannedLegLink();
    seedCache(link, makePlannedLegWithChildren({ id: 11, waypoints: [NORTH_ROUTE[0]], waypoint_count: 1 }));

    expect(() => link.status(KSBA.lat, KSBA.lon)).toThrow(TypeError);
    expect(warned()).toEqual([]);
  });

  it('refs and currentLegId follow the cache', () => {
    const link = new PlannedLegLink();
    seedCache(link);

    expect(link.refs()).toEqual(SEEDED);
    expect(link.currentLegId()).toBe(99);
  });

  it('clear empties the cache, is safe to repeat, and leaves the link reusable', () => {
    const link = new PlannedLegLink();
    seedCache(link);

    link.clear();
    link.clear();

    expect(link.status(KSBA.lat, KSBA.lon)).toBeNull();
    expect(link.refs()).toEqual({ destinationIdent: null, plannedLegId: null });
    expect(link.currentLegId()).toBeNull();

    arrangeMatch();
    link.autoLink(FLIGHT, AT_KSBA, START);
    expect(link.currentLegId()).toBe(11);
  });

  it('exposes exactly the contract surface, and no way to notify', () => {
    expect(Object.getOwnPropertyNames(PlannedLegLink.prototype).sort()).toEqual([
      'autoLink', 'clear', 'constructor', 'currentLegId', 'matchForGround',
      'recordArrival', 'refreshForFlight', 'refs', 'status',
    ]);
  });
});

describe('FlightManager with the link', () => {
  const LANDED: Partial<SimFrame> = { onGround: true, groundSpeedKnots: 2, airspeedKnots: 0 };

  beforeEach(() => useFakeClock());
  afterEach(() => useRealClock());

  function takeoff(fm: FlightManager): void {
    for (let i = 0; i < 3; i++) fm.onFrame(makeFrame());
  }

  function land(fm: FlightManager): void {
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1000);
      fm.onFrame(makeFrame(LANDED));
    }
  }

  it('drops the link when the flight ends, so the status poll stops reporting its leg', () => {
    arrangeMatch(makePlannedLegWithChildren({ trip_id: TRIP, waypoints: NORTH_ROUTE, waypoint_count: 4 }));
    const fm = new FlightManager();

    takeoff(fm);
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).not.toBeNull();
    land(fm);

    expect(fm.appState.flightState).toBe('IDLE');
    expect(fm.getPlannedLegStatus(KSBA.lat, KSBA.lon)).toBeNull();
  });

  it('reports the linked leg while the flight is in the air', () => {
    arrangeMatch(makePlannedLegWithChildren({ trip_id: TRIP, waypoints: NORTH_ROUTE, waypoint_count: 4 }));
    const fm = new FlightManager();

    takeoff(fm);

    expect(fm.getFlightStatePayload()).toEqual({ flightState: 'FLYING', currentFlightId: 1, plannedLegId: 11 });
    expect(fm.getPlannedLegStatus(34.7, -119.79)).toMatchObject({ plannedLegId: 11, nextWaypointIdent: 'WPT1' });
  });

  it('tells the scope listener after a refresh for the current flight', () => {
    const fm = new FlightManager();
    const listener = vi.fn();
    takeoff(fm);
    fm.setScopeChangeListener(listener);
    dbMock.getFlightPlannedLegId.mockReturnValue(11);
    dbMock.getPlannedLegById.mockReturnValue(makePlannedLegWithChildren());

    fm.refreshPlannedLegForFlight(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(fm.getFlightStatePayload().plannedLegId).toBe(11);
  });

  it('tells the scope listener after a refresh for a flight that is not current, without a query', () => {
    const fm = new FlightManager();
    const listener = vi.fn();
    takeoff(fm);
    fm.setScopeChangeListener(listener);
    dbMock.getFlightPlannedLegId.mockClear();

    fm.refreshPlannedLegForFlight(2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(dbMock.getFlightPlannedLegId).not.toHaveBeenCalled();
    expect(dbMock.getPlannedLegById).not.toHaveBeenCalled();
  });

  it('tells the scope listener after a refresh when nobody is flying', () => {
    const fm = new FlightManager();
    const listener = vi.fn();
    fm.setScopeChangeListener(listener);

    fm.refreshPlannedLegForFlight(1);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tells the listener nothing when the refresh throws', () => {
    const err = new Error('disk I/O error');
    const fm = new FlightManager();
    const listener = vi.fn();
    takeoff(fm);
    fm.setScopeChangeListener(listener);
    dbMock.getFlightPlannedLegId.mockImplementation(() => { throw err; });

    expect(() => fm.refreshPlannedLegForFlight(1)).toThrow(err);

    expect(listener).not.toHaveBeenCalled();
  });
});
