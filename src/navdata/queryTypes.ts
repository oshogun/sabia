// Response shapes of the navdata query routes. camelCase, lon in [-180,180].
// Hand-mirrored into client/src/types.ts.

import type { NavdataDataset, NavdataSource } from './dataset';
import type { SidecarState, SnapshotId, Rev, DetailState, TransitionRole } from './wire';

export interface NavdataStatusResponse {
  present: boolean;
  schemaVersion: number | null;
  snapshotId: SnapshotId | null;
  rev: Rev | null;
  simId: string | null;
  simAppName: string | null;
  simAppVersion: string | null;
  snapshotAppliedAt: number | null;
  lastRowsAt: number | null;
  counts: {
    airports: number; airportsWithDetail: number; navaids: number; waypoints: number;
    airwayLegs: number; runways: number; procedures: number; coverageCells: number; absent: number;
  } | null;
  sidecar: { state: SidecarState; reason: string | null } | null;
  /** The source that answered: the selected one, unless it is unavailable. */
  source: NavdataSource;
  /** The stored choice from Settings. */
  selectedSource: NavdataSource;
  /** Set iff selectedSource is 'lnm' and the simulator replica answered instead. */
  sourceFallback: null | 'lnm-unavailable';
  /** What the answering replica is: label, cycle and validity. null iff present is false. */
  dataset: NavdataDataset | null;
}

/** Surface class of an airport's longest runway. Never inferred when unknown. */
export type AirportSurface = 'paved' | 'water' | 'soft';

/** An airport's size class, in reveal order: a lower tier is revealed at a
 *  lower zoom. 'unknown' means the airport has no fetched detail and no
 *  OurAirports row carries its ident — it is NOT a claim that the airport is
 *  small. 'other' is a positively classified heliport, seaplane base,
 *  balloonport or closed field. */
export type AirportTier = 'large' | 'medium' | 'small' | 'unknown' | 'other';

export interface FeatureAirport {
  ident: string; lat: number; lon: number; name: string | null;
  hasDetail: boolean; runways: number | null; procedures: number | null;
  /** Length in metres of the airport's longest runway, unrounded, exactly as
   *  nav_runway.length_m stores it. null = not known; never 0 and never a
   *  stand-in for "short". */
  longestRunwayM: number | null;
  /** Surface class of that same longest runway. null = not known. */
  surface: AirportSurface | null;
  /** true = the airport has a TOWER frequency. false = detail is present,
   *  frequencies are present, none of them is a tower. null = not known.
   *  false and null are different and must be kept distinct by callers. */
  towered: boolean | null;
  /** Heading in degrees of that same longest runway's primary end. null =
   *  not known (either the airport's detail wasn't fetched, or the runway
   *  row itself has no heading recorded). */
  longestRunwayHeadingDeg: number | null;
  /** This airport's size class. null = neither source could be consulted: no
   *  fetched runway and no classification data loaded. Distinct from
   *  'unknown', which is a measured fact about OurAirports' coverage; neither
   *  may be read as "small". */
  tier: AirportTier | null;
}

/** Why the airport list is shorter than the bbox's contents. Separate from
 *  `truncated`, which reports the `limit` cut on whatever passed the
 *  filter. */
