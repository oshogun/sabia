// ── Little Navmap source index ───────────────────────────────────────────────
//
// In-memory maps over the atools tables, built once per import and shared by
// every converter through LnmContext. They answer the questions that cut across
// tables: which airport row owns a duplicated ident, which navaid row keeps a
// contested (kind, ident, region) key, which candidates a leg's fix could be.
// Lists are filled in primary-key order, so every "first" below is the lowest
// id and every result is the same on each run.

import type Database from 'better-sqlite3';
import { normaliseDataSource } from './flavour';
import type {
  LnmFlavour, NavaidWinner, SourceIndex, SrcAirport, SrcIls, SrcNdb, SrcRunwayEnd, SrcVor, SrcWaypoint,
} from './types';
import { stripTrueSuffix } from './units';

const EMPTY: readonly never[] = [];

const key = (ident: string, region: string): string => `${ident}|${region}`;

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

interface AirportRow {
  airport_id: number; ident: string; region: string; laty: number; lonx: number; mag_var: number; weight: number;
}

/**
 * The owner of an ident is the row with the most content (runways, frequencies
 * and approaches together); a tie goes to the lowest airport_id, which the
 * ascending scan gives for free.
 */
function indexAirports(src: Database.Database): {
  byId: Map<number, SrcAirport>; owners: Map<string, SrcAirport>;
} {
  const byId = new Map<number, SrcAirport>();
  const owners = new Map<string, SrcAirport>();
  const weights = new Map<string, number>();
  const rows = src.prepare(
    `SELECT airport_id, ident, COALESCE(region, '') AS region, laty, lonx, mag_var,
            num_runways + num_com + num_approach AS weight
       FROM airport ORDER BY airport_id`,
  );
  for (const r of rows.iterate() as IterableIterator<AirportRow>) {
    const airport: SrcAirport = {
      id: r.airport_id, ident: r.ident, region: r.region, lat: r.laty, lon: r.lonx,
      magvarEast: r.mag_var, isOwner: false,
    };
    byId.set(airport.id, airport);
    const best = weights.get(airport.ident);
    if (best === undefined || r.weight > best) {
      weights.set(airport.ident, r.weight);
      owners.set(airport.ident, airport);
    }
  }
  for (const owner of owners.values()) owner.isOwner = true;
  return { byId, owners };
}

/**
 * Ends of the owner airports' runways by airport ident and end name. On a repeated name
 * the highest runway_id wins: it is the later scenery layer, the one the simulator shows.
 */
function indexRunwayEnds(src: Database.Database, byId: Map<number, SrcAirport>): Map<string, SrcRunwayEnd> {
  const ends = new Map<string, SrcRunwayEnd>();
  const rows = src.prepare(
    `SELECT r.airport_id AS airport_id, e.runway_end_id AS id, e.name AS name,
            e.laty AS lat, e.lonx AS lon, e.heading AS headingTrue, e.offset_threshold AS offsetThresholdFt
       FROM runway r
       JOIN runway_end e ON e.runway_end_id IN (r.primary_end_id, r.secondary_end_id)
      ORDER BY r.runway_id, e.runway_end_id`,
  );
  for (const r of rows.iterate() as IterableIterator<SrcRunwayEnd & { airport_id: number }>) {
    const airport = byId.get(r.airport_id);
    if (!airport || !airport.isOwner) continue;
    ends.set(key(airport.ident, stripTrueSuffix(r.name)), {
      id: r.id, name: r.name, lat: r.lat, lon: r.lon, headingTrue: r.headingTrue, offsetThresholdFt: r.offsetThresholdFt,
    });
  }
  return ends;
}

interface StationRow {
  id: number; ident: string; region: string; airportId: number | null; lat: number; lon: number;
}

/** VOR and NDB rows by (ident, region); rows without an ident cannot be keyed and are left out. */
function indexStations<T extends SrcVor | SrcNdb>(src: Database.Database, table: 'vor' | 'ndb'): Map<string, T[]> {
  const map = new Map<string, T[]>();
  const rows = src.prepare(
    `SELECT ${table}_id AS id, ident, COALESCE(region, '') AS region, airport_id AS airportId, laty AS lat, lonx AS lon
       FROM ${table} WHERE ident IS NOT NULL AND ident <> '' ORDER BY ${table}_id`,
  );
  for (const r of rows.iterate() as IterableIterator<StationRow>) push(map, key(r.ident, r.region), r as T);
  return map;
}

interface IlsRow {
  id: number; ident: string; region: string | null; airportIdent: string | null;
  lat: number; lon: number; locRunwayEndId: number | null;
}

/** GLS rows (type G) carry a channel in the frequency column and are not kept. */
function indexIls(src: Database.Database): Map<string, SrcIls[]> {
  const map = new Map<string, SrcIls[]>();
  const rows = src.prepare(
    `SELECT ils_id AS id, ident, region, loc_airport_ident AS airportIdent, laty AS lat, lonx AS lon,
            loc_runway_end_id AS locRunwayEndId
       FROM ils WHERE ident IS NOT NULL AND ident <> '' AND COALESCE(type, '') <> 'G' ORDER BY ils_id`,
  );
  for (const r of rows.iterate() as IterableIterator<IlsRow>) {
    const fromAirport = r.airportIdent ? r.airportIdent.slice(0, 2) : '';
    const derivedRegion = r.region ? r.region : fromAirport !== '' ? fromAirport : null;
    push(map, r.ident, { ...r, derivedRegion });
  }
  return map;
}

