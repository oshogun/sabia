import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyNavdataSchema } from '../src/navdata/schema';
import { legKey, procKey, transKey, wptKey } from '../src/navdata/keys';
import {
  AIRWAY_ENDPOINT_SQL, AIRWAY_MAX_HOPS, AIRWAY_MAX_VISITED, buildRouteGeometry,
} from '../src/navdata/routeGeometry';
import { RUNWAY_HEADING_REFERENCE, dest, runwayTrueBearing } from '../src/navdata/geometry';
import { bearingDeg, haversineNm } from '../src/geo';
import { makePlannedLegWithChildren } from './helpers';
import type { PlannedLegWithChildren, PlannedWaypoint } from '../src/types';
import { resolvePlannedKey } from '../src/navdata/routeGeometry';
import { ARINC_LETTER_TYPE, ATOOLS_APPROACH_TYPE, PLAN_APPROACH_TYPE_NAME, approachTypeOf } from '../src/navdata/approachTypes';

// Synthetic data only: invented idents and coordinates.

function fresh(): Database.Database {
  const db = new Database(':memory:');
  applyNavdataSchema(db);
  return db;
}

function airport(db: Database.Database, ident: string, detail = 'detail', magvar: number | null = null): void {
  db.prepare('INSERT INTO nav_airport (ident, detail_state, magvar, rev) VALUES (?, ?, ?, 1)').run(ident, detail, magvar);
}

function runway(
  db: Database.Database, ap: string, lat: number, lon: number, heading: number, lengthM: number,
  primary: [number, number], secondary: [number, number],
  thresholds: [number | null, number | null] = [null, null],
): void {
  db.prepare(
    `INSERT INTO nav_runway (rwy_key, airport_ident, lat, lon, heading_deg, length_m,
       primary_number, primary_designator, secondary_number, secondary_designator,
       primary_threshold_m, secondary_threshold_m, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(`${ap}|${primary[0]}|${primary[1]}`, ap, lat, lon, heading, lengthM, ...primary, ...secondary, ...thresholds);
}

interface L {
  t: number; lat?: number | null; lon?: number | null; ident?: string;
  cLat?: number | null; cLon?: number | null; turn?: number; alt1?: number; spd?: number;
}

interface ProcOpts { type?: number | null; suffix?: string | null; faf?: string | null }

function procedure(
  db: Database.Database, ap: string, kind: 'SID' | 'STAR' | 'APPROACH', name: string,
  rwy: [number, number] | null,
  transitions: { role: 'common' | 'runway' | 'enroute' | 'approach' | 'final'; name?: string; rwy?: [number, number]; legs: L[] }[],
  opts: ProcOpts = {},
): string {
  const pk = procKey(ap, kind, name, rwy?.[0] ?? null, rwy?.[1] ?? null, opts.suffix ?? null);
  db.prepare(
    'INSERT INTO nav_procedure (proc_key, airport_ident, kind, name, runway_number, runway_designator, approach_type, suffix, faf_ident, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(pk, ap, kind, name, rwy?.[0] ?? null, rwy?.[1] ?? null, opts.type ?? null, opts.suffix ?? null, opts.faf ?? null);
  for (const t of transitions) {
    const tk = transKey(pk, t.role, t.name ?? '');
    db.prepare(
      'INSERT INTO nav_procedure_transition (trans_key, proc_key, role, name, runway_number, runway_designator, rev) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(tk, pk, t.role, t.name ?? '', t.rwy?.[0] ?? null, t.rwy?.[1] ?? null);
    t.legs.forEach((l, i) => {
      db.prepare(
        `INSERT INTO nav_procedure_leg (trans_key, seq, leg_type, fix_ident, fix_lat, fix_lon,
           arc_center_lat, arc_center_lon, turn_direction, altitude1_m, speed_limit_kt, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(tk, i + 1, l.t, l.ident ?? null, l.lat ?? null, l.lon ?? null, l.cLat ?? null, l.cLon ?? null, l.turn ?? null, l.alt1 ?? null, l.spd ?? null);
    });
  }
  return pk;
}

function waypoint(db: Database.Database, ident: string, region: string, lat: number, lon: number): string {
  const key = wptKey(ident, region, lat, lon);
  db.prepare('INSERT INTO nav_waypoint (wpt_key, ident, region, lat, lon, rev) VALUES (?, ?, ?, ?, ?, 1)').run(key, ident, region, lat, lon);
  return key;
}

function airwayLeg(db: Database.Database, airway: string, a: { key: string; ident: string; lat: number; lon: number }, b: typeof a): void {
  db.prepare(
    `INSERT INTO nav_airway_leg (leg_key, airway, from_key, to_key, from_ident, from_region, from_lat, from_lon,
       to_ident, to_region, to_lat, to_lon, min_lat, max_lat, min_lon, max_lon, rev)
     VALUES (?, ?, ?, ?, ?, 'ZZ', ?, ?, ?, 'ZZ', ?, ?, 0, 0, 0, 0, 1)`,
  ).run(legKey(airway, a.key, b.key), airway, a.key, b.key, a.ident, a.lat, a.lon, b.ident, b.lat, b.lon);
}

function wpt(seq: number, ident: string, lat: number, lon: number, over: Partial<PlannedWaypoint> = {}): PlannedWaypoint {
  return {
    id: seq, planned_leg_id: 11, seq, ident, name: null, region: null, airway: null, track: null,
    type: 'WAYPOINT', comment: null, lat, lon, alt_ft: null, ...over,
  };
}

function planned(over: Partial<PlannedLegWithChildren> = {}): PlannedLegWithChildren {
  return makePlannedLegWithChildren({
    departure_ident: 'TSTA', departure_lat: 10, departure_lon: 20,
    destination_ident: 'TSTB', destination_lat: 10, destination_lon: 22,
    waypoints: [
      wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
      wpt(2, 'TSTB', 10, 22, { type: 'AIRPORT' }),
    ],
    ...over,
  });
}

