// tests/db/plannedLegs.test.ts — src/db/plannedLegs.ts against a real
// temp-file scratch database (tests/helpers/db.ts), one fresh database per
// test. Never mixed with vi.mock('../src/db') in this file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createScratchDb, destroyScratchDb, seedTrip, seedFlight, seedPlannedLeg, seedAcarsMessage, type ScratchDb,
} from '../helpers/db';
import { KSBA, KMRY, T0 } from '../helpers/index';
import {
  createPlannedLeg, getPlannedLegsForTrip, getPlannedLegById, findPlannedLegBySource, getAllPlannedLegs,
  deletePlannedLeg, reorderPlannedLegs,
  setActiveTrip, getActiveTripId,
  setPlannedLegStatus, PlannedLegHasLinkedFlightError,
  movePlannedLeg, PlannedLegMoveError,
  getPlannedLegCandidatesForActiveTrip,
  getFlightPlannedLegId, linkFlightToPlannedLeg, PlannedLegAlreadyLinkedError,
  unlinkFlightFromPlannedLeg, clearPlannedLegLink,
  recordPlannedLegArrival, setPlannedLegHandOutcome, PlannedLegHandCloseConflictError,
  type CreatePlannedLegInput, type CreatePlannedLegPlan,
} from '../../src/db/plannedLegs';

function makePlan(over: Partial<CreatePlannedLegPlan> = {}): CreatePlannedLegPlan {
  return {
    departure: { ident: 'KSBA', name: 'Santa Barbara Muni', lat: KSBA.lat, lon: KSBA.lon, isAirport: true },
    destination: { ident: 'KMRY', name: 'Monterey Rgnl', lat: KMRY.lat, lon: KMRY.lon, isAirport: true },
    isSnippet: false,
    cruiseAltFt: 8000,
    flightplanType: 'IFR',
    aircraftType: 'C172',
    remarks: null,
    createdAt: T0,
    sourceProgram: 'Little Navmap',
    departureStart: { pos: null, start: null, startType: null },
    procedures: {
      sidName: null, sidRunway: null, sidTransition: null, sidType: null, sidCustomDistanceNm: null,
      starName: null, starRunway: null, starTransition: null,
      approachName: null, approachRunway: null, approachTransition: null, approachType: null,
      approachArinc: null, approachSuffix: null, approachTransitionType: null,
      approachCustomDistanceNm: null, approachCustomAltitudeFt: null, approachCustomOffsetDeg: null,
    },
    waypoints: [
      { seq: 1, ident: 'KSBA', name: null, region: null, airway: null, track: null, type: 'AIRPORT', comment: null, lat: KSBA.lat, lon: KSBA.lon, altFt: null },
      { seq: 2, ident: 'KMRY', name: null, region: null, airway: null, track: null, type: 'AIRPORT', comment: null, lat: KMRY.lat, lon: KMRY.lon, altFt: null },
    ],
    alternates: [],
    approxDistanceNm: 162.5,
    ...over,
  };
}

function makeInput(tripId: number | null, over: Partial<CreatePlannedLegInput> = {}): CreatePlannedLegInput {
  return {
    tripId,
    plan: makePlan(),
    sourceFilename: 'VFR Santa Barbara Muni (KSBA) to Monterey Rgnl (KMRY).lnmpln',
    sourceSha256: '1'.repeat(64),
    ...over,
  };
}

let scratch: ScratchDb;

beforeEach(() => { scratch = createScratchDb(); });
afterEach(() => { destroyScratchDb(scratch); });

