// ── Little Navmap converter: procedures, transitions, legs ───────────────────
//
// Fills nav_procedure, nav_procedure_transition and nav_procedure_leg from the
// atools approach, approach_leg, transition and transition_leg tables.
//
// atools keeps SIDs, STARs and approaches in one table. A GPS row with the
// overlay flag and suffix D is a SID, with suffix A a STAR, anything else an
// approach. A SID or STAR is one procedure per name with the legs split into a
// common part and one runway transition per runway; an approach is one
// procedure per row, keyed with the sidecar's own collision rule.
//
// Leg tables hold a million rows, so procedures are converted in batches of
// whole airports: each batch costs one ordered scan of the three child tables
// and keeps only the converted rows of its own airports.
//
// Every leg is converted before any grouping or comparison, so every
// comparison below is on replica values, and the counters of unresolved fixes
// are counted once per source leg row whatever happens to its procedure later.

import type Database from 'better-sqlite3';
import { haversineNm } from '../../geo';
import { approachTypeOf } from '../approachTypes';
import { dest } from '../geometry';
import { assignProcKeys, parseRunway, procKey, transKey, type ProcKeyRecord } from '../keys';
import { runwayDesignation } from '../runwayDesignation';
import type { TransitionRole } from '../wire';
import type { ConverterStats, LnmContext, LnmConverter, LnmFlavour, SourceIndex, SrcAirport, SrcIls } from './types';
import { ftToM, nmToM, norm360, stripTrueSuffix, verticalAngleToReplica } from './units';

/** Approach rows after which a batch of whole airports is closed. */
export const PROCEDURE_BATCH_APPROACHES = 20_000;

/** A waypoint of the wrong region is accepted when it is the only one this close to the airport. */
export const REGION_RELAXED_CAP_NM = 60;

/** Rows per transaction. */
export const PROCEDURE_CHUNK_ROWS = 50_000;

// ── Encodings ────────────────────────────────────────────────────────────────

type Kind = 'SID' | 'STAR' | 'APPROACH';
type Table = 'approach' | 'transition';

/** The simulator's leg-type enumeration; a code not listed is 0 (unknown). */
const LEG_TYPE: Readonly<Record<string, number>> = {
  AF: 1, CA: 2, CD: 3, CF: 4, CI: 5, CR: 6, DF: 7, FA: 8, FC: 9, FD: 10, FM: 11, HA: 12,
  HF: 13, HM: 14, IF: 15, PI: 16, RF: 17, TF: 18, VA: 19, VD: 20, VI: 21, VM: 22, VR: 23,
};
const LEG_AF = 1;
const LEG_IF = 15;

/** The legs that end on a coordinate; the others end on a heading, an altitude or a radial. */
const DRAWABLE_LEG_CODES: ReadonlySet<string> = new Set(['AF', 'CF', 'DF', 'HF', 'IF', 'PI', 'RF', 'TF']);

const ALT_DESC: Readonly<Record<string, number>> = { A: 1, '+': 2, '-': 3, B: 4 };
const TURN: Readonly<Record<string, number>> = { L: 1, R: 2, B: 3 };

/**
 * The fix types the replica stores. atools marks terminal waypoints and
 * terminal NDBs TW and TN; the replica holds only the plain letter, the
 * airport being implied. MSFS names an ILS L.
 */
const FIX_LETTER: Readonly<Record<string, string>> = { W: 'W', TW: 'W', V: 'V', N: 'N', TN: 'N', R: 'R', A: 'A', L: 'V' };

/** The source fix types the unresolved counters tell apart; every other code is counted as 'other'. */
const COUNTED_FIX_TYPES: ReadonlySet<string> = new Set(['R', 'W', 'TW', 'V', 'N', 'TN', 'L']);

const TRANSITION_TYPE: Readonly<Record<string, number>> = { F: 1, D: 2 };

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface LegRow {
  leg_type: number;
  fix_ident: string | null; fix_region: string | null; fix_type: string | null;
  fix_lat: number | null; fix_lon: number | null;
  origin_ident: string | null; origin_region: string | null; origin_type: string | null;
  origin_lat: number | null; origin_lon: number | null;
  arc_center_ident: string | null; arc_center_region: string | null; arc_center_type: string | null;
  arc_center_lat: number | null; arc_center_lon: number | null;
  fly_over: number; turn_direction: number;
  course_deg: number | null; true_degree: number;
  theta_deg: number | null; rho_m: number | null;
  distance_minute: number | null; route_distance_m: number | null;
  alt_desc: number; altitude1_m: number | null; altitude2_m: number | null;
  speed_limit_kt: number | null; vertical_angle_deg: number | null;
  is_iaf: number; is_if: number; is_faf: number; is_map: number;
}

/**
 * The leg columns, in table order. The three altitude columns of the fix, the
 * origin and the arc centre are left out of the insert and stay NULL.
 */
const LEG_COLUMNS: readonly (keyof LegRow)[] = [
  'leg_type', 'fix_ident', 'fix_region', 'fix_type', 'fix_lat', 'fix_lon',
  'origin_ident', 'origin_region', 'origin_type', 'origin_lat', 'origin_lon',
  'arc_center_ident', 'arc_center_region', 'arc_center_type', 'arc_center_lat', 'arc_center_lon',
  'fly_over', 'turn_direction', 'course_deg', 'true_degree', 'theta_deg', 'rho_m',
  'distance_minute', 'route_distance_m', 'alt_desc', 'altitude1_m', 'altitude2_m',
  'speed_limit_kt', 'vertical_angle_deg', 'is_iaf', 'is_if', 'is_faf', 'is_map',
];

/** The source-derived columns two legs must share to count as the same leg. */
const SIGNATURE_COLUMNS: readonly (keyof LegRow)[] = [
  'leg_type', 'fix_ident', 'fix_region', 'fix_type', 'origin_ident', 'origin_region', 'origin_type',
  'arc_center_ident', 'arc_center_region', 'fly_over', 'turn_direction', 'course_deg', 'true_degree',
  'theta_deg', 'rho_m', 'distance_minute', 'route_distance_m', 'alt_desc', 'altitude1_m', 'altitude2_m',
  'speed_limit_kt', 'vertical_angle_deg',
];

/**
 * Two legs are the same leg when these columns agree. Resolved positions and
 * the positional flags are left out on purpose: a position can depend on the
 * previous leg (the arc-centre choice), which differs between procedures that
 * share a leg, and the flags follow a leg's place, not its content.
 */