describe('procedure legs', () => {
  it('counts coordinate-less types, rejects (0,0), collapses duplicates without counting', () => {
    const db = fresh();
    airport(db, 'TSTA');
    procedure(db, 'TSTA', 'SID', 'ALPHA1', [10, 0], [{
      role: 'runway', rwy: [10, 0],
      legs: [
        { t: 4, lat: 11, lon: 21, ident: 'FIXA' },
        { t: 2, lat: 11.1, lon: 21.1 },                 // CA: coordinate-less even with a coordinate
        { t: 18, lat: 11, lon: 21, ident: 'FIXA' },     // duplicate of previous point
        { t: 18, lat: 0, lon: 0 },                      // (0,0) rejected
        { t: 19 },                                      // VA
        { t: 18, lat: 11.5, lon: 21.5, ident: 'FIXB' },
        { t: 0, lat: 12, lon: 22, ident: 'FIXC' },      // UNKNOWN with a valid coordinate
        { t: 0, lat: null, lon: null },                 // UNKNOWN without one
      ],
    }]);
    const r = buildRouteGeometry(planned({ sid_name: 'alpha1 ', sid_runway: '10' }), db);
    expect(r.sid.points.map((p) => p.ident)).toEqual(['FIXA', 'FIXB', 'FIXC']);
    expect(r.skippedLegs).toBe(4);
    expect(r.skippedByChain).toEqual({ sid: 4, enroute: 0, star: 0, approach: 0 });
    expect(r.sid.synthetic).toBe(false);
    expect(r.sid.source).toBe('TSTA|SID|ALPHA1|10|0|');
  });

  it('emits an arc only for AF/RF with a valid centre and a previous point', () => {
    const db = fresh();
    airport(db, 'TSTA');
    procedure(db, 'TSTA', 'SID', 'ARCS1', null, [{
      role: 'common',
      legs: [
        { t: 17, lat: 11, lon: 21, cLat: 11, cLon: 20.5, turn: 1 },   // first point: no previous
        { t: 17, lat: 11.2, lon: 21.2, cLat: 11.1, cLon: 21, turn: 2 },
        { t: 1, lat: 11.4, lon: 21.4, cLat: 0, cLon: 0, turn: 1 },    // invalid centre
        { t: 1, lat: 11.6, lon: 21.6, cLat: 11.5, cLon: 21.5, turn: 3 },
      ],
    }]);
    const r = buildRouteGeometry(planned({ sid_name: 'ARCS1' }), db);
    expect(r.sid.points).toHaveLength(4);
    expect(r.sid.arcs).toEqual([
      { fromIndex: 0, toIndex: 1, centerLat: 11.1, centerLon: 21, turn: 'R' },
      { fromIndex: 2, toIndex: 3, centerLat: 11.5, centerLon: 21.5, turn: null },
    ]);
  });

  it('selects by runway, then null-runway, then smallest key; carries crossing altitudes', () => {
    const db = fresh();
    airport(db, 'TSTB');
    const leg = (id: string): L[] => [{ t: 4, lat: 9, lon: 21, ident: id, alt1: 1500 }];
    procedure(db, 'TSTB', 'STAR', 'BRAVO2', [10, 0], [{ role: 'common', legs: leg('R10') }]);
    procedure(db, 'TSTB', 'STAR', 'BRAVO2', [28, 0], [{ role: 'common', legs: leg('R28') }]);
    procedure(db, 'TSTB', 'STAR', 'CHARL1', [28, 0], [{ role: 'common', legs: leg('C28') }]);
    procedure(db, 'TSTB', 'STAR', 'CHARL1', null, [{ role: 'common', legs: leg('CNULL') }]);
    procedure(db, 'TSTB', 'STAR', 'DELTA1', [36, 0], [{ role: 'common', legs: leg('D36') }]);
    procedure(db, 'TSTB', 'STAR', 'DELTA1', [18, 0], [{ role: 'common', legs: leg('D18') }]);
    const pick = (name: string, rwy: string | null): string | null =>
      buildRouteGeometry(planned({ star_name: name, star_runway: rwy }), db).star.points[0]?.ident ?? null;
    expect(pick('BRAVO2', '28')).toBe('R28');
    expect(pick('CHARL1', '10')).toBe('CNULL');
    expect(pick('DELTA1', '10')).toBe('D18');
    expect(buildRouteGeometry(planned({ star_name: 'BRAVO2', star_runway: '28' }), db).star.points[0].altitude1M).toBe(1500);
  });

  it('reports the right reason when a procedure is missing', () => {
    const db = fresh();
    airport(db, 'TSTA', 'detail');
    airport(db, 'TSTB', 'index');
    const r = buildRouteGeometry(planned({ sid_name: 'NOPE1', star_name: 'NOPE2', approach_name: 'ILS28', approach_type: 'ILS', approach_runway: '28' }), db);
    expect(r.unresolved).toEqual([
      { kind: 'sid', name: 'NOPE1', reason: 'procedure not in cache' },
      { kind: 'star', name: 'NOPE2', reason: 'airport detail not fetched' },
      { kind: 'approach', name: 'ILS28', reason: 'airport detail not fetched' },
    ]);
  });

  it('reports an unparseable procedure runway on its own', () => {
    const db = fresh();
    airport(db, 'TSTA');
    const r = buildRouteGeometry(planned({ sid_name: 'ALPHA1', sid_runway: '45' }), db);
    expect(r.unresolved).toEqual([{ kind: 'sid', name: 'ALPHA1', reason: 'unparseable runway' }]);
    expect(r.sid.points).toEqual([]);
  });
});