interface WaypointRow {
  id: number; type: string | null; ident: string; region: string; airportId: number | null; lat: number; lon: number;
}

/** Waypoints that are not LNM's artificial copies of VORs and NDBs (type V and N). */
function indexWaypoints(
  src: Database.Database, byId: Map<number, SrcAirport>,
): { byKey: Map<string, SrcWaypoint[]>; byIdent: Map<string, SrcWaypoint[]> } {
  const byKey = new Map<string, SrcWaypoint[]>();
  const byIdent = new Map<string, SrcWaypoint[]>();
  const rows = src.prepare(
    `SELECT waypoint_id AS id, type, ident, COALESCE(region, '') AS region, airport_id AS airportId, laty AS lat, lonx AS lon
       FROM waypoint WHERE ident <> '' AND (type IS NULL OR type NOT IN ('V', 'N')) ORDER BY waypoint_id`,
  );
  for (const r of rows.iterate() as IterableIterator<WaypointRow>) {
    const waypoint: SrcWaypoint = {
      id: r.id, ident: r.ident, region: r.region, lat: r.lat, lon: r.lon, airportId: r.airportId,
      airportIdent: r.airportId === null ? null : byId.get(r.airportId)?.ident ?? null,
    };
    push(byKey, key(r.ident, r.region), waypoint);
    push(byIdent, r.ident, waypoint);
  }
  return { byKey, byIdent };
}

/**
 * vor_ids and ndb_ids named by an artificial V / N waypoint row that an airway uses as an endpoint.
 * The two id spaces overlap, so each is gated by the waypoint's type.
 */
function indexEndpointNavaids(src: Database.Database): { vor: Set<number>; ndb: Set<number> } {
  const vor = new Set<number>();
  const ndb = new Set<number>();
  const rows = src.prepare(
    `SELECT DISTINCT type, nav_id AS id FROM waypoint
      WHERE type IN ('V', 'N') AND nav_id IS NOT NULL
        AND waypoint_id IN (SELECT from_waypoint_id FROM airway UNION SELECT to_waypoint_id FROM airway)`,
  );
  for (const r of rows.iterate() as IterableIterator<{ type: 'V' | 'N'; id: number }>) {
    (r.type === 'V' ? vor : ndb).add(r.id);
  }
  return { vor, ndb };
}

export function buildSourceIndex(src: Database.Database, flavour: LnmFlavour): SourceIndex {
  const declared = src.prepare('SELECT data_source FROM metadata LIMIT 1').pluck().get() as string | null | undefined;
  const provider = normaliseDataSource(declared) ?? flavour;

  const { byId, owners } = indexAirports(src);
  const runwayEnds = indexRunwayEnds(src, byId);
  const vors = indexStations<SrcVor>(src, 'vor');
  const ndbs = indexStations<SrcNdb>(src, 'ndb');
  const ils = indexIls(src);
  const { byKey: waypointsByKey, byIdent: waypointsByIdent } = indexWaypoints(src, byId);
  const endpoints = indexEndpointNavaids(src);

  /**
   * An NDB that is an airway endpoint beats one that is not, then one with no
   * airport beats one tied to an airport, then the lowest ndb_id.
   */
  const ndbRank = (n: SrcNdb): [number, number, number] => [
    endpoints.ndb.has(n.id) ? 0 : 1, n.airportId === null ? 0 : 1, n.id,
  ];
  const ndbBefore = (a: SrcNdb, b: SrcNdb): boolean => {
    const [ra, rb] = [ndbRank(a), ndbRank(b)];
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return false;
  };

  return {
    flavour,
    provider,
    airportOwnerId: ident => owners.get(ident)?.id,
    airportById: id => byId.get(id),
    airportByIdent: ident => owners.get(ident),
    vors: (ident, region) => vors.get(key(ident, region)) ?? EMPTY,
    ndbs: (ident, region) => ndbs.get(key(ident, region)) ?? EMPTY,
    ilsByIdent: ident => ils.get(ident) ?? EMPTY,
    ilsRegion: i => i.derivedRegion,
    waypoints: (ident, region) => waypointsByKey.get(key(ident, region)) ?? EMPTY,
    waypointsByIdent: ident => waypointsByIdent.get(ident) ?? EMPTY,
    runwayEnd: (airportIdent, endName) => runwayEnds.get(key(airportIdent, stripTrueSuffix(endName))),
    navaidWinner(kind, ident, region): NavaidWinner | undefined {
      if (kind === 'V') {
        // A VOR beats any ILS; among either, the lowest id.
        const stations = vors.get(key(ident, region)) ?? EMPTY;
        const localizers = (ils.get(ident) ?? EMPTY).filter(i => i.derivedRegion === region);
        const total = stations.length + localizers.length;
        if (stations.length > 0) return { table: 'vor', id: stations[0].id, ambiguous: total > 1 };
        if (localizers.length > 0) return { table: 'ils', id: localizers[0].id, ambiguous: total > 1 };
        return undefined;
      }
      const candidates = ndbs.get(key(ident, region)) ?? EMPTY;
      if (candidates.length === 0) return undefined;
      let best = candidates[0];
      for (const c of candidates) if (ndbBefore(c, best)) best = c;
      return { table: 'ndb', id: best.id, ambiguous: candidates.length > 1 };
    },
    isAirwayEndpointNavaid: (table, id) => (table === 'vor' ? endpoints.vor : endpoints.ndb).has(id),
  };
}