describe('createPlannedLeg()', () => {
  it('inserts a leg with its waypoints and alternates, seq starting at 1', () => {
    const tripId = seedTrip(scratch.db);
    const legId = createPlannedLeg(makeInput(tripId));

    const leg = getPlannedLegById(legId);
    expect(leg).not.toBeNull();
    expect(leg!.trip_id).toBe(tripId);
    expect(leg!.seq).toBe(1);
    expect(leg!.status).toBe('planned');
    expect(leg!.departure_ident).toBe('KSBA');
    expect(leg!.destination_ident).toBe('KMRY');
    expect(leg!.waypoint_count).toBe(2);
    expect(leg!.alternate_count).toBe(0);
    expect(leg!.waypoints).toHaveLength(2);
    expect(leg!.waypoints[0].ident).toBe('KSBA');
    expect(leg!.waypoints[1].ident).toBe('KMRY');
    expect(leg!.alternates).toHaveLength(0);
  });

  it('assigns seq = MAX(seq)+1 for the trip, so a second leg follows the first', () => {
    const tripId = seedTrip(scratch.db);
    const legId1 = createPlannedLeg(makeInput(tripId, { sourceSha256: 'a'.repeat(64) }));
    const legId2 = createPlannedLeg(makeInput(tripId, { sourceSha256: 'b'.repeat(64) }));

    const leg1 = getPlannedLegById(legId1)!;
    const leg2 = getPlannedLegById(legId2)!;
    expect(leg1.seq).toBe(1);
    expect(leg2.seq).toBe(2);
  });

  it('stores alternates when the plan carries them', () => {
    const tripId = seedTrip(scratch.db);
    const legId = createPlannedLeg(makeInput(tripId, {
      plan: makePlan({
        alternates: [
          { seq: 1, ident: 'KSMX', name: 'Santa Maria', type: 'AIRPORT', lat: 34.9, lon: -120.45, altFt: null },
        ],
      }),
    }));

    const leg = getPlannedLegById(legId)!;
    expect(leg.alternate_count).toBe(1);
    expect(leg.alternates[0].ident).toBe('KSMX');
  });

  it('assigns seq 1, 2 to two loose legs (tripId null), independently of a trip\'s own numbering', () => {
    const tripId = seedTrip(scratch.db);
    const tripLegId = createPlannedLeg(makeInput(tripId, { sourceSha256: 'e'.repeat(64) }));

    const looseId1 = createPlannedLeg(makeInput(null, { sourceSha256: 'f'.repeat(64) }));
    const looseId2 = createPlannedLeg(makeInput(null, { sourceSha256: 'g'.repeat(64) }));

    const loose1 = getPlannedLegById(looseId1)!;
    const loose2 = getPlannedLegById(looseId2)!;
    expect(loose1.trip_id).toBeNull();
    expect(loose2.trip_id).toBeNull();
    expect(loose1.seq).toBe(1);
    expect(loose2.seq).toBe(2);

    // The trip's own leg, seeded before either loose leg, is unaffected.
    expect(getPlannedLegById(tripLegId)!.seq).toBe(1);
  });

  it('rolls back the whole leg when a child insert fails, leaving no orphan rows', () => {
    const tripId = seedTrip(scratch.db);
    // A NOT NULL violation on planned_waypoints.type (schema requires TEXT NOT NULL).
    const badInput = makeInput(tripId, {
      plan: makePlan({
        waypoints: [
          { seq: 1, ident: 'KSBA', name: null, region: null, airway: null, track: null, type: null as unknown as string, comment: null, lat: KSBA.lat, lon: KSBA.lon, altFt: null },
        ],
      }),
    });

    expect(() => createPlannedLeg(badInput)).toThrow();

    const legs = getPlannedLegsForTrip(tripId);
    expect(legs).toHaveLength(0);
    const waypointCount = (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_waypoints').get() as { n: number }).n;
    expect(waypointCount).toBe(0);
  });
});

describe('getPlannedLegsForTrip() / getPlannedLegById()', () => {
  it('returns legs ordered by seq ASC, id ASC, scoped to the trip', () => {
    const tripA = seedTrip(scratch.db, { name: 'Trip A' });
    const tripB = seedTrip(scratch.db, { name: 'Trip B' });
    seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 2, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'b'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'c'.repeat(64) });

    const legs = getPlannedLegsForTrip(tripA);
    expect(legs).toHaveLength(2);
    expect(legs.map(l => l.seq)).toEqual([1, 2]);
    expect(legs.every(l => l.trip_id === tripA)).toBe(true);
  });

  it('getPlannedLegById() returns null for a missing id', () => {
    expect(getPlannedLegById(999)).toBeNull();
  });

  it('reports linked_flight_id when a flight points at the leg', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });

    const leg = getPlannedLegById(legId)!;
    expect(leg.linked_flight_id).toBe(flightId);

    const legs = getPlannedLegsForTrip(tripId);
    expect(legs[0].linked_flight_id).toBe(flightId);
  });
});

describe('findPlannedLegBySource()', () => {
  it('finds the existing leg by (trip_id, source_sha256) — the import re-run dedup path', () => {
    const tripId = seedTrip(scratch.db);
    const sha = 'deadbeef'.repeat(8);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: sha });

    const found = findPlannedLegBySource(tripId, sha);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(legId);
  });

  it('returns null when the sha does not match any leg of that trip', () => {
    const tripId = seedTrip(scratch.db);
    seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: 'aa'.repeat(32) });

    expect(findPlannedLegBySource(tripId, 'bb'.repeat(32))).toBeNull();
  });

  it('scopes by trip: the same sha under a different trip is not found', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const sha = 'cc'.repeat(32);
    seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: sha });

    expect(findPlannedLegBySource(tripB, sha)).toBeNull();
  });

  it('treats "no trip" as its own pool: two loose legs sharing a sha are duplicates of each other', () => {
    const sha = 'dd'.repeat(32);
    const looseLegId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: sha });

    const found = findPlannedLegBySource(null, sha);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(looseLegId);
  });

  it('a loose leg is NOT a duplicate of a trip-linked leg sharing the same sha256, and vice versa', () => {
    const tripId = seedTrip(scratch.db);
    const sha = 'ee'.repeat(32);
    const tripLegId = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: sha });
    const looseLegId = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: sha });

    expect(findPlannedLegBySource(tripId, sha)!.id).toBe(tripLegId);
    expect(findPlannedLegBySource(null, sha)!.id).toBe(looseLegId);
    expect(findPlannedLegBySource(tripId, sha)!.id).not.toBe(looseLegId);
    expect(findPlannedLegBySource(null, sha)!.id).not.toBe(tripLegId);
  });
});