export interface AirportThinning {
  /** 'none' = no tier filter ran and every airport in the bbox was eligible.
   *  'tier' = only airports up to `through` were returned. */
  mode: 'none' | 'tier';
  /** The last tier included. null iff mode === 'none'. Never 'other': when
   *  the last tier is admitted nothing is filtered, so mode is 'none'. */
  through: AirportTier | null;
  /** Airports inside the bbox the tier filter excluded. 0 iff
   *  mode === 'none'. */
  hidden: number;
  /** Unfiltered per-tier counts for this bbox, every key present including
   *  zeros. null when no histogram ran: the airports kind was not requested,
   *  or was zoom-gated, or the zoom already admits every tier. */
  byTier: Record<AirportTier, number> | null;
  /** Lowest zoom at which the tier after `through` is admitted. null iff
   *  mode === 'none'. */
  nextZoom: number | null;
}
export interface FeatureNavaid {
  kind: 'V' | 'N'; ident: string; region: string; lat: number; lon: number;
  frequencyHz: number | null; name: string | null; navType: number | null; isDme: boolean | null;
}
export interface FeatureWaypoint {
  key: string; ident: string; region: string; lat: number; lon: number; terminal: boolean | null;
}
export interface FeatureAirwayLeg {
  airway: string; from: [number, number]; to: [number, number];
  fromIdent: string; toIdent: string; dateline: boolean;
}
export interface FeatureRunway {
  airport: string; lat: number; lon: number;
  headingDeg: number | null; lengthM: number | null; widthM: number | null; designation: string;
  secondaryDesignation: string;
}
export interface FeatureCoverageKind {
  harvestedCells: number; fraction: number;
  oldestHarvestAt: number | null; newestHarvestAt: number | null;
}
export interface FeatureCoverage {
  totalCells: number;
  byKind: Record<'V' | 'N' | 'W', FeatureCoverageKind>;
  airportsComplete: boolean;
}
export interface FeaturesResponse {
  bbox: [number, number, number, number];
  zoom: number; gated: string[]; truncated: boolean; limit: number;
  airports: FeatureAirport[]; navaids: FeatureNavaid[]; waypoints: FeatureWaypoint[];
  airways: FeatureAirwayLeg[]; runways: FeatureRunway[];
  coverage: FeatureCoverage;
  /** Always present, never null. */
  airportThinning: AirportThinning;
}

export interface AirportProcedureSummary {
  key: string; kind: 'SID' | 'STAR' | 'APPROACH'; name: string; runway: string | null;
  transitions: { key: string; role: TransitionRole; name: string; legs: number }[];
}
export interface AirportDetailResponse {
  ident: string; detailState: DetailState; detailFetchedAt: number | null;
  lat: number | null; lon: number | null; altM: number | null;
  name: string | null; magvar: number | null;
  runways: FeatureRunway[];
  frequencies: { type: number | null; frequencyHz: number | null; name: string | null }[];
  procedures: AirportProcedureSummary[];
  longestRunwayM: number | null;
  surface: AirportSurface | null;
  towered: boolean | null;
  longestRunwayHeadingDeg: number | null;
}

export interface GeometryPoint {
  lat: number; lon: number; ident: string | null; legType: number | null;
  flyOver: boolean | null;
  altitude1M: number | null; altitude2M: number | null; speedLimitKt: number | null;
}
export interface GeometryArc {
  fromIndex: number; toIndex: number; centerLat: number; centerLon: number; turn: 'L' | 'R' | null;
}
export interface GeometryChain {
  /** proc_key for a real procedure; the plan's opaque sid_name/approach_name
   *  for a synthetic chain; 'planned' for enroute; null when empty. */
  source: string | null;
  /** true only for a custom SID/approach computed from the runway
   *  (see the synthetic procedure builder). false on every other chain, empty
   *  chains included. */
  synthetic: boolean;
  points: GeometryPoint[];
  arcs: GeometryArc[];
}

/** isAirport comes from
 *  planned_legs.departure_is_airport / destination_is_airport; when false the
 *  UI must not offer "fetch detail". This server never emits null — the
 *  planned columns are NOT NULL — but the type admits it. */
export interface RouteGeometryEndpoint {
  ident: string; lat: number; lon: number; isAirport: boolean;
}

export type UnresolvedKind = 'sid' | 'star' | 'approach' | 'airway' | 'waypoint';
export type UnresolvedReason =
  | 'ident not in cache'
  | 'position disagrees with cache'
  | 'no path found'
  | 'procedure not in cache'
  | 'airport detail not fetched'
  /** A custom SID/approach whose runway row is missing or unusable .
   *  A custom procedure is NEVER 'procedure not in cache'. */
  | 'custom procedure, no runway'
  /** A custom procedure whose runway resolved but whose distance is missing or not a positive number. */
  | 'custom procedure, invalid distance'
  | 'unparseable runway'
  | 'approach runway not specified';

export interface RouteGeometryResponse {
  legId: number;
  origin: RouteGeometryEndpoint | null; destination: RouteGeometryEndpoint | null;
  sid: GeometryChain; enroute: GeometryChain; star: GeometryChain; approach: GeometryChain;
  skippedLegs: number;
  skippedByChain: Record<'sid' | 'enroute' | 'star' | 'approach', number>;
  unresolved: { kind: UnresolvedKind; name: string; reason: UnresolvedReason }[];
}