export function legSignature(leg: LegRow): string {
  return JSON.stringify(SIGNATURE_COLUMNS.map(c => leg[c]));
}

interface ConvertedLeg {
  row: LegRow;
  /** arinc_descr_code as stored; only the IAF flag reads it. */
  descr: string | null;
  signature: string | null;
}

const signatureOf = (leg: ConvertedLeg): string => (leg.signature ??= legSignature(leg.row));

interface ProcedureRow {
  proc_key: string; airport_ident: string; kind: Kind; name: string;
  runway_number: number | null; runway_designator: number | null; approach_type: number | null; suffix: string | null;
  faf_ident: string | null; faf_region: string | null; faf_alt_m: number | null; faf_heading_deg: number | null;
  missed_alt_m: number | null;
  has_lnav: null; has_lnavvnav: null; has_lp: null; has_lpv: null;
  n_transitions: number | null; n_runway_transitions: number | null; n_enroute_transitions: number | null;
  rev: 1;
}

interface TransitionRow {
  trans_key: string; proc_key: string; role: TransitionRole; name: string;
  runway_number: number | null; runway_designator: number | null; trans_type: number | null;
  iaf_ident: string | null; iaf_region: string | null; iaf_alt_m: number | null;
  dme_arc_ident: string | null; dme_arc_region: string | null;
  dme_arc_radial_deg: number | null; dme_arc_distance_m: number | null;
  n_legs: number; rev: 1;
}

interface TransitionOut { row: TransitionRow; legs: LegRow[] }
interface ProcedureOut { row: ProcedureRow; transitions: TransitionOut[] }

const PROCEDURE_COLUMNS: readonly (keyof ProcedureRow)[] = [
  'proc_key', 'airport_ident', 'kind', 'name', 'runway_number', 'runway_designator', 'approach_type', 'suffix',
  'faf_ident', 'faf_region', 'faf_alt_m', 'faf_heading_deg', 'missed_alt_m', 'has_lnav', 'has_lnavvnav', 'has_lp',
  'has_lpv', 'n_transitions', 'n_runway_transitions', 'n_enroute_transitions', 'rev',
];
const TRANSITION_COLUMNS: readonly (keyof TransitionRow)[] = [
  'trans_key', 'proc_key', 'role', 'name', 'runway_number', 'runway_designator', 'trans_type', 'iaf_ident',
  'iaf_region', 'iaf_alt_m', 'dme_arc_ident', 'dme_arc_region', 'dme_arc_radial_deg', 'dme_arc_distance_m',
  'n_legs', 'rev',
];

// ── Source rows ──────────────────────────────────────────────────────────────

interface SrcLegRow {
  type: string | null; arinc_descr_code: string | null; alt_descriptor: string | null; turn_direction: string | null;
  fix_type: string | null; fix_ident: string | null; fix_region: string | null; fix_airport_ident: string | null;
  fix_lonx: number | null; fix_laty: number | null;
  recommended_fix_type: string | null; recommended_fix_ident: string | null; recommended_fix_region: string | null;
  recommended_fix_lonx: number | null; recommended_fix_laty: number | null;
  is_flyover: number; is_true_course: number;
  course: number | null; distance: number | null; time: number | null; theta: number | null; rho: number | null;
  altitude1: number | null; altitude2: number | null; speed_limit: number | null; vertical_angle: number | null;
}
interface SrcApproachLeg extends SrcLegRow { approach_id: number; is_missed: number }
interface SrcTransitionLeg extends SrcLegRow { transition_id: number }

const LEG_SOURCE_COLUMNS = `type, arinc_descr_code, alt_descriptor, turn_direction, fix_type, fix_ident, fix_region,
  fix_airport_ident, fix_lonx, fix_laty, recommended_fix_type, recommended_fix_ident, recommended_fix_region,
  recommended_fix_lonx, recommended_fix_laty, is_flyover, is_true_course, course, distance, time, theta, rho,
  altitude1, altitude2, speed_limit, vertical_angle`;

interface SrcApproachRow {
  approach_id: number; airport_id: number | null; arinc_name: string | null; runway_name: string | null;
  type: string; suffix: string | null; has_gps_overlay: number;
  fix_ident: string | null; fix_region: string | null;
  altitude: number | null; heading: number | null; missed_altitude: number | null;
}

interface Approach {
  id: number;
  airport: SrcAirport;
  kind: Kind;
  arincName: string | null;
  runwayName: string | null;
  type: string;
  suffix: string | null;
  /** The procedure name of a SID or STAR; the final-approach fix of an approach. */
  fixIdent: string | null;
  fixRegion: string | null;
  altitude: number | null;
  heading: number | null;
  missedAltitude: number | null;
}

interface SrcTransitionRow {
  transition_id: number; approach_id: number; type: string | null;
  fix_ident: string | null; fix_region: string | null; altitude: number | null;
}

interface TransitionData {
  id: number;
  type: string | null;
  fixIdent: string | null;
  fixRegion: string | null;
  altitude: number | null;
  legs: ConvertedLeg[];
}

/** The converted rows of one batch of airports, by approach id. */
interface BatchData {
  finalLegs: Map<number, ConvertedLeg[]>;
  missedLegs: Map<number, ConvertedLeg[]>;
  transitions: Map<number, TransitionData[]>;
}

// ── Counters ─────────────────────────────────────────────────────────────────

type Counters = Record<string, number>;

function bump(counters: Counters, key: string, n = 1): void {
  counters[key] = (counters[key] ?? 0) + n;
}

// ── Fix resolution ───────────────────────────────────────────────────────────

interface Pos { lat: number; lon: number }
type HowResolved = 'plain' | 'airportOwned' | 'regionRelaxed';
interface Resolved { pos: Pos; how: HowResolved }

const pairOf = (lat: number | null, lon: number | null): Pos | null =>
  lat != null && lon != null ? { lat, lon } : null;

/** Looks fixes up in the source index, for the legs the source gives no coordinate. */
class FixResolver {
  constructor(private readonly index: SourceIndex) {}

  /** Nearest to the airport; a tie goes to the lowest source id. */
  private nearest<T extends Pos & { id: number }>(list: readonly T[], airport: Pos): T {
    if (list.length === 1) return list[0];
    let best = list[0];
    let bestDistance = haversineNm(airport.lat, airport.lon, best.lat, best.lon);
    for (let i = 1; i < list.length; i++) {
      const c = list[i];
      const d = haversineNm(airport.lat, airport.lon, c.lat, c.lon);
      if (d < bestDistance || (d === bestDistance && c.id < best.id)) {
        best = c;
        bestDistance = d;
      }
    }
    return best;
  }