describe('getAllPlannedLegs()', () => {
  it('returns [] when there are no planned legs at all', () => {
    expect(getAllPlannedLegs()).toEqual([]);
  });

  it('returns both a loose leg and a trip-linked leg, with trip_name resolved and null for the loose one', () => {
    const tripId = seedTrip(scratch.db, { name: 'Pacific hop' });
    const tripLegId = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 1, source_sha256: 'a'.repeat(64) });
    const looseLegId = seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'b'.repeat(64) });

    const all = getAllPlannedLegs();
    expect(all.map(l => l.id).sort((a, b) => a - b)).toEqual([tripLegId, looseLegId].sort((a, b) => a - b));

    const loose = all.find(l => l.id === looseLegId)!;
    expect(loose.trip_id).toBeNull();
    expect(loose.trip_name).toBeNull();
    expect(loose.waypoints).toEqual([]);
    expect(loose.alternates).toEqual([]);

    const linked = all.find(l => l.id === tripLegId)!;
    expect(linked.trip_id).toBe(tripId);
    expect(linked.trip_name).toBe('Pacific hop');
  });

  it('orders loose legs first, then trip-linked legs by (trip_id, seq, id)', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const looseId = seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'a'.repeat(64) });
    const tripALeg2 = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 2, source_sha256: 'b'.repeat(64) });
    const tripALeg1 = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'c'.repeat(64) });
    const tripBLeg1 = seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'd'.repeat(64) });

    const all = getAllPlannedLegs();
    expect(all.map(l => l.id)).toEqual([looseId, tripALeg1, tripALeg2, tripBLeg1]);
  });
});

describe('deletePlannedLeg()', () => {
  it('returns false for a missing leg', () => {
    expect(deletePlannedLeg(999)).toBe(false);
  });

  it('deletes the leg and cascades its waypoints/alternates', () => {
    const tripId = seedTrip(scratch.db);
    const legId = createPlannedLeg(makeInput(tripId));

    expect(deletePlannedLeg(legId)).toBe(true);

    expect(getPlannedLegById(legId)).toBeNull();
    const waypointCount = (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_waypoints WHERE planned_leg_id = ?').get(legId) as { n: number }).n;
    expect(waypointCount).toBe(0);
  });

  it('unlinks a linked flight and restores its prior trip_id, since ON DELETE SET NULL alone cannot', () => {
    const priorTrip = seedTrip(scratch.db, { name: 'Prior trip' });
    const legTrip = seedTrip(scratch.db, { name: 'Leg trip' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: legTrip });
    const flightId = seedFlight(scratch.db, {
      trip_id: legTrip,
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
      planned_leg_prev_trip_id: priorTrip,
    });

    expect(deletePlannedLeg(legId)).toBe(true);

    const flight = scratch.db.prepare('SELECT trip_id, planned_leg_id, planned_leg_link_source, planned_leg_prev_trip_id FROM flights WHERE id = ?').get(flightId) as {
      trip_id: number | null; planned_leg_id: number | null; planned_leg_link_source: string | null; planned_leg_prev_trip_id: number | null;
    };
    expect(flight.trip_id).toBe(priorTrip);
    expect(flight.planned_leg_id).toBeNull();
    expect(flight.planned_leg_link_source).toBeNull();
    expect(flight.planned_leg_prev_trip_id).toBeNull();
  });
});

describe('reorderPlannedLegs()', () => {
  it('renumbers seq 1..N to match the given permutation, staying dense and ordered', () => {
    const tripId = seedTrip(scratch.db);
    const leg1 = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 1, source_sha256: 'a'.repeat(64) });
    const leg2 = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 2, source_sha256: 'b'.repeat(64) });
    const leg3 = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 3, source_sha256: 'c'.repeat(64) });

    expect(reorderPlannedLegs(tripId, [leg3, leg1, leg2])).toBe(true);

    const legs = getPlannedLegsForTrip(tripId);
    expect(legs.map(l => l.id)).toEqual([leg3, leg1, leg2]);
    expect(legs.map(l => l.seq)).toEqual([1, 2, 3]);
  });

  it('only touches legs of the given trip_id, even if a foreign id were passed', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legA = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'a'.repeat(64) });
    const legB = seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'b'.repeat(64) });

    reorderPlannedLegs(tripA, [legB]);

    const untouched = getPlannedLegById(legB)!;
    expect(untouched.seq).toBe(1);
    const stillA = getPlannedLegById(legA)!;
    expect(stillA.seq).toBe(1);
  });
});