describe('enroute waypoints and airways', () => {
  it('draws the planned position and never reports USER or airport waypoints as missing', () => {
    const db = fresh();
    const r = buildRouteGeometry(planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'MYPT', 10, 20.5, { type: 'USER' }),
        wpt(3, 'LOST', 10, 21, { type: 'WAYPOINT' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'MYPT', 'LOST', 'TSTB']);
    expect(r.enroute.source).toBe('planned');
    expect(r.unresolved).toEqual([{ kind: 'waypoint', name: 'LOST', reason: 'ident not in cache' }]);
  });

  it('never looks a USER waypoint up, even when the cache holds a far-away namesake', () => {
    const db = fresh();
    waypoint(db, 'MYPT', 'AA', 40, 80);
    const r = buildRouteGeometry(planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'MYPT', 10, 20.5, { type: 'USER' }),
        wpt(3, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    expect(r.unresolved).toEqual([]);
    expect(r.enroute.points[1]).toMatchObject({ ident: 'MYPT', lat: 10, lon: 20.5 });
  });

  it('uses nearest-neighbour when the region is unknown, ties to the smaller key, and flags a disagreement', () => {
    const db = fresh();
    waypoint(db, 'DUPE', 'AA', 10, 40);   // far
    waypoint(db, 'DUPE', 'BB', 10, 20.5); // near, matches the plan
    waypoint(db, 'FAR', 'AA', 10, 21.5);  // 0.5 degrees from the planned position
    const r = buildRouteGeometry(planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'DUPE', 10, 20.5),
        wpt(3, 'FAR', 10, 21),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    expect(r.unresolved).toEqual([{ kind: 'waypoint', name: 'FAR', reason: 'position disagrees with cache' }]);
    expect(r.enroute.points[2]).toMatchObject({ ident: 'FAR', lat: 10, lon: 21 });

    const tie = fresh();
    const kb = waypoint(tie, 'TIE', 'BB', 10, 20.5);
    const ka = waypoint(tie, 'TIE', 'AA', 10, 20.5);
    expect(ka < kb).toBe(true);
    const r2 = buildRouteGeometry(planned({
      waypoints: [wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }), wpt(2, 'TIE', 10, 20.5), wpt(3, 'TSTB', 10, 22, { type: 'AIRPORT' })],
    }), tie);
    expect(r2.unresolved).toEqual([]);
  });

  function airwayPlan(from: string, to: string, fLat: number, tLat: number): PlannedLegWithChildren {
    return planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, from, fLat, 21, { region: 'ZZ' }),
        wpt(3, to, tLat, 21, { region: 'ZZ', airway: 'T100' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    });
  }

  it('resolves an ambiguous ident by the planned position, not the previous point, so the airway expands', () => {
    const db = fresh();
    const cand = (ident: string, region: string, lat: number, lon: number) => {
      db.prepare(
        "INSERT INTO nav_waypoint (wpt_key, ident, region, lat, lon, rev, position_source, routes_state) VALUES (?, ?, ?, ?, ?, 1, 'minimal', 'unknown')",
      ).run(wptKey(ident, region, lat, lon), ident, region, lat, lon);
      return { key: wptKey(ident, region, lat, lon), ident, lat, lon };
    };
    // Candidates of one ident: one beside the previous point, others elsewhere.
    cand('AMBIG', 'AA', 10, 21.1); // nearer the previous point than the right one
    const right = cand('AMBIG', 'BB', 10, 21.5);
    cand('AMBIG', 'CC', 30, 40);
    const from = { key: waypoint(db, 'FROMM', 'ZZ', 10, 21), ident: 'FROMM', lat: 10, lon: 21 };
    const mid = { key: waypoint(db, 'MIDDL', 'ZZ', 10, 21.2), ident: 'MIDDL', lat: 10, lon: 21.2 };
    airwayLeg(db, 'T100', from, mid);
    airwayLeg(db, 'T100', mid, right);
    const plan = planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'FROMM', 10, 21),
        wpt(3, 'AMBIG', 10, 21.5, { airway: 'T100' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    });
    const r = buildRouteGeometry(plan, db);
    expect(r.unresolved).toEqual([]);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'FROMM', 'MIDDL', 'AMBIG', 'TSTB']);
  });

  it('falls back to the previous point when the planned coordinate is invalid', () => {
    const db = fresh();
    waypoint(db, 'FALLB', 'AA', 10, 20.4);  // beside the previous point
    waypoint(db, 'FALLB', 'BB', 0.0001, 0.0001); // nearest the invalid (0,0), so a lookup anchored there would take it silently
    const r = buildRouteGeometry(planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'FALLB', 0, 0),
        wpt(3, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    // Anchored on the previous point, the (10,20.4) candidate wins and the (0,0) plan disagrees with it.
    expect(r.unresolved).toEqual([{ kind: 'waypoint', name: 'FALLB', reason: 'position disagrees with cache' }]);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'TSTB']);
  });

  it('joins airway endpoints of one fix whose keys differ by a unit in the fifth decimal', () => {
    const db = fresh();
    const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
    const c = { key: waypoint(db, 'ZZCCC', 'ZZ', 10.3, 21), ident: 'ZZCCC', lat: 10.3, lon: 21 };
    const b1 = { key: wptKey('ZZBBB', 'ZZ', 10.2, 21), ident: 'ZZBBB', lat: 10.2, lon: 21 };
    const b2 = { key: wptKey('ZZBBB', 'ZZ', 10.20001, 21), ident: 'ZZBBB', lat: 10.20001, lon: 21 };
    expect(b1.key).not.toBe(b2.key);
    airwayLeg(db, 'T100', a, b1);
    airwayLeg(db, 'T100', b2, c);
    const r = buildRouteGeometry(airwayPlan('ZZAAA', 'ZZCCC', 10.1, 10.3), db);
    expect(r.unresolved).toEqual([]);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'ZZAAA', 'ZZBBB', 'ZZCCC', 'TSTB']);
  });

  it('does not join same-ident endpoints that are apart, or of another region', () => {
    const far = fresh();
    const a = { key: waypoint(far, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
    const c = { key: waypoint(far, 'ZZCCC', 'ZZ', 10.3, 21), ident: 'ZZCCC', lat: 10.3, lon: 21 };
    const b1 = { key: wptKey('ZZBBB', 'ZZ', 10.2, 21), ident: 'ZZBBB', lat: 10.2, lon: 21 };
    const b2 = { key: wptKey('ZZBBB', 'ZZ', 10.2003, 21), ident: 'ZZBBB', lat: 10.2003, lon: 21 };
    airwayLeg(far, 'T100', a, b1);
    airwayLeg(far, 'T100', b2, c);
    expect(buildRouteGeometry(airwayPlan('ZZAAA', 'ZZCCC', 10.1, 10.3), far).unresolved)
      .toEqual([{ kind: 'airway', name: 'T100', reason: 'no path found' }]);

    const other = fresh();
    const a2 = { key: waypoint(other, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
    const c2 = { key: waypoint(other, 'ZZCCC', 'ZZ', 10.3, 21), ident: 'ZZCCC', lat: 10.3, lon: 21 };
    const bq = { key: wptKey('ZZBBB', 'QQ', 10.20001, 21), ident: 'ZZBBB', lat: 10.20001, lon: 21 };
    airwayLeg(other, 'T100', a2, b1);
    airwayLeg(other, 'T100', bq, c2);
    expect(buildRouteGeometry(airwayPlan('ZZAAA', 'ZZCCC', 10.1, 10.3), other).unresolved)
      .toEqual([{ kind: 'airway', name: 'T100', reason: 'no path found' }]);
  });

  describe('a planned waypoint with no cache row', () => {
    function build(vorLat: number, region: string | null) {
      const db = fresh();
      const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
      const mid = { key: waypoint(db, 'ZZMID', 'ZZ', 10.2, 21), ident: 'ZZMID', lat: 10.2, lon: 21 };
      const vor = { key: wptKey('ZZVOR', 'ZZ', vorLat, 21), ident: 'ZZVOR', lat: vorLat, lon: 21 };
      airwayLeg(db, 'T100', a, mid);
      airwayLeg(db, 'T100', mid, vor);
      return buildRouteGeometry(planned({
        waypoints: [
          wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
          wpt(2, 'ZZAAA', 10.1, 21, { region: 'ZZ' }),
          wpt(3, 'zzvor', 10.3, 21, { type: 'VOR', region, airway: 'T100' }),
          wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
        ],
      }), db);
    }

    it('joins an airway endpoint by ident, region and proximity', () => {
      for (const region of [null, 'ZZ', 'zz']) {
        const r = build(10.3001, region);
        expect(r.unresolved).toEqual([]);
        expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'ZZAAA', 'ZZMID', 'zzvor', 'TSTB']);
      }
    });

    it('does not join an endpoint 5 km away or in another region', () => {
      expect(build(10.345, null).unresolved).toEqual([
        { kind: 'waypoint', name: 'zzvor', reason: 'ident not in cache' },
        { kind: 'airway', name: 'T100', reason: 'no path found' },
      ]);
      expect(build(10.3001, 'QQ').unresolved).toEqual([
        { kind: 'waypoint', name: 'zzvor', reason: 'ident not in cache' },
        { kind: 'airway', name: 'T100', reason: 'no path found' },
      ]);
    });
  });

  describe('airway endpoint lookup for a waypoint with no cache row', () => {
    const vorPlan = (region: string | null, lat = 10.3, ident = 'ZZVOR') => planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'ZZAAA', 10.1, 21, { region: 'ZZ' }),
        wpt(3, ident, lat, 21, { type: 'VOR', region, airway: 'T100' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    });
    const node = (ident: string, lat: number, region = 'ZZ') => ({ key: wptKey(ident, region, lat, 21), ident, lat, lon: 21 });

    it('reads the endpoint keys through the from_key and to_key indexes, never a table scan', () => {
      const db = fresh();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${AIRWAY_ENDPOINT_SQL}`).all({ lo: 'ZZVOR|', hi: 'ZZVOR}' }) as { detail: string }[];
      const details = plan.map((p) => p.detail).join('\n');
      expect(details).not.toMatch(/SCAN nav_airway_leg/);
      expect(details).toMatch(/SEARCH nav_airway_leg USING (COVERING )?INDEX nav_airway_leg_from/);
      expect(details).toMatch(/SEARCH nav_airway_leg USING (COVERING )?INDEX nav_airway_leg_to/);
    });

    it('gives the same result on a large table as on a small one', () => {
      const db = fresh();
      const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
      const mid = { key: waypoint(db, 'ZZMID', 'ZZ', 10.2, 21), ident: 'ZZMID', lat: 10.2, lon: 21 };
      const vor = node('ZZVOR', 10.3001);
      airwayLeg(db, 'T100', a, mid);
      airwayLeg(db, 'T100', mid, vor);
      const ins = db.prepare(
        `INSERT INTO nav_airway_leg (leg_key, airway, from_key, to_key, from_ident, from_region, from_lat, from_lon,
           to_ident, to_region, to_lat, to_lon, min_lat, max_lat, min_lon, max_lon, rev)
         VALUES (?, 'J1', ?, ?, ?, 'ZZ', 0, 0, ?, 'ZZ', 0, 0, 0, 0, 0, 0, 1)`,
      );
      db.transaction(() => {
        for (let i = 0; i < 20000; i++) {
          const f = `F${i}|ZZ|${i}|0`, t = `F${i + 1}|ZZ|${i + 1}|0`;
          ins.run(legKey('J1', f, t), f, t, `F${i}`, `F${i + 1}`);
        }
      })();
      const r = buildRouteGeometry(vorPlan(null), db);
      expect(r.unresolved).toEqual([]);
      expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'ZZAAA', 'ZZMID', 'ZZVOR', 'TSTB']);
    });

    it('takes the nearer of two in-tolerance endpoints, and the smaller key on an exact tie', () => {
      const build = () => {
        const db = fresh();
        const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
        const farOne = node('ZZVOR', 10.3005, 'AA'), nearOne = node('ZZVOR', 10.3001, 'BB');
        expect(farOne.key < nearOne.key).toBe(true);
        airwayLeg(db, 'T100', a, nearOne);
        airwayLeg(db, 'T100', farOne, node('ZZOTH', 10.5));
        return buildRouteGeometry(vorPlan(null, 10.3), db);
      };
      // The nearer endpoint has the larger key and is the only one on the airway.
      const near = build();
      expect(near.unresolved).toEqual([]);
      expect(near.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'ZZAAA', 'ZZVOR', 'TSTB']);
      // Two endpoints at the same spot in different regions: an exact distance tie.
      const db = fresh();
      const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
      const mid = { key: waypoint(db, 'ZZMID', 'ZZ', 10.2, 21), ident: 'ZZMID', lat: 10.2, lon: 21 };
      const lo = node('ZZVOR', 10.3001, 'AA'), hi = node('ZZVOR', 10.3001, 'BB');
      expect(lo.key < hi.key).toBe(true);
      airwayLeg(db, 'T100', a, mid);
      airwayLeg(db, 'T100', mid, hi);   // only the larger-key endpoint connects
      airwayLeg(db, 'T100', a, lo);     // the smaller-key endpoint connects directly
      const r = buildRouteGeometry(vorPlan(null, 10.3), db);
      expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'ZZAAA', 'ZZVOR', 'TSTB']);
    });

    it('matches a lower-case stored ident as given', () => {
      const db = fresh();
      const a = { key: waypoint(db, 'ZZAAA', 'ZZ', 10.1, 21), ident: 'ZZAAA', lat: 10.1, lon: 21 };
      airwayLeg(db, 'T100', a, node('zzlow', 10.3001));
      const r = buildRouteGeometry(vorPlan(null, 10.3, 'zzlow'), db);
      expect(r.unresolved).toEqual([]);
    });
  });

  it('treats DCT and the SID/STAR name as direct segments, not airways', () => {
    const db = fresh();
    waypoint(db, 'AAAAA', 'ZZ', 10.1, 21);
    waypoint(db, 'BBBBB', 'ZZ', 10.2, 21);
    waypoint(db, 'CCCCC', 'ZZ', 10.3, 21);
    const r = buildRouteGeometry(planned({
      sid_name: 'TSTS1', star_name: 'TSTR2',
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'AAAAA', 10.1, 21, { region: 'ZZ', airway: ' tsts1 ' }),
        wpt(3, 'BBBBB', 10.2, 21, { region: 'ZZ', airway: 'dct' }),
        wpt(4, 'CCCCC', 10.3, 21, { region: 'ZZ', airway: 'TSTR2' }),
        wpt(5, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    // The SID/STAR chains report their own missing detail; only the airway view matters here.
    expect(r.unresolved.filter((u) => u.kind === 'airway')).toEqual([]);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'AAAAA', 'BBBBB', 'CCCCC', 'TSTB']);
  });

  it('ignores an airway value at an airport endpoint, treats blank like NULL, and honours transition names', () => {
    const db = fresh();
    waypoint(db, 'AAAAA', 'ZZ', 10.1, 21);
    waypoint(db, 'BBBBB', 'ZZ', 10.2, 21);
    const r = buildRouteGeometry(planned({
      sid_transition: 'TSTT1',
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT', airway: 'STRAY1' }),
        wpt(2, 'AAAAA', 10.1, 21, { region: 'ZZ', airway: 'STRAY2' }),
        wpt(3, 'BBBBB', 10.2, 21, { region: 'ZZ', airway: '' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT', airway: 'ONAGA' }),
      ],
    }), db);
    expect(r.unresolved.filter((u) => u.kind === 'airway')).toEqual([]);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'AAAAA', 'BBBBB', 'TSTB']);

    const t = buildRouteGeometry(planned({
      sid_transition: 'TSTT1',
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'AAAAA', 10.1, 21, { region: 'ZZ' }),
        wpt(3, 'BBBBB', 10.2, 21, { region: 'ZZ', airway: 'tstt1' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    expect(t.unresolved.filter((u) => u.kind === 'airway')).toEqual([]);
  });

  it('still reports a genuinely unknown airway name', () => {
    const db = fresh();
    waypoint(db, 'AAAAA', 'ZZ', 10.1, 21);
    waypoint(db, 'BBBBB', 'ZZ', 10.2, 21);
    const r = buildRouteGeometry(planned({
      sid_name: 'TSTS1',
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'AAAAA', 10.1, 21, { region: 'ZZ' }),
        wpt(3, 'BBBBB', 10.2, 21, { region: 'ZZ', airway: 'Q999' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    }), db);
    expect(r.unresolved.filter((u) => u.kind === 'airway')).toEqual([{ kind: 'airway', name: 'Q999', reason: 'no path found' }]);
  });

  it('expands an airway through the ascending-key neighbour', () => {
    const db = fresh();
    const n = (ident: string, lat: number) => ({ key: waypoint(db, ident, 'ZZ', lat, 21), ident, lat, lon: 21 });
    const a = n('AAAAA', 10.1), b = n('BBBBB', 10.2), c = n('CCCCC', 10.3), d = n('DDDDD', 10.4);
    airwayLeg(db, 'T100', a, c); airwayLeg(db, 'T100', c, d); airwayLeg(db, 'T100', a, b); airwayLeg(db, 'T100', b, d);
    const r = buildRouteGeometry(airwayPlan('AAAAA', 'DDDDD', 10.1, 10.4), db);
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'AAAAA', 'BBBBB', 'DDDDD', 'TSTB']);
    expect(r.unresolved).toEqual([]);
    expect(r.skippedLegs).toBe(0);
  });

  function lineAirway(count: number): Database.Database {
    const db = fresh();
    const nodes = Array.from({ length: count }, (_, i) => {
      const ident = `N${String(i).padStart(4, '0')}`;
      return { key: waypoint(db, ident, 'ZZ', 10 + i * 0.001, 21), ident, lat: 10 + i * 0.001, lon: 21 };
    });
    for (let i = 1; i < count; i++) airwayLeg(db, 'T100', nodes[i - 1], nodes[i]);
    return db;
  }

  it('honours the hop cap: exactly 200 hops expands, 201 falls back to the direct segment', () => {
    const db = lineAirway(AIRWAY_MAX_HOPS + 2);
    const ok = buildRouteGeometry(airwayPlan('N0000', `N${String(AIRWAY_MAX_HOPS).padStart(4, '0')}`, 10, 10 + AIRWAY_MAX_HOPS * 0.001), db);
    expect(ok.unresolved).toEqual([]);
    expect(ok.enroute.points).toHaveLength(AIRWAY_MAX_HOPS + 1 + 2);
    const tooFar = buildRouteGeometry(airwayPlan('N0000', `N${String(AIRWAY_MAX_HOPS + 1).padStart(4, '0')}`, 10, 10 + (AIRWAY_MAX_HOPS + 1) * 0.001), db);
    expect(tooFar.unresolved).toEqual([{ kind: 'airway', name: 'T100', reason: 'no path found' }]);
    expect(tooFar.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'N0000', 'N0201', 'TSTB']);
    expect(tooFar.skippedLegs).toBe(0);
  });

  it('honours the visit cap', () => {
    const db = fresh();
    const mk = (ident: string, lat: number) => ({ key: waypoint(db, ident, 'ZZ', lat, 21), ident, lat, lon: 21 });
    const hub = mk('HUB', 10.1);
    const target = mk('TARGET', 10.9);
    for (let i = 0; i < AIRWAY_MAX_VISITED + 100; i++) {
      airwayLeg(db, 'T100', hub, mk(`L${String(i).padStart(4, '0')}`, 10.2 + i * 1e-4));
    }
    airwayLeg(db, 'T100', hub, mk('ZLAST', 10.5));
    airwayLeg(db, 'T100', mk('ZLAST2', 10.6), target);
    airwayLeg(db, 'T100', { key: wptKey('ZLAST2', 'ZZ', 10.6, 21), ident: 'ZLAST2', lat: 10.6, lon: 21 }, { key: wptKey('ZLAST', 'ZZ', 10.5, 21), ident: 'ZLAST', lat: 10.5, lon: 21 });
    const r = buildRouteGeometry(airwayPlan('HUB', 'TARGET', 10.1, 10.9), db);
    expect(r.unresolved).toEqual([{ kind: 'airway', name: 'T100', reason: 'no path found' }]);
  });

  it('falls back to the direct segment when an endpoint is unresolved', () => {
    const r = buildRouteGeometry(airwayPlan('AAAAA', 'DDDDD', 10.1, 10.4), fresh());
    expect(r.unresolved).toContainEqual({ kind: 'airway', name: 'T100', reason: 'no path found' });
    expect(r.enroute.points.map((p) => p.ident)).toEqual(['TSTA', 'AAAAA', 'DDDDD', 'TSTB']);
  });
});

describe('synthetic custom procedures', () => {
  const nm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
    haversineNm(a.lat, a.lon, b.lat, b.lon);
  const centre = { lat: 10, lon: 22 };

  function setup(magvar: number | null = null): Database.Database {
    const db = fresh();
    airport(db, 'TSTA', 'detail', magvar);
    airport(db, 'TSTB', 'detail', magvar);
    // 4000 m runway, primary end 10 heading 100, secondary end 28
    runway(db, 'TSTB', centre.lat, centre.lon, 100, 4000, [10, 0], [28, 0]);
    runway(db, 'TSTA', centre.lat, centre.lon, 100, 4000, [10, 0], [28, 0]);
    return db;
  }
  const approach = (rwy: string | null, over: Partial<PlannedLegWithChildren> = {}): PlannedLegWithChildren =>
    planned({
      approach_type: 'CUSTOM', approach_name: 'TSTBCUS', approach_runway: rwy,
      approach_custom_distance_nm: 3, approach_custom_altitude_ft: 1000, approach_custom_offset_deg: 0, ...over,
    });

  it('draws a custom approach from the landing threshold, 3 nm out, never counted as skipped', () => {
    const r = buildRouteGeometry(approach('10'), setup());
    const [start, thr] = r.approach.points;
    expect(r.approach.synthetic).toBe(true);
    expect(r.approach.source).toBe('TSTBCUS');
    expect(nm(thr, centre)).toBeCloseTo(2000 / 1852, 2);
    expect(nm(start, thr)).toBeCloseTo(3, 2);
    // measured from the centre instead, the start would be 1.08 nm further out
    expect(nm(start, centre)).toBeCloseTo(3 + 2000 / 1852, 1);
    expect(start.altitude1M).toBeCloseTo(304.8, 6);
    expect(start.ident).toBe('TSTBCUS');
    expect(thr.ident).toBe('10');
    expect(r.skippedLegs).toBe(0);
    expect(r.skippedByChain).toEqual({ sid: 0, enroute: 0, star: 0, approach: 0 });
    expect(r.unresolved).toEqual([]);
    // approaching runway 10 (heading 100): the start lies on the reciprocal side
    expect(bearingDeg(start.lat, start.lon, thr.lat, thr.lon)).toBeCloseTo(100, 0);
  });

  it('gives mirror-image geometry for the secondary end', () => {
    const db = setup();
    const p = buildRouteGeometry(approach('10'), db).approach.points;
    const s = buildRouteGeometry(approach('28'), db).approach.points;
    expect(nm(p[1], s[1])).toBeCloseTo(4000 / 1852, 2);
    expect(bearingDeg(s[0].lat, s[0].lon, s[1].lat, s[1].lon)).toBeCloseTo(280, 0);
    expect(nm(s[0], s[1])).toBeCloseTo(3, 2);
  });

  it('draws a custom departure from the departure threshold', () => {
    const db = setup();
    const r = buildRouteGeometry(planned({
      sid_type: 'CUSTOMDEPART', sid_name: 'TSTACUS', sid_runway: '10', sid_custom_distance_nm: 5,
    }), db);
    const [thr, away] = r.sid.points;
    expect(r.sid.synthetic).toBe(true);
    expect(r.sid.source).toBe('TSTACUS');
    expect(nm(thr, centre)).toBeCloseTo(2000 / 1852, 2);
    expect(nm(thr, away)).toBeCloseTo(5, 2);
    expect(bearingDeg(thr.lat, thr.lon, away.lat, away.lon)).toBeCloseTo(100, 0);
    expect(r.skippedLegs).toBe(0);
  });

  it('reports a missing runway row without a chain or a skipped count', () => {
    const db = setup();
    const r = buildRouteGeometry(approach('16L'), db);
    expect(r.approach).toMatchObject({ source: null, synthetic: false, points: [] });
    expect(r.unresolved).toEqual([{ kind: 'approach', name: 'TSTBCUS', reason: 'custom procedure, no runway' }]);
    expect(r.skippedLegs).toBe(0);
    const none = buildRouteGeometry(approach(null), db);
    expect(none.unresolved[0].reason).toBe('custom procedure, no runway');
    const noDetail = buildRouteGeometry(approach('10'), fresh());
    expect(noDetail.unresolved).toEqual([{ kind: 'approach', name: 'TSTBCUS', reason: 'custom procedure, no runway' }]);
    expect(noDetail.unresolved.some((u) => u.reason === 'procedure not in cache')).toBe(false);
  });

  it('reports an invalid custom distance apart from a missing runway', () => {
    const db = setup();
    for (const bad of [null, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = buildRouteGeometry(approach('10', { approach_custom_distance_nm: bad as number | null }), db);
      expect(r.approach.points).toEqual([]);
      expect(r.unresolved).toEqual([{ kind: 'approach', name: 'TSTBCUS', reason: 'custom procedure, invalid distance' }]);
    }
  });

  it('reports an unparseable runway on a custom procedure', () => {
    const r = buildRouteGeometry(approach('XY'), setup());
    expect(r.unresolved).toEqual([{ kind: 'approach', name: 'TSTBCUS', reason: 'unparseable runway' }]);
    expect(r.approach.points).toEqual([]);
  });

  it('ignores a non-zero approach offset', () => {
    const db = setup();
    const base = buildRouteGeometry(approach('10'), db);
    const off = buildRouteGeometry(approach('10', { approach_custom_offset_deg: 15 }), db);
    expect(off.approach).toEqual(base.approach);
    expect(off.approach.synthetic).toBe(true);
    expect(off.unresolved).toEqual([]);
  });

  it('draws the reciprocal of the heading for a runway whose primary end is the higher number', () => {
    const db = fresh();
    airport(db, 'TSTB');
    // 19/01 pair: the stored heading (180) belongs to the primary end, 19.
    runway(db, 'TSTB', centre.lat, centre.lon, 180, 3000, [19, 0], [1, 0]);
    const bearing = (rwy: string): number => {
      const [start, thr] = buildRouteGeometry(approach(rwy), db).approach.points;
      return bearingDeg(start.lat, start.lon, thr.lat, thr.lon);
    };
    expect(bearing('19')).toBeCloseTo(180, 0);
    expect(bearing('01')).toBeCloseTo(0, 0);
  });

  it('moves the landing threshold inboard by the matching displaced length, per end', () => {
    const plain = fresh();
    airport(plain, 'TSTB');
    runway(plain, 'TSTB', centre.lat, centre.lon, 100, 3000, [10, 0], [28, 0]);
    const displaced = fresh();
    airport(displaced, 'TSTB');
    runway(displaced, 'TSTB', centre.lat, centre.lon, 100, 3000, [10, 0], [28, 0], [60, 200]);
    for (const [rwy, metres] of [['10', 60], ['28', 200]] as const) {
      const a = buildRouteGeometry(approach(rwy), plain).approach.points;
      const b = buildRouteGeometry(approach(rwy), displaced).approach.points;
      expect(nm(a[1], b[1]) * 1852).toBeCloseTo(metres, 0);
      expect(nm(a[0], b[0]) * 1852).toBeCloseTo(metres, 0);
      // inboard: closer to the runway centre than the pavement end
      expect(nm(b[1], centre)).toBeLessThan(nm(a[1], centre));
    }
    const zero = fresh();
    airport(zero, 'TSTB');
    runway(zero, 'TSTB', centre.lat, centre.lon, 100, 3000, [10, 0], [28, 0], [0, 0]);
    expect(buildRouteGeometry(approach('10'), zero).approach).toEqual(buildRouteGeometry(approach('10'), plain).approach);
  });

  it('follows an injected heading reference', () => {
    expect(RUNWAY_HEADING_REFERENCE).toBe('true');
    expect(runwayTrueBearing(100, 12, 'true')).toBe(100);
    expect(runwayTrueBearing(100, 12, 'unknown')).toBe(100);
    expect(runwayTrueBearing(100, 12, 'magnetic')).toBe(112);
    expect(runwayTrueBearing(350, 20, 'magnetic')).toBe(10);
    expect(runwayTrueBearing(100, null, 'magnetic')).toBe(100);

    const db = setup(12);
    const t = buildRouteGeometry(approach('10'), db, { headingReference: 'true' }).approach.points[0];
    const m = buildRouteGeometry(approach('10'), db, { headingReference: 'magnetic' }).approach.points[0];
    const u = buildRouteGeometry(approach('10'), db, { headingReference: 'unknown' }).approach.points[0];
    expect(u).toEqual(t);
    expect(nm(t, m)).toBeGreaterThan(0.5);
    const thrT = buildRouteGeometry(approach('10'), db, { headingReference: 'true' }).approach.points[1];
    const thrM = buildRouteGeometry(approach('10'), db, { headingReference: 'magnetic' }).approach.points[1];
    expect(bearingDeg(t.lat, t.lon, thrT.lat, thrT.lon)).toBeCloseTo(100, 0);
    expect(bearingDeg(m.lat, m.lon, thrM.lat, thrM.lon)).toBeCloseTo(112, 0);
    expect(dest(0, 0, 90, 0)).toEqual({ lat: 0, lon: 0 });
  });
});

describe('empty answers', () => {
  it('returns every chain empty for an absent replica', () => {
    const r = buildRouteGeometry(planned({
      sid_name: 'X', approach_type: 'CUSTOM', approach_name: 'Y', sid_type: 'CUSTOMDEPART',
    }), null);
    for (const c of [r.sid, r.enroute, r.star, r.approach]) {
      expect(c).toEqual({ source: null, synthetic: false, points: [], arcs: [] });
    }
    expect(r.skippedLegs).toBe(0);
    expect(r.unresolved).toEqual([]);
    expect(r.legId).toBe(11);
  });

  it('reports endpoints with isAirport, and null when the coordinate is unusable', () => {
    const r = buildRouteGeometry(planned({ destination_is_airport: 0, departure_lat: 0, departure_lon: 0 }), null);
    expect(r.origin).toBeNull();
    expect(r.destination).toEqual({ ident: 'TSTB', lat: 10, lon: 22, isAirport: false });
    const ok = buildRouteGeometry(planned(), null);
    expect(ok.origin).toEqual({ ident: 'TSTA', lat: 10, lon: 20, isAirport: true });
  });
});

describe('approach selection', () => {
  // Three approaches to one runway sharing FAF and transition names, told apart only by type.
  function setup(over: { suffixes?: (string | null)[]; types?: (number | null)[]; fafs?: string[] } = {}): Database.Database {
    const db = fresh();
    airport(db, 'TSTB');
    const types = over.types ?? [1, 4, 10];
    types.forEach((type, i) => {
      procedure(db, 'TSTB', 'APPROACH', `ZZAPP${i}`, [28, 2], [
        { role: 'approach', name: 'ZZIAF', legs: [{ t: 4, lat: 10 + i, lon: 21, ident: 'ZZIAF' }] },
        { role: 'final', legs: [{ t: 4, lat: 10, lon: 21.5 + i / 100, ident: `ZZFIN${type}` }] },
      ], { type, suffix: over.suffixes?.[i] ?? null, faf: over.fafs?.[i] ?? 'ZZFAF' });
    });
    return db;
  }
  const plan = (over: Partial<PlannedLegWithChildren> = {}): PlannedLegWithChildren =>
    planned({ approach_name: 'ZZFAF', approach_runway: '28R', approach_type: 'ILS', approach_arinc: 'I28R', ...over });
  const finalIdent = (r: ReturnType<typeof buildRouteGeometry>): string | undefined =>
    r.approach.points[r.approach.points.length - 1]?.ident ?? undefined;

  it('picks the type from the ARINC leading letter', () => {
    const db = setup();
    expect(finalIdent(buildRouteGeometry(plan({ approach_arinc: 'I28R' }), db))).toBe('ZZFIN4');
    expect(finalIdent(buildRouteGeometry(plan({ approach_arinc: 'R28R' }), db))).toBe('ZZFIN10');
    expect(finalIdent(buildRouteGeometry(plan({ approach_arinc: 'P28R' }), db))).toBe('ZZFIN1');
  });

  it('falls back to the approach_type string when ARINC is empty', () => {
    const db = setup();
    expect(finalIdent(buildRouteGeometry(plan({ approach_arinc: '', approach_type: 'GPS' }), db))).toBe('ZZFIN1');
    expect(finalIdent(buildRouteGeometry(plan({ approach_arinc: null, approach_type: 'RNAV' }), db))).toBe('ZZFIN10');
  });

  it('treats an unknown letter or type as no preference and still draws', () => {
    const db = setup();
    for (const over of [{ approach_arinc: 'Z28R' }, { approach_arinc: '', approach_type: 'WHATEVER' }, { approach_arinc: 'S28R' }]) {
      const r = buildRouteGeometry(plan(over), db);
      expect(r.unresolved).toEqual([]);
      expect(r.approach.points.length).toBeGreaterThan(0);
      expect(finalIdent(r)).toBe('ZZFIN1'); // smallest proc_key
    }
  });

  it('keeps every candidate when none has the preferred type', () => {
    const db = setup({ types: [1, 10] });
    const r = buildRouteGeometry(plan({ approach_arinc: 'I28R' }), db);
    expect(r.unresolved).toEqual([]);
    expect(finalIdent(r)).toBe('ZZFIN1');
  });

  it('matches suffix with "0" and NULL meaning none', () => {
    const db = setup({ types: [4, 4], suffixes: ['Z', '0'] });
    expect(finalIdent(buildRouteGeometry(plan({ approach_suffix: null }), db))).toBe('ZZFIN4');
    const r = buildRouteGeometry(plan({ approach_suffix: ' ' }), db);
    expect(r.approach.source).toContain('ZZAPP1');
    const only = setup({ types: [4], suffixes: ['Z'] });
    const none = buildRouteGeometry(plan({ approach_suffix: null }), only);
    expect(none.approach.points).toEqual([]);
    expect(none.unresolved).toEqual([{ kind: 'approach', name: 'ZZFAF', reason: 'procedure not in cache' }]);
    const nullStored = setup({ types: [4], suffixes: [null] });
    expect(buildRouteGeometry(plan({ approach_suffix: '0' }), nullStored).approach.points.length).toBeGreaterThan(0);
  });

  it('treats "1" as a real suffix and letters case-insensitively', () => {
    const db = setup({ types: [4, 4], suffixes: ['0', '1'] });
    expect(buildRouteGeometry(plan({ approach_suffix: '1' }), db).approach.source).toContain('ZZAPP1');
    const zeroOnly = setup({ types: [4], suffixes: ['0'] });
    expect(buildRouteGeometry(plan({ approach_suffix: '1' }), zeroOnly).approach.points).toEqual([]);
    const letters = setup({ types: [4, 4], suffixes: [null, 'Z'] });
    expect(buildRouteGeometry(plan({ approach_suffix: ' z ' }), letters).approach.source).toContain('ZZAPP1');
  });

  it('prefers the approach whose FAF or transition name equals approach_name, then the smallest proc_key', () => {
    const db = setup({ types: [4, 4, 4], fafs: ['ZZAAA', 'ZZWANT', 'ZZBBB'] });
    expect(finalIdent(buildRouteGeometry(plan({ approach_name: 'zzwant' }), db))).toBe('ZZFIN4');
    expect(buildRouteGeometry(plan({ approach_name: 'zzwant' }), db).approach.source).toContain('ZZAPP1');
    expect(buildRouteGeometry(plan({ approach_name: 'ZZIAF' }), db).approach.source).toContain('ZZAPP0');
    expect(buildRouteGeometry(plan({ approach_name: 'ZZNONE' }), db).approach.source).toContain('ZZAPP0');
    const viaTransition = fresh();
    airport(viaTransition, 'TSTB');
    procedure(viaTransition, 'TSTB', 'APPROACH', 'ZZAPP0', [28, 2], [
      { role: 'approach', name: 'ZZOTHER', legs: [{ t: 4, lat: 10, lon: 21, ident: 'ZZOTHER' }] },
    ], { type: 4, faf: 'ZZF0' });
    procedure(viaTransition, 'TSTB', 'APPROACH', 'ZZAPP1', [28, 2], [
      { role: 'approach', name: 'ZZWANT', legs: [{ t: 4, lat: 10, lon: 21, ident: 'ZZWANT' }] },
    ], { type: 4, faf: 'ZZF1' });
    expect(buildRouteGeometry(plan({ approach_name: 'ZZWANT' }), viaTransition).approach.source).toContain('ZZAPP1');
  });

  it('never compares approach_name to the stored procedure name', () => {
    const db = setup({ types: [4] });
    const r = buildRouteGeometry(plan({ approach_name: 'ZZAPP0' }), db);
    expect(r.unresolved).toEqual([]);
    expect(r.approach.points.length).toBeGreaterThan(0);
    const other = buildRouteGeometry(plan({ approach_name: 'ZZDUYET' }), db);
    expect(other.unresolved).toEqual([]);
  });

  it('does not guess a runway: an absent one reports unresolved and draws nothing', () => {
    const db = setup({ types: [4] });
    for (const rwy of [null, '', '  ']) {
      const r = buildRouteGeometry(plan({ approach_runway: rwy }), db);
      expect(r.approach).toMatchObject({ source: null, points: [] });
      expect(r.unresolved).toEqual([{ kind: 'approach', name: 'ZZFAF', reason: 'approach runway not specified' }]);
      expect(r.skippedLegs).toBe(0);
    }
  });

  it('filters by runway and reports not in cache when none matches', () => {
    const db = setup({ types: [4] });
    const r = buildRouteGeometry(plan({ approach_runway: '10' }), db);
    expect(r.unresolved).toEqual([{ kind: 'approach', name: 'ZZFAF', reason: 'procedure not in cache' }]);
    expect(buildRouteGeometry(plan({ approach_runway: 'XY' }), db).unresolved)
      .toEqual([{ kind: 'approach', name: 'ZZFAF', reason: 'unparseable runway' }]);
  });
});

describe('speed limit sentinel', () => {
  it('maps negative and non-finite speed limits to null and keeps real ones', () => {
    const db = fresh();
    airport(db, 'TSTA');
    procedure(db, 'TSTA', 'SID', 'ZZSID1', [10, 0], [{
      role: 'runway', rwy: [10, 0],
      legs: [
        { t: 4, lat: 11, lon: 21, ident: 'ZZA', spd: -1 },
        { t: 4, lat: 11.1, lon: 21.1, ident: 'ZZB', spd: 45 },
        { t: 4, lat: 11.2, lon: 21.2, ident: 'ZZC', spd: 0 },
        { t: 4, lat: 11.3, lon: 21.3, ident: 'ZZD' },
        { t: 4, lat: 11.4, lon: 21.4, ident: 'ZZE', spd: Infinity },
      ],
    }]);
    const pts = buildRouteGeometry(planned({ sid_name: 'ZZSID1', sid_runway: '10' }), db).sid.points;
    expect(pts.map((p) => p.speedLimitKt)).toEqual([null, 45, 0, null, null]);
  });
});

describe('a same-ident VFR waypoint or station beside an airway navaid', () => {
  // About 300 m north of a point, in degrees of latitude.
  const NEAR = 0.0027;
  const FAR = 3; // about 330 km

  function navaid(db: Database.Database, kind: 'V' | 'N', ident: string, region: string, lat: number, lon: number): string {
    db.prepare('INSERT INTO nav_navaid (kind, ident, region, lat, lon, rev) VALUES (?, ?, ?, ?, ?, 1)').run(kind, ident, region, lat, lon);
    return wptKey(ident, region, lat, lon);
  }

  const node = (key: string, ident: string, lat: number, lon: number) => ({ key, ident, lat, lon });

  /** FROMM and MIDDL are fixes; T100 runs FROMM, MIDDL, then `end`. */
  function airwayTo(db: Database.Database, end: { key: string; ident: string; lat: number; lon: number }): void {
    const from = node(waypoint(db, 'FROMM', 'ZZ', 10, 20.9), 'FROMM', 10, 20.9);
    const mid = node(waypoint(db, 'MIDDL', 'ZZ', 10, 21), 'MIDDL', 10, 21);
    airwayLeg(db, 'T100', from, mid);
    airwayLeg(db, 'T100', mid, end);
  }

  function plan(ident: string, lat: number, lon: number, region: string | null = 'ZZ'): PlannedLegWithChildren {
    return planned({
      waypoints: [
        wpt(1, 'TSTA', 10, 20, { type: 'AIRPORT' }),
        wpt(2, 'FROMM', 10, 20.9, { region: 'ZZ' }),
        wpt(3, ident, lat, lon, { region, airway: 'T100' }),
        wpt(4, 'TSTB', 10, 22, { type: 'AIRPORT' }),
      ],
    });
  }

  const expandedThrough = (r: ReturnType<typeof buildRouteGeometry>, ident: string): boolean =>
    r.unresolved.length === 0 && r.enroute.points.map((p) => p.ident).join() === `TSTA,FROMM,MIDDL,${ident},TSTB`;

  it('resolves to the VOR when the same-region VFR waypoint is hundreds of km away', () => {
    const db = fresh();
    waypoint(db, 'SHARE', 'ZZ', 10 + FAR, 21.5);
    const vor = navaid(db, 'V', 'SHARE', 'ZZ', 10, 21.5);
    airwayTo(db, node(vor, 'SHARE', 10, 21.5));
    const r = buildRouteGeometry(plan('SHARE', 10, 21.5), db);
    expect(expandedThrough(r, 'SHARE')).toBe(true);
    expect(resolvePlannedKey(db, plan('SHARE', 10, 21.5).waypoints[2], { lat: 10, lon: 21 })).toEqual({
      key: vor, lat: 10, lon: 21.5, viaEndpoint: false,
    });
  });

  it('prefers the VOR when the plan names no region', () => {
    const db = fresh();
    waypoint(db, 'SHARE', 'ZZ', 10 + FAR, 21.5);
    const vor = navaid(db, 'V', 'SHARE', 'ZZ', 10, 21.5);
    airwayTo(db, node(vor, 'SHARE', 10, 21.5));
    expect(expandedThrough(buildRouteGeometry(plan('SHARE', 10, 21.5, null), db), 'SHARE')).toBe(true);
  });

  it('resolves to the VOR when both are inside the tolerance and the VOR is the airway endpoint', () => {
    const db = fresh();
    waypoint(db, 'SHARE', 'ZZ', 10 + NEAR, 21.5);
    const vor = navaid(db, 'V', 'SHARE', 'ZZ', 10, 21.5);
    airwayTo(db, node(vor, 'SHARE', 10, 21.5));
    const wp = plan('SHARE', 10, 21.5).waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })?.key).toBe(vor);
    expect(expandedThrough(buildRouteGeometry(plan('SHARE', 10, 21.5), db), 'SHARE')).toBe(true);
  });

  it('takes the navaid over a fix inside the tolerance when neither is an airway endpoint, even when the fix is nearer', () => {
    const db = fresh();
    const fix = waypoint(db, 'SHARE', 'ZZ', 10, 21.5);
    const vor = navaid(db, 'V', 'SHARE', 'ZZ', 10 + NEAR, 21.5);
    const wp = plan('SHARE', 10, 21.5).waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })?.key).toBe(vor);
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })?.key).not.toBe(fix);
  });

  it('keeps a fix that is the airway endpoint over a VOR 300 m away whose key does not join', () => {
    const db = fresh();
    const fix = waypoint(db, 'PHRXX', 'ZZ', 10, 21.5);
    const vor = navaid(db, 'V', 'PHRXX', 'ZZ', 10 + NEAR, 21.5);
    // The keys are more than ten units apart, so the airway endpoint cannot be read as the VOR.
    expect(Math.abs(Number(vor.split('|')[2]) - Number(fix.split('|')[2]))).toBeGreaterThan(10);
    airwayTo(db, node(fix, 'PHRXX', 10, 21.5));
    const wp = plan('PHRXX', 10, 21.5).waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })).toEqual({ key: fix, lat: 10, lon: 21.5, viaEndpoint: false });
    expect(expandedThrough(buildRouteGeometry(plan('PHRXX', 10, 21.5), db), 'PHRXX')).toBe(true);
  });

  it('keeps an airway endpoint that sits to the far side of the leg: the end key is matched in both directions', () => {
    const db = fresh();
    const fix = waypoint(db, 'PHRXX', 'ZZ', 10, 21.5);
    navaid(db, 'V', 'PHRXX', 'ZZ', 10 + NEAR, 21.5);
    const mid = node(waypoint(db, 'MIDDL', 'ZZ', 10, 21), 'MIDDL', 10, 21);
    // The fix is the start of the leg here, not its end.
    airwayLeg(db, 'T100', node(fix, 'PHRXX', 10, 21.5), mid);
    expect(resolvePlannedKey(db, plan('PHRXX', 10, 21.5).waypoints[2], { lat: 10, lon: 21 })?.key).toBe(fix);
  });

  it('yields a far nearest candidate to an airway endpoint inside the tolerance, such as a losing NDB', () => {
    const db = fresh();
    // nav_navaid holds one row per key: the other NDB of this ident and region lost, but the airway
    // still ends at its own key, 50 km from the winner.
    navaid(db, 'N', 'LOSER', 'ZZ', 10.5, 21.5);
    const loser = wptKey('LOSER', 'ZZ', 10, 21.5);
    airwayTo(db, node(loser, 'LOSER', 10, 21.5));
    const wp = plan('LOSER', 10, 21.5).waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })).toEqual({ key: loser, lat: 10, lon: 21.5, viaEndpoint: true });
    expect(expandedThrough(buildRouteGeometry(plan('LOSER', 10, 21.5), db), 'LOSER')).toBe(true);
  });

  it('still reports a disagreement when the nearest candidate is far and no airway endpoint is near the plan', () => {
    const db = fresh();
    navaid(db, 'V', 'SHARE', 'ZZ', 10 + FAR, 21.5);
    const r = buildRouteGeometry(plan('SHARE', 10, 21.5), db);
    expect(r.unresolved).toContainEqual({ kind: 'waypoint', name: 'SHARE', reason: 'position disagrees with cache' });
  });

  it('behaves as before when no navaid shares the ident and the nearest fix is inside the tolerance', () => {
    const db = fresh();
    const near = waypoint(db, 'ONLYW', 'ZZ', 10 + NEAR / 2, 21.5);
    waypoint(db, 'ONLYW', 'QQ', 10, 21.5);
    const wp = plan('ONLYW', 10, 21.5).waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })?.key).toBe(near);
    // Region-less: the nearest of every fix with the ident, as before.
    const bare = resolvePlannedKey(db, plan('ONLYW', 10, 21.5, null).waypoints[2], { lat: 10, lon: 21 });
    expect(bare?.lat).toBe(10);
  });

  it('falls back to every row with the ident when the plan region has none', () => {
    const db = fresh();
    const vor = navaid(db, 'V', 'SHARE', 'QQ', 10, 21.5);
    const wp = plan('SHARE', 10, 21.5, 'ZZ').waypoints[2];
    expect(resolvePlannedKey(db, wp, { lat: 10, lon: 21 })?.key).toBe(vor);
  });

  it('ignores a navaid row with no position', () => {
    const db = fresh();
    db.prepare("INSERT INTO nav_navaid (kind, ident, region, rev) VALUES ('V', 'SHARE', 'ZZ', 1)").run();
    expect(resolvePlannedKey(db, plan('SHARE', 10, 21.5).waypoints[2], { lat: 10, lon: 21 })).toBeNull();
  });

  it('reads the endpoint probe through the key indexes', () => {
    const db = fresh();
    const plans: string[] = [];
    for (const sql of ['SELECT 1 FROM nav_airway_leg WHERE from_key = @k UNION ALL SELECT 1 FROM nav_airway_leg WHERE to_key = @k LIMIT 1']) {
      plans.push((db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ k: 'x' }) as { detail: string }[]).map((r) => r.detail).join('\n'));
    }
    expect(plans[0]).toContain('nav_airway_leg_from');
    expect(plans[0]).toContain('nav_airway_leg_to');
    expect(plans[0]).not.toMatch(/SCAN nav_airway_leg/);
  });
});

describe('approach type tables', () => {
  it('keeps the plan-side tables exactly as the lookup has always held them', () => {
    expect(ARINC_LETTER_TYPE).toEqual({ I: 4, L: 5, B: 11, R: 10, H: 10, P: 1, V: 2, T: 2, D: 8, N: 3, Q: 9, X: 7, S: 6, U: 6 });
    expect(PLAN_APPROACH_TYPE_NAME).toEqual({
      ILS: 4, LOC: 5, LDA: 7, VOR: 2, VORDME: 8, NDB: 3, NDBDME: 9, RNAV: 10, GPS: 1,
      'LOC-BC': 11, LOCALIZER_BACK_COURSE: 11, SDF: 6,
    });
  });

  it('types an imported approach by its ARINC letter first, upper-cased', () => {
    expect(approachTypeOf('I18L', 'GPS', '18L')).toBe(4);
    expect(approachTypeOf('r18', 'ILS', '18')).toBe(10);
    expect(approachTypeOf('S24', 'VORDME', '24')).toBe(6);
    expect(approachTypeOf('U24', null, '24')).toBe(6);
    expect(approachTypeOf('D24', 'VOR', '24')).toBe(8);
  });

  it('treats a circling VOR/DME with no runway as a VOR approach, and otherwise reads the atools type', () => {
    expect(approachTypeOf('CVDM', 'VORDME', null)).toBe(2);
    expect(approachTypeOf(null, 'VORDME', null)).toBe(2);
    expect(approachTypeOf(null, 'VORDME', '24')).toBe(8);
    expect(approachTypeOf('', 'TCN', '24')).toBe(2);
    expect(approachTypeOf('Z24', 'LOCB', '24')).toBe(11);
    expect(approachTypeOf(null, 'GNSS', '24')).toBe(0);
    expect(ATOOLS_APPROACH_TYPE.IGS).toBe(4);
  });

  it('answers 0 for anything unknown, including names that exist on every object', () => {
    expect(approachTypeOf(null, null, null)).toBe(0);
    expect(approachTypeOf('', '', '')).toBe(0);
    expect(approachTypeOf('?', 'WHAT', '24')).toBe(0);
    expect(approachTypeOf(null, 'toString', '24')).toBe(0);
    expect(approachTypeOf(null, 'constructor', '24')).toBe(0);
    expect(approachTypeOf('__proto__', null, null)).toBe(0);
  });
});