  private airportIdentOf(airportId: number | null): string | null {
    return airportId === null ? null : this.index.airportById(airportId)?.ident ?? null;
  }

  /**
   * `fallbacks` adds the steps for a leg's own fix: a terminal waypoint's
   * airport-owned match in any region, a one-letter region match, and the
   * unique waypoint of any region near the airport.
   */
  private waypoint(
    ident: string, region: string, terminal: boolean, owner: string, airport: Pos, fallbacks: boolean,
  ): Resolved | null {
    const exact = this.index.waypoints(ident, region);
    if (terminal) {
      const ownedExact = exact.filter(w => w.airportIdent === owner);
      if (ownedExact.length > 0) return { pos: this.nearest(ownedExact, airport), how: 'plain' };
      if (fallbacks) {
        const owned = this.index.waypointsByIdent(ident).filter(w => w.airportIdent === owner);
        if (owned.length > 0) return { pos: this.nearest(owned, airport), how: 'airportOwned' };
      }
      if (exact.length > 0) return { pos: this.nearest(exact, airport), how: 'plain' };
    } else if (exact.length > 0) {
      const free = exact.filter(w => w.airportId === null);
      return { pos: this.nearest(free.length > 0 ? free : exact, airport), how: 'plain' };
    }
    if (!fallbacks) return null;

    const sameIdent = this.index.waypointsByIdent(ident);
    if (region.length === 1) {
      const prefixed = sameIdent.filter(w => w.region.startsWith(region));
      if (prefixed.length > 0) return { pos: this.nearest(prefixed, airport), how: 'plain' };
    }
    const near = sameIdent.filter(w => haversineNm(airport.lat, airport.lon, w.lat, w.lon) <= REGION_RELAXED_CAP_NM);
    return near.length === 1 ? { pos: near[0], how: 'regionRelaxed' } : null;
  }

  private vor(ident: string, region: string, airport: SrcAirport): Pos | null {
    const stations = this.index.vors(ident, region);
    if (stations.length > 0) return this.nearest(stations, airport);
    const localizers = this.index.ilsByIdent(ident).filter(i => i.airportIdent === airport.ident);
    return localizers.length > 0 ? this.nearest(localizers, airport) : null;
  }

  private ndb(ident: string, region: string, terminal: boolean, owner: string, airport: Pos): Pos | null {
    const all = this.index.ndbs(ident, region);
    if (all.length === 0) return null;
    if (terminal) {
      const atOwner = all.filter(n => this.airportIdentOf(n.airportId) === owner);
      return this.nearest(atOwner.length > 0 ? atOwner : all, airport);
    }
    const free = all.filter(n => n.airportId === null);
    return this.nearest(free.length > 0 ? free : all, airport);
  }

  /** The landing threshold: the end's position moved along its heading by the displaced distance. */
  private runwayThreshold(ident: string, owner: string): Pos | null {
    const end = this.index.runwayEnd(owner, ident.startsWith('RW') ? ident.slice(2) : ident);
    if (!end) return null;
    const displaced = ftToM(end.offsetThresholdFt) ?? 0;
    return displaced === 0 ? { lat: end.lat, lon: end.lon } : dest(end.lat, end.lon, end.headingTrue, displaced);
  }

  /** The ILS with that ident at the procedure's airport, else the nearest one anywhere. */
  pickIls(ident: string, airport: SrcAirport): SrcIls | undefined {
    const all = this.index.ilsByIdent(ident);
    if (all.length === 0) return undefined;
    const here = all.filter(i => i.airportIdent === airport.ident);
    return this.nearest(here.length > 0 ? here : all, airport);
  }

  /** `kind` is the source fix type: W, TW, V, N, TN, R, A or L. Anything else resolves to nothing. */
  resolve(
    kind: string, ident: string, region: string, owner: string, airport: SrcAirport, fallbacks: boolean,
  ): Resolved | null {
    const plain = (pos: Pos | null | undefined): Resolved | null => (pos ? { pos, how: 'plain' } : null);
    switch (kind) {
      case 'W': return this.waypoint(ident, region, false, owner, airport, fallbacks);
      case 'TW': return this.waypoint(ident, region, true, owner, airport, fallbacks);
      case 'V': return plain(this.vor(ident, region, airport));
      case 'N': return plain(this.ndb(ident, region, false, owner, airport));
      case 'TN': return plain(this.ndb(ident, region, true, owner, airport));
      case 'R': return plain(this.runwayThreshold(ident, owner));
      case 'A': return plain(this.index.airportByIdent(ident));
      case 'L': return plain(this.pickIls(ident, airport));
      default: return null;
    }
  }

  /**
   * An arc's centre is a waypoint whose ident and region can name several
   * rows. The true centre is equally far from the leg's start and end, so the
   * candidate with the most equal two distances wins; without both ends, or on
   * a tie, the one nearest the airport, then the lowest id.
   */
  arcCentre(ident: string, region: string, from: Pos | null, to: Pos | null, airport: SrcAirport): Pos | null {
    const candidates = this.index.waypoints(ident, region);
    if (candidates.length <= 1) return candidates[0] ?? null;
    let best = candidates[0];
    let bestScore = Infinity;
    let bestDistance = Infinity;
    for (const c of candidates) {
      const score = from && to
        ? Math.abs(haversineNm(c.lat, c.lon, from.lat, from.lon) - haversineNm(c.lat, c.lon, to.lat, to.lon))
        : 0;
      const distance = haversineNm(airport.lat, airport.lon, c.lat, c.lon);
      if (
        score < bestScore ||
        (score === bestScore && (distance < bestDistance || (distance === bestDistance && c.id < best.id)))
      ) {
        best = c;
        bestScore = score;
        bestDistance = distance;
      }
    }
    return best;
  }
}

// ── Leg conversion ───────────────────────────────────────────────────────────

interface Ref {
  ident: string | null; region: string | null; type: string | null; lat: number | null; lon: number | null;
}
const NO_REF: Ref = { ident: null, region: null, type: null, lat: null, lon: null };

class LegConverter {
  private readonly resolver: FixResolver;

  constructor(
    private readonly index: SourceIndex,
    private readonly flavour: LnmFlavour,
    private readonly skipped: Counters,
  ) {
    this.resolver = new FixResolver(index);
  }