describe('setActiveTrip() / getActiveTripId()', () => {
  it('returns null when no trip is active', () => {
    expect(getActiveTripId()).toBeNull();
  });

  it('sets a trip active', () => {
    const tripId = seedTrip(scratch.db);
    setActiveTrip(tripId);
    expect(getActiveTripId()).toBe(tripId);
  });

  it('activating a second trip deactivates the first, so idx_trips_active never sees two active rows', () => {
    const trip1 = seedTrip(scratch.db);
    const trip2 = seedTrip(scratch.db);
    setActiveTrip(trip1);
    expect(getActiveTripId()).toBe(trip1);

    setActiveTrip(trip2);

    expect(getActiveTripId()).toBe(trip2);
    const activeCount = (scratch.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE is_active = 1').get() as { n: number }).n;
    expect(activeCount).toBe(1);
  });

  it('setActiveTrip(null) clears the active trip', () => {
    const tripId = seedTrip(scratch.db);
    setActiveTrip(tripId);
    setActiveTrip(null);
    expect(getActiveTripId()).toBeNull();
  });

  it('setting a trip that does not exist changes nothing', () => {
    const tripId = seedTrip(scratch.db);
    setActiveTrip(tripId);

    setActiveTrip(999);

    expect(getActiveTripId()).toBe(tripId);
  });
});

describe('setPlannedLegStatus()', () => {
  it('returns false for a missing leg', () => {
    expect(setPlannedLegStatus(999, 'skipped')).toBe(false);
  });

  it('sets status to skipped and clears arrival_deviation_nm on an unlinked leg', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    scratch.db.prepare('UPDATE planned_legs SET arrival_deviation_nm = 12.5 WHERE id = ?').run(legId);

    expect(setPlannedLegStatus(legId, 'skipped')).toBe(true);

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('skipped');
    expect(leg.arrival_deviation_nm).toBeNull();
  });

  it('sets status back to planned', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, status: 'skipped' });

    expect(setPlannedLegStatus(legId, 'planned')).toBe(true);
    expect(getPlannedLegById(legId)!.status).toBe('planned');
  });

  it('throws PlannedLegHasLinkedFlightError when the leg still has a linked flight', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });

    expect(() => setPlannedLegStatus(legId, 'skipped')).toThrow(PlannedLegHasLinkedFlightError);
    try {
      setPlannedLegStatus(legId, 'skipped');
    } catch (err) {
      expect(err).toBeInstanceOf(PlannedLegHasLinkedFlightError);
      expect((err as PlannedLegHasLinkedFlightError).legId).toBe(legId);
      expect((err as PlannedLegHasLinkedFlightError).flightId).toBe(flightId);
    }
    // The status must not have changed despite the throw.
    expect(getPlannedLegById(legId)!.status).toBe('planned');
  });
});

describe('movePlannedLeg()', () => {
  it('returns false for a missing leg, nothing written', () => {
    expect(movePlannedLeg(999, null)).toBe(false);
  });

  it('moves trip A -> trip B, landing at the end of B\'s pool; A\'s remaining legs keep their seqs', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legToMove = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'a'.repeat(64) });
    const legStaysA = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 2, source_sha256: 'b'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 1, source_sha256: 'c'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 2, source_sha256: 'd'.repeat(64) });

    expect(movePlannedLeg(legToMove, tripB)).toBe(true);

    const moved = getPlannedLegById(legToMove)!;
    expect(moved.trip_id).toBe(tripB);
    expect(moved.seq).toBe(3);
    // A's other leg is left exactly where it was — a gap, not a renumber.
    expect(getPlannedLegById(legStaysA)!.seq).toBe(2);
  });

  it('moves trip -> loose at loose MAX(seq)+1', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 1, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'b'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: null, seq: 2, source_sha256: 'c'.repeat(64) });

    expect(movePlannedLeg(legId, null)).toBe(true);

    const moved = getPlannedLegById(legId)!;
    expect(moved.trip_id).toBeNull();
    expect(moved.seq).toBe(3);
  });

  it('moves loose -> trip at the trip\'s MAX(seq)+1', () => {
    const tripId = seedTrip(scratch.db);
    seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 1, source_sha256: 'a'.repeat(64) });
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'b'.repeat(64) });

    expect(movePlannedLeg(legId, tripId)).toBe(true);

    const moved = getPlannedLegById(legId)!;
    expect(moved.trip_id).toBe(tripId);
    expect(moved.seq).toBe(2);
  });

  it('moving into an empty trip lands at seq 1', () => {
    const emptyTrip = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, seq: 1, source_sha256: 'a'.repeat(64) });

    expect(movePlannedLeg(legId, emptyTrip)).toBe(true);
    expect(getPlannedLegById(legId)!.seq).toBe(1);
  });

  it('a skipped leg moves and stays skipped', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, status: 'skipped', source_sha256: 'a'.repeat(64) });

    expect(movePlannedLeg(legId, tripB)).toBe(true);
    expect(getPlannedLegById(legId)!.status).toBe('skipped');
  });

  it('throws LINKED_FLIGHT for a leg with a linked flight, row unchanged', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'a'.repeat(64) });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });

    try {
      movePlannedLeg(legId, tripB);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlannedLegMoveError);
      expect((err as PlannedLegMoveError).code).toBe('LINKED_FLIGHT');
      expect((err as PlannedLegMoveError).flightId).toBe(flightId);
    }
    const leg = getPlannedLegById(legId)!;
    expect(leg.trip_id).toBe(tripA);
    expect(leg.seq).toBe(1);
  });

  it.each(['flown', 'diverted'] as const)('throws NOT_MOVABLE_STATUS for an unlinked %s leg', (status) => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, status, source_sha256: 'a'.repeat(64) });

    try {
      movePlannedLeg(legId, tripB);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlannedLegMoveError);
      expect((err as PlannedLegMoveError).code).toBe('NOT_MOVABLE_STATUS');
    }
  });

  it('throws SAME_POOL for trip -> same trip, and loose -> loose', () => {
    const tripId = seedTrip(scratch.db);
    const tripLeg = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: 'a'.repeat(64) });
    const looseLeg = seedPlannedLeg(scratch.db, { trip_id: null, source_sha256: 'b'.repeat(64) });

    expect(() => movePlannedLeg(tripLeg, tripId)).toThrow(PlannedLegMoveError);
    expect(() => movePlannedLeg(looseLeg, null)).toThrow(PlannedLegMoveError);
    try {
      movePlannedLeg(tripLeg, tripId);
    } catch (err) {
      expect((err as PlannedLegMoveError).code).toBe('SAME_POOL');
    }
  });

  it('SAME_POOL wins over LINKED_FLIGHT for a linked leg asked to move to its own pool', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, source_sha256: 'a'.repeat(64) });
    seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });

    try {
      movePlannedLeg(legId, tripId);
      expect.unreachable();
    } catch (err) {
      expect((err as PlannedLegMoveError).code).toBe('SAME_POOL');
    }
  });

  it('throws DUPLICATE_IN_TARGET when the target trip already holds the same sha, exact message', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const sha = 'ab'.repeat(32);
    const legToMove = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: sha });
    seedPlannedLeg(scratch.db, { trip_id: tripB, seq: 5, source_sha256: sha });

    try {
      movePlannedLeg(legToMove, tripB);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PlannedLegMoveError);
      const moveErr = err as PlannedLegMoveError;
      expect(moveErr.code).toBe('DUPLICATE_IN_TARGET');
      expect(moveErr.existingSeq).toBe(5);
      expect(moveErr.message).toBe(
        `Planned leg ${legToMove} cannot be moved: the target trip already holds the same plan as leg 5`,
      );
    }
  });

  it('DUPLICATE_IN_TARGET into the loose pool uses the loose-legs message', () => {
    const tripA = seedTrip(scratch.db);
    const sha = 'cd'.repeat(32);
    const legToMove = seedPlannedLeg(scratch.db, { trip_id: tripA, source_sha256: sha });
    seedPlannedLeg(scratch.db, { trip_id: null, seq: 7, source_sha256: sha });

    try {
      movePlannedLeg(legToMove, null);
      expect.unreachable();
    } catch (err) {
      const moveErr = err as PlannedLegMoveError;
      expect(moveErr.code).toBe('DUPLICATE_IN_TARGET');
      expect(moveErr.message).toBe(
        `Planned leg ${legToMove} cannot be moved: the loose legs already hold the same plan as leg 7`,
      );
    }
  });

  it('a same-sha sibling left behind in the SOURCE pool never blocks the move', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const sha = 'ef'.repeat(32);
    const legToMove = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: sha });
    seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 2, source_sha256: sha });

    expect(movePlannedLeg(legToMove, tripB)).toBe(true);
    expect(getPlannedLegById(legToMove)!.trip_id).toBe(tripB);
  });

  it('throws TRIP_NOT_FOUND for a missing target trip, row unchanged', () => {
    const tripA = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripA, seq: 1, source_sha256: 'a'.repeat(64) });

    try {
      movePlannedLeg(legId, 999999);
      expect.unreachable();
    } catch (err) {
      expect((err as PlannedLegMoveError).code).toBe('TRIP_NOT_FOUND');
    }
    const leg = getPlannedLegById(legId)!;
    expect(leg.trip_id).toBe(tripA);
    expect(leg.seq).toBe(1);
  });

  it('leaves waypoint/alternate/acars row counts for the leg identical before and after', () => {
    const tripA = seedTrip(scratch.db);
    const tripB = seedTrip(scratch.db);
    const legId = createPlannedLeg(makeInput(tripA));
    seedAcarsMessage(scratch.db, { planned_leg_id: legId });

    const countBefore = {
      wp: (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_waypoints WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
      alt: (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_alternates WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
      acars: (scratch.db.prepare('SELECT COUNT(*) AS n FROM acars_messages WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
    };

    expect(movePlannedLeg(legId, tripB)).toBe(true);

    const countAfter = {
      wp: (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_waypoints WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
      alt: (scratch.db.prepare('SELECT COUNT(*) AS n FROM planned_alternates WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
      acars: (scratch.db.prepare('SELECT COUNT(*) AS n FROM acars_messages WHERE planned_leg_id = ?').get(legId) as { n: number }).n,
    };
    expect(countAfter).toEqual(countBefore);
    expect(countBefore.wp).toBe(2);
  });
});

describe('getPlannedLegCandidatesForActiveTrip()', () => {
  it('returns [] when no trip is active', () => {
    const tripId = seedTrip(scratch.db);
    seedPlannedLeg(scratch.db, { trip_id: tripId });

    expect(getPlannedLegCandidatesForActiveTrip()).toEqual([]);
  });

  it('scopes candidates to the active trip only', () => {
    const activeTrip = seedTrip(scratch.db, { is_active: 1 });
    const otherTrip = seedTrip(scratch.db);
    const activeLeg = seedPlannedLeg(scratch.db, { trip_id: activeTrip, source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: otherTrip, source_sha256: 'b'.repeat(64) });

    const candidates = getPlannedLegCandidatesForActiveTrip();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].plannedLegId).toBe(activeLeg);
    expect(candidates[0].tripId).toBe(activeTrip);
  });

  it('includes legs of every status — filtering is the matcher\'s job, not this query\'s', () => {
    const activeTrip = seedTrip(scratch.db, { is_active: 1 });
    seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 1, status: 'planned', source_sha256: 'a'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 2, status: 'flown', source_sha256: 'b'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 3, status: 'skipped', source_sha256: 'c'.repeat(64) });
    seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 4, status: 'diverted', source_sha256: 'd'.repeat(64) });

    const candidates = getPlannedLegCandidatesForActiveTrip();
    expect(candidates.map(c => c.status)).toEqual(['planned', 'flown', 'skipped', 'diverted']);
  });

  it('flattens departureIdent to null when departure_is_airport is false', () => {
    const activeTrip = seedTrip(scratch.db, { is_active: 1 });
    seedPlannedLeg(scratch.db, { trip_id: activeTrip, departure_ident: 'WPT1', departure_is_airport: 0 });

    const candidates = getPlannedLegCandidatesForActiveTrip();
    expect(candidates[0].departureIdent).toBeNull();
    expect(candidates[0].departureIsAirport).toBe(false);
  });

  it('orders candidates by seq ASC, id ASC, and reports linkedFlightId', () => {
    const activeTrip = seedTrip(scratch.db, { is_active: 1 });
    const leg2 = seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 2, source_sha256: 'a'.repeat(64) });
    const leg1 = seedPlannedLeg(scratch.db, { trip_id: activeTrip, seq: 1, source_sha256: 'b'.repeat(64) });
    const flightId = seedFlight(scratch.db, { planned_leg_id: leg1, planned_leg_link_source: 'manual' });

    const candidates = getPlannedLegCandidatesForActiveTrip();
    expect(candidates.map(c => c.plannedLegId)).toEqual([leg1, leg2]);
    expect(candidates[0].linkedFlightId).toBe(flightId);
    expect(candidates[1].linkedFlightId).toBeNull();
  });
});