  /** The recommended navaid of a leg: the station an arc is flown around, or the one a course is flown from. */
  private recommended(s: SrcLegRow, ident: string, airport: SrcAirport): Ref {
    const kind = s.recommended_fix_type;
    const sourceRegion = s.recommended_fix_region ?? null;
    let pos = pairOf(s.recommended_fix_laty, s.recommended_fix_lonx);
    let region = sourceRegion;
    let type: string | null;
    if (kind == null || kind === 'L') {
      // An ILS: MSFS names it L, Navigraph leaves the type empty. Its region is the derived one.
      type = 'V';
      const ils = this.resolver.pickIls(ident, airport);
      if (ils) {
        region = this.index.ilsRegion(ils) ?? sourceRegion;
        pos ??= { lat: ils.lat, lon: ils.lon };
      }
    } else {
      type = Object.hasOwn(FIX_LETTER, kind) ? FIX_LETTER[kind] : null;
      if (type === null) bump(this.skipped, 'legs.unknownFixType');
      else pos ??= this.resolver.resolve(kind, ident, sourceRegion ?? '', airport.ident, airport, false)?.pos ?? null;
    }
    return { ident, region, type, lat: pos?.lat ?? null, lon: pos?.lon ?? null };
  }

  convert(s: SrcLegRow, table: Table, airport: SrcAirport, previous: ConvertedLeg | null): ConvertedLeg {
    const code = (s.type ?? '').trim().toUpperCase();
    const legType = Object.hasOwn(LEG_TYPE, code) ? LEG_TYPE[code] : 0;
    if (legType === 0) bump(this.skipped, 'legs.unknownType');
    const drawable = DRAWABLE_LEG_CODES.has(code);

    // The leg's own fix: the source coordinate when it has one, else a lookup.
    const fixIdent = s.fix_ident || null;
    const fixKind = s.fix_type ?? null;
    let fixPos = pairOf(s.fix_laty, s.fix_lonx);
    let fixType: string | null = null;
    if (fixIdent !== null && fixKind !== null) {
      if (Object.hasOwn(FIX_LETTER, fixKind)) fixType = FIX_LETTER[fixKind];
      else bump(this.skipped, 'legs.unknownFixType');
    }
    if (fixIdent !== null && fixPos === null && fixKind !== null) {
      const found = this.resolver.resolve(fixKind, fixIdent, s.fix_region ?? '', s.fix_airport_ident || airport.ident, airport, true);
      if (found) {
        fixPos = found.pos;
        if (drawable && found.how !== 'plain') bump(this.skipped, `${found.how}.${table}`);
      }
    }
    if (drawable && fixIdent !== null && fixPos === null) {
      bump(this.skipped, `unresolved.${table}.${fixKind !== null && COUNTED_FIX_TYPES.has(fixKind) ? fixKind : 'other'}`);
    }

    // The recommended fix: an arc's centre on RF and AF legs, the origin navaid on the rest.
    let origin = NO_REF;
    let arc = NO_REF;
    const recommendedIdent = s.recommended_fix_ident || null;
    if (recommendedIdent !== null) {
      if (code === 'RF') {
        // The centre of a radius-to-fix arc is a waypoint, never a navaid, so only the arc centre carries it.
        const region = s.recommended_fix_region ?? null;
        const pos = pairOf(s.recommended_fix_laty, s.recommended_fix_lonx)
          ?? this.resolver.arcCentre(
            recommendedIdent, region ?? '', pairOf(previous?.row.fix_lat ?? null, previous?.row.fix_lon ?? null), fixPos, airport,
          );
        arc = { ident: recommendedIdent, region, type: 'W', lat: pos?.lat ?? null, lon: pos?.lon ?? null };
      } else {
        origin = this.recommended(s, recommendedIdent, airport);
        if (code === 'AF') arc = origin;
      }
    }

    let altDesc = 0;
    const descriptor = s.alt_descriptor;
    if (descriptor != null) {
      // Navigraph writes 'at altitude 0' where it means no restriction.
      if (descriptor === 'A' && (s.altitude1 == null || s.altitude1 === 0)) altDesc = 0;
      else if (Object.hasOwn(ALT_DESC, descriptor)) altDesc = ALT_DESC[descriptor];
      else bump(this.skipped, 'legs.unknownAltDescriptor');
    }

    const hasArcGeometry = !((s.theta ?? 0) === 0 && (s.rho ?? 0) === 0);
    const timed = s.time != null && s.time > 0;
    const measured = s.distance != null && s.distance > 0;

    const row: LegRow = {
      leg_type: legType,
      fix_ident: fixIdent,
      fix_region: s.fix_region ?? null,
      fix_type: fixType,
      fix_lat: fixPos?.lat ?? null,
      fix_lon: fixPos?.lon ?? null,
      origin_ident: origin.ident, origin_region: origin.region, origin_type: origin.type,
      origin_lat: origin.lat, origin_lon: origin.lon,
      arc_center_ident: arc.ident, arc_center_region: arc.region, arc_center_type: arc.type,
      arc_center_lat: arc.lat, arc_center_lon: arc.lon,
      fly_over: s.is_flyover ? 1 : 0,
      turn_direction: s.turn_direction != null && Object.hasOwn(TURN, s.turn_direction) ? TURN[s.turn_direction] : 0,
      course_deg: s.course ?? null,
      true_degree: s.is_true_course ? 1 : 0,
      theta_deg: hasArcGeometry ? s.theta ?? null : null,
      rho_m: hasArcGeometry ? nmToM(s.rho) : null,
      // A hold's time is in minutes, flagged by distance_minute; every other leg carries metres.
      distance_minute: timed ? 1 : measured ? 0 : null,
      route_distance_m: timed ? s.time : measured ? nmToM(s.distance) : null,
      alt_desc: altDesc,
      altitude1_m: s.altitude1 != null && s.altitude1 > 0 ? ftToM(s.altitude1) : null,
      altitude2_m: s.altitude2 != null && s.altitude2 > 0 ? ftToM(s.altitude2) : null,
      speed_limit_kt: s.speed_limit != null && s.speed_limit > 0 ? s.speed_limit : null,
      vertical_angle_deg: verticalAngleToReplica(s.vertical_angle, this.flavour),
      is_iaf: 0,
      is_if: legType === LEG_IF ? 1 : 0,
      is_faf: 0,
      is_map: 0,
    };
    return { row, descr: s.arinc_descr_code ?? null, signature: null };
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

function insertSql(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(c => `@${c}`).join(', ')})`;
}

/** Writes whole procedures, committing before a procedure that would take the open transaction past `chunkRows`. */
class ProcedureWriter {
  private readonly insertProcedure: Database.Statement;
  private readonly insertTransition: Database.Statement;
  private readonly insertLeg: Database.Statement;
  private readonly ownsTransaction: boolean;
  private open = false;
  private pending = 0;

  procedures = 0;
  transitions = 0;
  legs = 0;
  readonly byKind: Record<Kind, number> = { SID: 0, STAR: 0, APPROACH: 0 };

  constructor(private readonly out: Database.Database, private readonly chunkRows: number) {
    this.insertProcedure = out.prepare(insertSql('nav_procedure', PROCEDURE_COLUMNS));
    this.insertTransition = out.prepare(insertSql('nav_procedure_transition', TRANSITION_COLUMNS));
    this.insertLeg = out.prepare(insertSql('nav_procedure_leg', ['trans_key', 'seq', ...LEG_COLUMNS, 'rev']));
    this.ownsTransaction = !out.inTransaction;
  }

  write(procedure: ProcedureOut): void {
    const rows = 1 + procedure.transitions.length + procedure.transitions.reduce((n, t) => n + t.legs.length, 0);
    if (this.open && this.pending + rows > this.chunkRows) this.commit();
    if (!this.open && this.ownsTransaction) {
      this.out.exec('BEGIN');
      this.open = true;
    }
    this.insertProcedure.run(procedure.row);
    this.procedures++;
    this.byKind[procedure.row.kind]++;
    for (const t of procedure.transitions) {
      this.insertTransition.run(t.row);
      this.transitions++;
      t.legs.forEach((leg, seq) => {
        this.insertLeg.run({ trans_key: t.row.trans_key, seq, ...leg, rev: 1 });
      });
      this.legs += t.legs.length;
    }
    this.pending += rows;
  }

  private commit(): void {
    if (!this.open) return;
    this.out.exec('COMMIT');
    this.open = false;
    this.pending = 0;
  }

  finish(): void {
    this.commit();
  }

  abort(): void {
    if (this.open && this.out.inTransaction) this.out.exec('ROLLBACK');
    this.open = false;
  }
}

// ── Procedure assembly ───────────────────────────────────────────────────────

/** A runway a SID or STAR applies to, with the legs it flies. */
interface Member {
  approach: Approach;
  runway: { number: number; designator: number } | null;
  legs: ConvertedLeg[];
}

interface ApproachBuild {
  approach: Approach;
  runway: { number: number; designator: number };
  approachType: number;
  name: string;
  suffix: string;
  baseKey: string;
  finalLegs: ConvertedLeg[];
  missedLegs: ConvertedLeg[];
  fafLeg: ConvertedLeg | undefined;
  fafAltM: number | null;
  fafHeadingDeg: number | null;
  missedAltM: number | null;
  /** Approach transitions that survived the duplicate rule, in source order. */
  transitions: { data: TransitionData; name: string; keyName: string }[];
  procKey: string;
}

const kindOf = (type: string, overlay: number, suffix: string | null): Kind =>
  type === 'GPS' && overlay === 1 && suffix === 'D' ? 'SID' : type === 'GPS' && overlay === 1 && suffix === 'A' ? 'STAR' : 'APPROACH';

const maxOf = (values: (number | null)[]): number | null => {
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  return max;
};

function transitionOut(
  procKeyValue: string, role: TransitionRole, name: string, legs: ConvertedLeg[], extra: Partial<TransitionRow> = {},
): TransitionOut {
  return {
    row: {
      trans_key: transKey(procKeyValue, role, name), proc_key: procKeyValue, role, name,
      runway_number: null, runway_designator: null, trans_type: null,
      iaf_ident: null, iaf_region: null, iaf_alt_m: null,
      dme_arc_ident: null, dme_arc_region: null, dme_arc_radial_deg: null, dme_arc_distance_m: null,
      n_legs: legs.length, rev: 1,
      ...extra,
    },
    legs: legs.map(l => l.row),
  };
}

/** Length of the run every list shares at its end (a SID) or at its start (a STAR). */
function sharedRun(lists: readonly (readonly ConvertedLeg[])[], kind: 'SID' | 'STAR'): number {
  const shortest = Math.min(...lists.map(l => l.length));
  const at = (list: readonly ConvertedLeg[], i: number): ConvertedLeg => (kind === 'SID' ? list[list.length - 1 - i] : list[i]);
  for (let i = 0; i < shortest; i++) {
    const reference = signatureOf(at(lists[0], i));
    for (const list of lists) {
      if (list !== lists[0] && signatureOf(at(list, i)) !== reference) return i;
    }
  }
  return shortest;
}

class ProceduresRun {
  private readonly stats: ConverterStats = { written: {}, skipped: {} };
  private readonly skipped: Counters = this.stats.skipped;
  /** Counts that are not row totals. */
  private readonly written: Counters = {};
  private readonly index: SourceIndex;
  private readonly converter: LegConverter;
  private readonly writer: ProcedureWriter;
  private readonly statements: {
    approaches: Database.Statement;
    approachLegs: Database.Statement;
    transitions: Database.Statement;
    transitionLegs: Database.Statement;
  };

  constructor(
    private readonly ctx: LnmContext,
    private readonly batchApproaches: number,
    chunkRows: number,
  ) {
    this.index = ctx.index;
    this.converter = new LegConverter(ctx.index, ctx.flavour, this.skipped);
    this.writer = new ProcedureWriter(ctx.out, chunkRows);
    this.statements = {
      approaches: ctx.src.prepare(
        `SELECT approach_id, airport_id, arinc_name, runway_name, type, suffix, has_gps_overlay, fix_ident, fix_region,
                altitude, heading, missed_altitude
           FROM approach ORDER BY approach_id`,
      ),
      approachLegs: ctx.src.prepare(`SELECT approach_id, is_missed, ${LEG_SOURCE_COLUMNS} FROM approach_leg ORDER BY approach_leg_id`),
      transitions: ctx.src.prepare(
        'SELECT transition_id, approach_id, type, fix_ident, fix_region, altitude FROM transition ORDER BY transition_id',
      ),
      transitionLegs: ctx.src.prepare(`SELECT transition_id, ${LEG_SOURCE_COLUMNS} FROM transition_leg ORDER BY transition_leg_id`),
    };
  }

  run(): ConverterStats {
    try {
      this.convertAll();
      this.writer.finish();
    } catch (err) {
      this.writer.abort();
      throw err;
    }
    this.stats.written = {
      procedures: this.writer.procedures,
      transitions: this.writer.transitions,
      legs: this.writer.legs,
      'procedures.sid': this.writer.byKind.SID,
      'procedures.star': this.writer.byKind.STAR,
      'procedures.approach': this.writer.byKind.APPROACH,
      ...this.written,
    };
    this.reportSkips();
    return this.stats;
  }

  /** The approach rows of owner airports that exist in the replica, by airport ident. */
  private loadApproaches(): { byAirport: Map<string, Approach[]>; total: number } {
    const known = new Set(this.ctx.out.prepare('SELECT ident FROM nav_airport').pluck().all() as string[]);
    const byAirport = new Map<string, Approach[]>();
    let total = 0;
    for (const r of this.statements.approaches.iterate() as IterableIterator<SrcApproachRow>) {
      const airport = r.airport_id === null ? undefined : this.index.airportById(r.airport_id);
      if (!airport) {
        bump(this.skipped, 'approaches.noAirport');
        continue;
      }
      if (!airport.isOwner) {
        bump(this.skipped, 'approaches.duplicateAirport');
        continue;
      }
      if (!known.has(airport.ident)) {
        bump(this.skipped, 'approaches.airportNotInReplica');
        continue;
      }
      const approach: Approach = {
        id: r.approach_id, airport, kind: kindOf(r.type, r.has_gps_overlay, r.suffix), arincName: r.arinc_name,
        runwayName: r.runway_name, type: r.type, suffix: r.suffix, fixIdent: r.fix_ident || null, fixRegion: r.fix_region,
        altitude: r.altitude, heading: r.heading, missedAltitude: r.missed_altitude,
      };
      const list = byAirport.get(airport.ident);
      if (list) list.push(approach);
      else byAirport.set(airport.ident, [approach]);
      total++;
    }
    return { byAirport, total };
  }

  private convertAll(): void {
    const { byAirport, total } = this.loadApproaches();
    const idents = [...byAirport.keys()].sort();
    let done = 0;
    let batch: string[] = [];
    let batchRows = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      const rows = batch.flatMap(ident => byAirport.get(ident) ?? []);
      const data = this.scan(rows);
      for (const ident of batch) {
        const approaches = byAirport.get(ident) ?? [];
        this.buildAirport(approaches, data);
        done += approaches.length;
        this.ctx.progress(done, total);
      }
      batch = [];
      batchRows = 0;
    };
    for (const ident of idents) {
      batch.push(ident);
      batchRows += byAirport.get(ident)?.length ?? 0;
      if (batchRows >= this.batchApproaches) flush();
    }
    flush();
  }

  /** One ordered pass over each child table, converting the rows of this batch's approaches. */
  private scan(approaches: readonly Approach[]): BatchData {
    const byId = new Map<number, Approach>(approaches.map(a => [a.id, a]));
    const data: BatchData = { finalLegs: new Map(), missedLegs: new Map(), transitions: new Map() };
    const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };

    // The previous leg of each list, for the arc-centre choice. Keyed by approach and missed flag.
    const previous = new Map<number, ConvertedLeg>();
    for (const r of this.statements.approachLegs.iterate() as IterableIterator<SrcApproachLeg>) {
      const approach = byId.get(r.approach_id);
      if (!approach) continue;
      const missed = r.is_missed ? 1 : 0;
      const key = approach.id * 2 + missed;
      const leg = this.converter.convert(r, 'approach', approach.airport, previous.get(key) ?? null);
      previous.set(key, leg);
      push(missed ? data.missedLegs : data.finalLegs, approach.id, leg);
    }

    const owner = new Map<number, Approach>();
    const byTransition = new Map<number, TransitionData>();
    for (const r of this.statements.transitions.iterate() as IterableIterator<SrcTransitionRow>) {
      const approach = byId.get(r.approach_id);
      if (!approach) continue;
      const t: TransitionData = {
        id: r.transition_id, type: r.type, fixIdent: r.fix_ident || null, fixRegion: r.fix_region, altitude: r.altitude, legs: [],
      };
      byTransition.set(t.id, t);
      owner.set(t.id, approach);
      push(data.transitions, approach.id, t);
    }
    const previousInTransition = new Map<number, ConvertedLeg>();
    for (const r of this.statements.transitionLegs.iterate() as IterableIterator<SrcTransitionLeg>) {
      const t = byTransition.get(r.transition_id);
      if (!t) continue;
      const leg = this.converter.convert(r, 'transition', (owner.get(t.id) as Approach).airport, previousInTransition.get(t.id) ?? null);
      previousInTransition.set(t.id, leg);
      t.legs.push(leg);
    }
    return data;
  }

  private buildAirport(approaches: readonly Approach[], data: BatchData): void {
    const groups = new Map<string, Approach[]>();
    const builds: ApproachBuild[] = [];
    for (const a of approaches) {
      if (a.kind === 'APPROACH') {
        const build = this.prepareApproach(a, data);
        if (build) builds.push(build);
        continue;
      }
      if (a.fixIdent === null) {
        bump(this.skipped, 'sidstar.noName');
        continue;
      }
      const key = `${a.kind}\u0000${a.fixIdent}`;
      const list = groups.get(key);
      if (list) list.push(a);
      else groups.set(key, [a]);
    }

    for (const members of groups.values()) {
      const procedure = this.buildSidStar(members, data);
      if (procedure) this.writer.write(procedure);
    }

    // Approaches sharing a base key are told apart the way the sidecar does it.
    const byBaseKey = new Map<string, ApproachBuild[]>();
    for (const b of builds) {
      const list = byBaseKey.get(b.baseKey);
      if (list) list.push(b);
      else byBaseKey.set(b.baseKey, [b]);
    }
    for (const [baseKey, group] of byBaseKey) {
      const records: ProcKeyRecord[] = group.map(b => ({
        id: String(b.approach.id),
        fafIdent: b.approach.fixIdent,
        nTransitions: b.transitions.length,
        missedLegCount: b.missedLegs.length,
        missedAltM: b.missedAltM,
      }));
      const keys = assignProcKeys(records, baseKey);
      for (const b of group) {
        b.procKey = keys.get(String(b.approach.id)) ?? baseKey;
        if (b.procKey !== baseKey) bump(this.written, 'approaches.keySuffixed');
      }
    }
    for (const b of builds) this.writer.write(this.approachOut(b));
  }

  // ── SID and STAR ───────────────────────────────────────────────────────────

  /** Runway text of a SID or STAR row: the runway name, else the RW part of the ARINC name; none means every runway. */
  private runwaySpec(a: Approach): string | null {
    const name = a.runwayName?.trim();
    if (name) return name;
    const arinc = a.arincName?.trim();
    return arinc && arinc.startsWith('RW') ? arinc.slice(2) || null : null;
  }

  /** One member per runway the row applies to; null when the runway name cannot be read. */
  private membersOf(a: Approach, data: BatchData): Member[] | null {
    const legs = data.finalLegs.get(a.id) ?? [];
    const spec = this.runwaySpec(a);
    if (spec === null) return [{ approach: a, runway: null, legs }];
    if (/^\d{2}B$/.test(spec)) {
      // 'both': every runway of that number at the airport, else the bare number.
      const number = spec.slice(0, 2);
      const members: Member[] = [];
      for (const letter of ['L', 'R', 'C']) {
        const runway = this.index.runwayEnd(a.airport.ident, number + letter) ? parseRunway(number + letter) : null;
        if (runway) members.push({ approach: a, runway, legs });
      }
      if (members.length > 0) return members;
      const bare = parseRunway(number);
      return bare ? [{ approach: a, runway: bare, legs }] : null;
    }
    const runway = parseRunway(stripTrueSuffix(spec));
    return runway ? [{ approach: a, runway, legs }] : null;
  }

  private buildSidStar(rows: readonly Approach[], data: BatchData): ProcedureOut | null {
    const first = rows[0];
    const kind = first.kind as 'SID' | 'STAR';
    const name = first.fixIdent as string;

    // One slot per runway; the lowest approach id keeps it.
    const slots = new Set<string>();
    const members: Member[] = [];
    const used: Approach[] = [];
    for (const a of rows) {
      const found = this.membersOf(a, data);
      if (found === null) {
        bump(this.skipped, 'sidstar.unparseableRunway');
        continue;
      }
      used.push(a);
      for (const m of found) {
        const slot = m.runway ? `${m.runway.number}|${m.runway.designator}` : '-';
        if (slots.has(slot)) {
          bump(this.skipped, 'sidstar.duplicateRunway');
          continue;
        }
        slots.add(slot);
        members.push(m);
      }
    }
    if (members.length === 0) return null;

    let common: ConvertedLeg[] = [];
    const runways: { runway: { number: number; designator: number }; legs: ConvertedLeg[] }[] = [];
    if (members.length === 1) {
      common = members[0].legs;
      if (members[0].runway) runways.push({ runway: members[0].runway, legs: [] });
    } else {
      const k = sharedRun(members.map(m => m.legs), kind);
      const lead = members[0].legs;
      common = kind === 'SID' ? lead.slice(lead.length - k) : lead.slice(0, k);
      for (const m of members) {
        const rest = kind === 'SID' ? m.legs.slice(0, m.legs.length - k) : m.legs.slice(k);
        if (m.runway) runways.push({ runway: m.runway, legs: rest });
        else if (rest.length > 0) bump(this.skipped, 'sidstar.legsWithoutRunway', rest.length);
      }
    }

    // Enroute transitions repeat across the rows of a procedure; the lowest approach id's copy is kept.
    const enroute = new Map<string, TransitionData>();
    for (const a of used) {
      for (const t of data.transitions.get(a.id) ?? []) {
        const n = t.fixIdent ?? '';
        if (!enroute.has(n)) enroute.set(n, t);
      }
    }

    const key = procKey(first.airport.ident, kind, name, null, null, null);
    const transitions: TransitionOut[] = [];
    if (common.length > 0) transitions.push(transitionOut(key, 'common', '', common));
    for (const r of runways) {
      transitions.push(transitionOut(key, 'runway', runwayDesignation(r.runway.number, r.runway.designator), r.legs, {
        runway_number: r.runway.number, runway_designator: r.runway.designator,
      }));
    }
    for (const [n, t] of enroute) transitions.push(transitionOut(key, 'enroute', n, t.legs));

    return {
      row: {
        proc_key: key, airport_ident: first.airport.ident, kind, name,
        runway_number: null, runway_designator: null, approach_type: null, suffix: null,
        faf_ident: null, faf_region: null, faf_alt_m: null, faf_heading_deg: null, missed_alt_m: null,
        has_lnav: null, has_lnavvnav: null, has_lp: null, has_lpv: null,
        n_transitions: null, n_runway_transitions: runways.length, n_enroute_transitions: enroute.size, rev: 1,
      },
      transitions,
    };
  }

  // ── Approaches ─────────────────────────────────────────────────────────────

  private prepareApproach(a: Approach, data: BatchData): ApproachBuild | null {
    const runway = a.runwayName === null ? { number: 0, designator: 0 } : parseRunway(stripTrueSuffix(a.runwayName));
    if (runway === null) {
      bump(this.skipped, 'approaches.unparseableRunway');
      return null;
    }
    const approachType = approachTypeOf(a.arincName, a.type, a.runwayName);
    const designation = runway.number === 0 ? '00' : runwayDesignation(runway.number, runway.designator);
    const name = `${approachType}-${designation}`;
    const suffix = a.suffix == null || a.suffix === '' ? '0' : a.suffix;

    const finalLegs = data.finalLegs.get(a.id) ?? [];
    const missedLegs = data.missedLegs.get(a.id) ?? [];

    // The FAF is the first final leg on the approach's fix, the missed-approach point the last final leg.
    const fafLeg = a.fixIdent === null ? undefined : finalLegs.find(l => l.row.fix_ident === a.fixIdent);
    if (fafLeg) fafLeg.row.is_faf = 1;
    if (finalLegs.length > 0) finalLegs[finalLegs.length - 1].row.is_map = 1;

    // Transitions with the same name and the same content are one; the others are told apart in the key only.
    const seen = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    const transitions: ApproachBuild['transitions'] = [];
    for (const t of data.transitions.get(a.id) ?? []) {
      const tname = t.fixIdent ?? '';
      const body = `${t.type !== null && Object.hasOwn(TRANSITION_TYPE, t.type) ? TRANSITION_TYPE[t.type] : ''}\n${t.legs.map(signatureOf).join('\n')}`;
      let bodies = seen.get(tname);
      if (!bodies) seen.set(tname, (bodies = new Set()));
      if (bodies.has(body)) {
        bump(this.skipped, 'transitions.duplicate');
        continue;
      }
      bodies.add(body);
      const n = (counts.get(tname) ?? 0) + 1;
      counts.set(tname, n);
      transitions.push({ data: t, name: tname, keyName: n === 1 ? tname : `${tname}#${n}` });
    }

    // An initial-approach-fix flag from the descriptor where the source has one, else the first leg of an approach transition (MSFS).
    const flagIaf = (leg: ConvertedLeg, firstOfApproachTransition: boolean): void => {
      if (leg.descr !== null) leg.row.is_iaf = /^.{3}[ACD]/.test(leg.descr) ? 1 : 0;
      else if (this.ctx.flavour === 'MSFS' && firstOfApproachTransition) leg.row.is_iaf = 1;
    };
    for (const leg of finalLegs) flagIaf(leg, false);
    for (const leg of missedLegs) flagIaf(leg, false);
    for (const t of transitions) t.data.legs.forEach((leg, i) => flagIaf(leg, i === 0));

    const fafAltM = a.altitude != null ? ftToM(a.altitude) : fafLeg?.row.altitude1_m ?? null;
    // The header heading is true on MSFS; the replica holds magnetic, as the final course of a Navigraph leg is.
    const fafHeadingDeg = this.ctx.flavour === 'MSFS' && a.heading != null
      ? norm360(a.heading - a.airport.magvarEast)
      : fafLeg?.row.course_deg ?? null;
    const missedAltM = a.missedAltitude != null ? ftToM(a.missedAltitude) : maxOf(missedLegs.map(l => l.row.altitude1_m));

    const baseKey = procKey(a.airport.ident, 'APPROACH', name, runway.number, runway.designator, suffix);
    return {
      approach: a, runway, approachType, name, suffix, baseKey, finalLegs, missedLegs, fafLeg, fafAltM, fafHeadingDeg,
      missedAltM, transitions, procKey: baseKey,
    };
  }

  private approachOut(b: ApproachBuild): ProcedureOut {
    const a = b.approach;
    const key = b.procKey;
    const transitions: TransitionOut[] = [transitionOut(key, 'final', '', b.finalLegs)];
    if (b.missedLegs.length > 0) transitions.push(transitionOut(key, 'missed', '', b.missedLegs));
    for (const t of b.transitions) {
      const legs = t.data.legs;
      const arc = legs.find(l => l.row.leg_type === LEG_AF)?.row;
      transitions.push(transitionOut(key, 'approach', t.keyName, legs, {
        // The key may carry a #n; the name column always holds the plain ident.
        name: t.name,
        trans_type: t.data.type !== null && Object.hasOwn(TRANSITION_TYPE, t.data.type) ? TRANSITION_TYPE[t.data.type] : null,
        iaf_ident: t.data.fixIdent, iaf_region: t.data.fixRegion,
        iaf_alt_m: t.data.altitude != null ? ftToM(t.data.altitude) : legs[0]?.row.altitude1_m ?? null,
        // The arc is read from the first AF leg: the transition's own DME columns are not reliable on MSFS.
        dme_arc_ident: arc?.origin_ident ?? null, dme_arc_region: arc?.origin_region ?? null,
        dme_arc_radial_deg: arc?.theta_deg ?? null, dme_arc_distance_m: arc?.rho_m ?? null,
      }));
    }
    return {
      row: {
        proc_key: key, airport_ident: a.airport.ident, kind: 'APPROACH', name: b.name,
        runway_number: b.runway.number, runway_designator: b.runway.designator,
        approach_type: b.approachType, suffix: b.suffix,
        faf_ident: a.fixIdent, faf_region: a.fixRegion, faf_alt_m: b.fafAltM, faf_heading_deg: b.fafHeadingDeg,
        missed_alt_m: b.missedAltM,
        has_lnav: null, has_lnavvnav: null, has_lp: null, has_lpv: null,
        n_transitions: b.transitions.length, n_runway_transitions: null, n_enroute_transitions: null, rev: 1,
      },
      transitions,
    };
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  private reportSkips(): void {
    const s = this.skipped;
    const note = (n: number | undefined, text: string): void => {
      if (n) this.ctx.warn(`procedures: ${text.replace('%n', String(n))}`);
    };
    note(s['approaches.noAirport'], 'skipped %n approach rows of no airport');
    note(s['approaches.duplicateAirport'], 'skipped %n approach rows of a duplicate airport row');
    note(s['approaches.airportNotInReplica'], 'skipped %n approach rows of an airport that was not imported');
    note(s['approaches.unparseableRunway'], 'skipped %n approaches with an unparseable runway name');
    note(s['sidstar.noName'], 'skipped %n SID/STAR rows with no name');
    note(s['sidstar.unparseableRunway'], 'skipped %n SID/STAR rows with an unparseable runway name');
    note(s['sidstar.duplicateRunway'], 'skipped %n SID/STAR rows that repeat a runway already imported');
    note(s['sidstar.legsWithoutRunway'], 'dropped %n SID/STAR legs of runway-less rows beyond the legs shared with the runway rows');
    note(s['transitions.duplicate'], 'dropped %n approach transitions that repeat another of the same approach');
    note(s['legs.unknownType'], 'wrote %n legs with an unknown leg type as type 0');
    note(s['legs.unknownFixType'], 'wrote %n fixes with an unknown fix type without a type');
    note(s['legs.unknownAltDescriptor'], 'wrote %n legs with an unknown altitude descriptor as none');
    let unresolved = 0;
    for (const [key, n] of Object.entries(s)) if (key.startsWith('unresolved.')) unresolved += n;
    note(unresolved, 'wrote %n drawable legs without a fix position');
  }
}

/**
 * `batchApproaches` closes a batch of whole airports once it holds that many
 * approach rows, and `chunkRows` caps the rows of a transaction; the output
 * depends on neither.
 */
export function createProceduresConverter(options: { batchApproaches?: number; chunkRows?: number } = {}): LnmConverter {
  const batchApproaches = options.batchApproaches ?? PROCEDURE_BATCH_APPROACHES;
  const chunkRows = options.chunkRows ?? PROCEDURE_CHUNK_ROWS;
  return {
    stage: 'procedures',
    run: (ctx: LnmContext): ConverterStats => new ProceduresRun(ctx, batchApproaches, chunkRows).run(),
  };
}

export const proceduresConverter: LnmConverter = createProceduresConverter();