describe('getFlightPlannedLegId() / linkFlightToPlannedLeg() / unlinkFlightFromPlannedLeg() / clearPlannedLegLink()', () => {
  it('getFlightPlannedLegId() returns null for an unlinked flight and for a missing flight', () => {
    const flightId = seedFlight(scratch.db);
    expect(getFlightPlannedLegId(flightId)).toBeNull();
    expect(getFlightPlannedLegId(999)).toBeNull();
  });

  it('links a flight to a leg, moving the flight into the leg\'s trip and capturing its prior trip_id', () => {
    const priorTrip = seedTrip(scratch.db, { name: 'Prior' });
    const legTrip = seedTrip(scratch.db, { name: 'Leg trip' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: legTrip });
    const flightId = seedFlight(scratch.db, { trip_id: priorTrip });

    linkFlightToPlannedLeg(flightId, legId, 'manual');

    expect(getFlightPlannedLegId(flightId)).toBe(legId);
    const flight = scratch.db.prepare('SELECT trip_id, planned_leg_link_source, planned_leg_prev_trip_id FROM flights WHERE id = ?').get(flightId) as {
      trip_id: number; planned_leg_link_source: string; planned_leg_prev_trip_id: number | null;
    };
    expect(flight.trip_id).toBe(legTrip);
    expect(flight.planned_leg_link_source).toBe('manual');
    expect(flight.planned_leg_prev_trip_id).toBe(priorTrip);
  });

  it('throws PlannedLegAlreadyLinkedError when the target leg already belongs to a different flight', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flight1 = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'manual' });
    const flight2 = seedFlight(scratch.db);

    expect(() => linkFlightToPlannedLeg(flight2, legId, 'manual')).toThrow(PlannedLegAlreadyLinkedError);
    try {
      linkFlightToPlannedLeg(flight2, legId, 'manual');
    } catch (err) {
      expect(err).toBeInstanceOf(PlannedLegAlreadyLinkedError);
      expect((err as PlannedLegAlreadyLinkedError).legId).toBe(legId);
      expect((err as PlannedLegAlreadyLinkedError).flightId).toBe(flight1);
    }
  });

  it('the idx_flights_planned_leg partial UNIQUE index itself refuses a second flight linked at the SQL level', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    seedFlight(scratch.db, { planned_leg_id: legId });

    expect(() => seedFlight(scratch.db, { planned_leg_id: legId })).toThrow(/UNIQUE constraint failed/);
  });

  it('re-linking a flight to the same leg it already holds is a no-op, source included', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'auto' });

    linkFlightToPlannedLeg(flightId, legId, 'manual');

    const flight = scratch.db.prepare('SELECT planned_leg_link_source FROM flights WHERE id = ?').get(flightId) as { planned_leg_link_source: string };
    expect(flight.planned_leg_link_source).toBe('auto');
  });

  it('re-targeting an already-linked flight to a different leg unlinks the old one first', () => {
    const tripId = seedTrip(scratch.db);
    const legOld = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 1, source_sha256: 'a'.repeat(64) });
    const legNew = seedPlannedLeg(scratch.db, { trip_id: tripId, seq: 2, source_sha256: 'b'.repeat(64) });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legOld, planned_leg_link_source: 'manual' });

    linkFlightToPlannedLeg(flightId, legNew, 'auto');

    expect(getFlightPlannedLegId(flightId)).toBe(legNew);
    const oldLeg = getPlannedLegById(legOld)!;
    expect(oldLeg.status).toBe('planned');
    expect(oldLeg.linked_flight_id).toBeNull();
  });

  it('throws when the flight does not exist', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    expect(() => linkFlightToPlannedLeg(999, legId, 'manual')).toThrow();
  });

  it('throws when the leg does not exist', () => {
    const flightId = seedFlight(scratch.db);
    expect(() => linkFlightToPlannedLeg(flightId, 999, 'manual')).toThrow();
  });

  it('unlinkFlightFromPlannedLeg() restores trip_id, clears the link, and resets the leg to planned', () => {
    const priorTrip = seedTrip(scratch.db, { name: 'Prior' });
    const legTrip = seedTrip(scratch.db, { name: 'Leg trip' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: legTrip, status: 'flown' });
    scratch.db.prepare('UPDATE planned_legs SET arrival_deviation_nm = 3.2 WHERE id = ?').run(legId);
    const flightId = seedFlight(scratch.db, {
      trip_id: legTrip,
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
      planned_leg_prev_trip_id: priorTrip,
    });

    expect(unlinkFlightFromPlannedLeg(flightId)).toBe(true);

    const flight = scratch.db.prepare('SELECT trip_id, planned_leg_id, planned_leg_link_source, planned_leg_prev_trip_id FROM flights WHERE id = ?').get(flightId) as {
      trip_id: number | null; planned_leg_id: number | null; planned_leg_link_source: string | null; planned_leg_prev_trip_id: number | null;
    };
    expect(flight.trip_id).toBe(priorTrip);
    expect(flight.planned_leg_id).toBeNull();
    expect(flight.planned_leg_link_source).toBeNull();
    expect(flight.planned_leg_prev_trip_id).toBeNull();

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('planned');
    expect(leg.arrival_deviation_nm).toBeNull();
  });

  it('unlinkFlightFromPlannedLeg() returns false when the flight has no link', () => {
    const flightId = seedFlight(scratch.db);
    expect(unlinkFlightFromPlannedLeg(flightId)).toBe(false);
  });

  it('clearPlannedLegLink() clears the link WITHOUT restoring trip_id', () => {
    const priorTrip = seedTrip(scratch.db, { name: 'Prior' });
    const legTrip = seedTrip(scratch.db, { name: 'Leg trip' });
    const legId = seedPlannedLeg(scratch.db, { trip_id: legTrip, status: 'flown' });
    const flightId = seedFlight(scratch.db, {
      trip_id: legTrip,
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
      planned_leg_prev_trip_id: priorTrip,
    });

    clearPlannedLegLink(flightId);

    const flight = scratch.db.prepare('SELECT trip_id, planned_leg_id, planned_leg_link_source, planned_leg_prev_trip_id FROM flights WHERE id = ?').get(flightId) as {
      trip_id: number | null; planned_leg_id: number | null; planned_leg_link_source: string | null; planned_leg_prev_trip_id: number | null;
    };
    expect(flight.trip_id).toBe(legTrip);
    expect(flight.planned_leg_id).toBeNull();
    expect(flight.planned_leg_link_source).toBeNull();
    expect(flight.planned_leg_prev_trip_id).toBeNull();

    expect(getPlannedLegById(legId)!.status).toBe('planned');
  });

  it('clearPlannedLegLink() is a no-op when the flight has no link', () => {
    const flightId = seedFlight(scratch.db);
    expect(() => clearPlannedLegLink(flightId)).not.toThrow();
    expect(getFlightPlannedLegId(flightId)).toBeNull();
  });
});

describe('recordPlannedLegArrival()', () => {
  it('writes status and arrival_deviation_nm on the flown path', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });

    recordPlannedLegArrival(legId, 'flown', 0.8);

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('flown');
    expect(leg.arrival_deviation_nm).toBe(0.8);
  });

  it('writes status and arrival_deviation_nm on the diverted path, keeping the link', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    const flightId = seedFlight(scratch.db, { planned_leg_id: legId, planned_leg_link_source: 'auto' });

    recordPlannedLegArrival(legId, 'diverted', 47.3);

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('diverted');
    expect(leg.arrival_deviation_nm).toBe(47.3);
    expect(leg.linked_flight_id).toBe(flightId);
  });
});

describe('setPlannedLegHandOutcome()', () => {
  function seedManualEndedLink(status: 'planned' | 'flown' = 'planned') {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId, status });
    const flightId = seedFlight(scratch.db, {
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
      end_time: '2026-09-09T13:00:00.000Z',
    });
    return { legId, flightId };
  }

  it('returns false for a missing leg', () => {
    expect(setPlannedLegHandOutcome(999, 'flown', 1.2)).toBe(false);
  });

  it('writes status flown and the deviation, leaving the link untouched', () => {
    const { legId, flightId } = seedManualEndedLink('planned');

    expect(setPlannedLegHandOutcome(legId, 'flown', 2.4)).toBe(true);

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('flown');
    expect(leg.arrival_deviation_nm).toBe(2.4);
    expect(leg.linked_flight_id).toBe(flightId);
    expect(getFlightPlannedLegId(flightId)).toBe(legId);
  });

  it('writes status back to planned (the reverse transition), clearing the deviation when null is passed', () => {
    const { legId } = seedManualEndedLink('flown');
    scratch.db.prepare('UPDATE planned_legs SET arrival_deviation_nm = 5.0 WHERE id = ?').run(legId);

    expect(setPlannedLegHandOutcome(legId, 'planned', null)).toBe(true);

    const leg = getPlannedLegById(legId)!;
    expect(leg.status).toBe('planned');
    expect(leg.arrival_deviation_nm).toBeNull();
  });

  it('throws PlannedLegHandCloseConflictError when the leg has no linked flight', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });

    expect(() => setPlannedLegHandOutcome(legId, 'flown', 1)).toThrow(PlannedLegHandCloseConflictError);
  });

  it('throws PlannedLegHandCloseConflictError when the flight was linked automatically, not by hand', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    seedFlight(scratch.db, {
      planned_leg_id: legId,
      planned_leg_link_source: 'auto',
      end_time: '2026-09-09T13:00:00.000Z',
    });

    expect(() => setPlannedLegHandOutcome(legId, 'flown', 1)).toThrow(PlannedLegHandCloseConflictError);
  });

  it('throws PlannedLegHandCloseConflictError when the linked flight has not ended', () => {
    const tripId = seedTrip(scratch.db);
    const legId = seedPlannedLeg(scratch.db, { trip_id: tripId });
    seedFlight(scratch.db, {
      planned_leg_id: legId,
      planned_leg_link_source: 'manual',
      end_time: null,
    });

    expect(() => setPlannedLegHandOutcome(legId, 'flown', 1)).toThrow(PlannedLegHandCloseConflictError);
  });
});
