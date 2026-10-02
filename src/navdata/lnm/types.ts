// ── Little Navmap importer: shared types ─────────────────────────────────────
//
// The contract every converter, the pipeline and the import route code against.
// Converters never import each other; whatever they share travels through
// LnmContext and the SourceIndex built once from the atools file.

import type Database from 'better-sqlite3';
import type { LnmDataSource, NavdataDataset } from '../dataset';

/** MSFS24 is detected as provider MSFS24 and converted with the MSFS rules. */
export type LnmFlavour = 'NAVIGRAPH' | 'MSFS';

export type LnmStage =
  | 'validating' | 'indexing' | 'airports' | 'navaids' | 'waypoints' | 'airways'
  | 'procedures' | 'finalising' | 'coverage' | 'verifying' | 'swapping';

/** Progress weights; they sum to 100. */
export const LNM_STAGE_WEIGHTS: Readonly<Record<LnmStage, number>> = {
  validating: 2, indexing: 8, airports: 10, navaids: 4, waypoints: 10, airways: 5,
  procedures: 45, finalising: 3, coverage: 8, verifying: 4, swapping: 1,
};

export type LnmImportErrorCode =
  // refused or failed at the HTTP edge
  | 'LNM_BAD_REQUEST' | 'LNM_NOT_SQLITE' | 'LNM_FILE_NOT_FOUND' | 'LNM_IMPORT_BUSY' | 'LNM_NOT_RUNNING'
  | 'LNM_LENGTH_REQUIRED' | 'LNM_TOO_LARGE' | 'LNM_INSUFFICIENT_STORAGE' | 'LNM_INSUFFICIENT_MEMORY' | 'LNM_SPOOL_FAILED'
  // failed while the job ran
  | 'LNM_UPLOAD_ABORTED' | 'LNM_OPEN_FAILED' | 'LNM_NOT_ATOOLS' | 'LNM_UNSUPPORTED_SOURCE' | 'LNM_EMPTY'
  | 'LNM_FLAVOUR_MISMATCH' | 'LNM_DISK_FULL' | 'LNM_OUT_OF_MEMORY' | 'LNM_WORKER_FAILED' | 'LNM_BUILD_FAILED'
  | 'LNM_VERIFY_FAILED' | 'LNM_SWAP_FAILED' | 'LNM_INTERRUPTED';

/**
 * An import refusal or failure whose text may reach the API. The message is one
 * line and names only structure (a table, a column, the data_source value),
 * never a row value or a path from inside the atools file.
 */
export class LnmImportError extends Error {
  readonly code: LnmImportErrorCode;

  constructor(code: LnmImportErrorCode, message: string) {
    super(message);
    this.name = 'LnmImportError';
    this.code = code;
  }
}

// ── The atools metadata row ──────────────────────────────────────────────────

/** The single row of the atools `metadata` table, column names as stored. */
export interface AtoolsMetadata {
  db_version_major: number;
  db_version_minor: number;
  last_load_timestamp: string | null;
  has_sid_star: number | null;
  airac_cycle: string | null;
  valid_through: string | null;
  data_source: string | null;
  compiler_version: string | null;
  properties: string | null;
}

// ── Source index (built once from the atools file) ───────────────────────────

export interface SrcAirport {
  id: number; ident: string; region: string; lat: number; lon: number;
  /** atools mag_var: degrees, east positive. */
  magvarEast: number;
  /** False for the losing rows of a duplicated ident. */
  isOwner: boolean;
}
export interface SrcVor {
  id: number; ident: string; region: string; lat: number; lon: number; airportId: number | null;
}
export interface SrcNdb {
  id: number; ident: string; region: string; lat: number; lon: number; airportId: number | null;
}
export interface SrcIls {
  id: number; ident: string;
  /** ils.region as stored (NULL on every MSFS row). */
  region: string | null;
  /** ils.region when non-empty, else the first two characters of loc_airport_ident; null when both are empty. */
  derivedRegion: string | null;
  airportIdent: string | null; lat: number; lon: number; locRunwayEndId: number | null;
}
export interface SrcWaypoint {
  id: number; ident: string; region: string; lat: number; lon: number;
  airportId: number | null;
  /** Ident of the airport row `airportId` points at (a losing duplicate shares its owner's); null when unset or dangling. */
  airportIdent: string | null;
}
export interface SrcRunwayEnd {
  id: number; name: string; lat: number; lon: number;
  /** atools runway_end.heading: true degrees. */
  headingTrue: number;
  offsetThresholdFt: number | null;
}
export type NavaidWinner = { table: 'vor' | 'ils' | 'ndb'; id: number; ambiguous: boolean };

export interface SourceIndex {
  flavour: LnmFlavour;
  provider: LnmDataSource;
  /** The airport row that owns an ident: largest num_runways + num_com + num_approach, then the lowest airport_id. */
  airportOwnerId(ident: string): number | undefined;
  /** Any airport row, owner or not. */
  airportById(id: number): SrcAirport | undefined;
  /** The owner row of an ident. */
  airportByIdent(ident: string): SrcAirport | undefined;
  vors(ident: string, region: string): readonly SrcVor[];
  ndbs(ident: string, region: string): readonly SrcNdb[];
  /** Every kept ILS with that ident, whatever its region or airport. GLS rows are not kept. */
  ilsByIdent(ident: string): readonly SrcIls[];
  /** ils.region when non-empty, else the first two characters of loc_airport_ident. */
  ilsRegion(ils: SrcIls): string | null;
  /** Non-artificial waypoints only: the rows LNM adds as copies of VORs and NDBs are not indexed. */
  waypoints(ident: string, region: string): readonly SrcWaypoint[];
  waypointsByIdent(ident: string): readonly SrcWaypoint[];
  /** An end of a runway of the owner airport, by end name. The caller removes any RW prefix; a trailing T goes here. */
  runwayEnd(airportIdent: string, endName: string): SrcRunwayEnd | undefined;
  /** The row that keeps the key (kind, ident, region); undefined when there is no candidate. */
  navaidWinner(kind: 'V' | 'N', ident: string, region: string): NavaidWinner | undefined;
  /** True when the vor_id / ndb_id is the nav_id of a V / N waypoint row that some airway uses as an endpoint. */
  isAirwayEndpointNavaid(table: 'vor' | 'ndb', id: number): boolean;
}

// ── Converter contract ───────────────────────────────────────────────────────

export interface LnmContext {
  /** The atools file, opened { readonly: true, fileMustExist: true }. */
  src: Database.Database;
  /** The incoming replica: NAVDATA_DDL and LNM_DATASET_DDL applied, foreign keys on. */
  out: Database.Database;
  flavour: LnmFlavour;
  provider: LnmDataSource;
  index: SourceIndex;
  /** Import start, epoch ms. Every *_fetched_at and harvested_at carries it. */
  now: number;
  /** Within the current stage; the pipeline rate-limits it. */
  progress(done: number, total: number): void;
  /** Aggregated, structural text only: never a row value. */
  warn(message: string): void;
}
export interface ConverterStats { written: Record<string, number>; skipped: Record<string, number> }
export interface LnmConverter { readonly stage: LnmStage; run(ctx: LnmContext): ConverterStats }

// ── Runner and worker protocol ───────────────────────────────────────────────

export interface LnmWorkerRequest {
  /** Absolute: the spool file or a file in the import directory. */
  sourcePath: string;
  /** Basename, stored in lnm_dataset. */
  sourceFileName: string;
  sourceBytes: number;
  incomingPath: string;
  now: number;
}
export interface LnmImportCounts {
  airports: number; runways: number; frequencies: number; navaids: number; waypoints: number;
  airwayLegs: number; procedures: number; transitions: number; legs: number; coverageCells: number;
}
export interface LnmImportResult {
  snapshotId: string; dataset: NavdataDataset; counts: LnmImportCounts; warnings: number; durationMs: number;
}
export type LnmWorkerMessage =
  | { type: 'progress'; stage: LnmStage; done: number; total: number }
  | { type: 'done'; result: LnmImportResult }
  | { type: 'error'; code: LnmImportErrorCode; message: string };
/** cancel() latches first: after it no message reaches onMessage and no synthetic error is emitted. */
export interface LnmImportRunner {
  start(req: LnmWorkerRequest, onMessage: (m: LnmWorkerMessage) => void): { done: Promise<void>; cancel(): void };
}

// ── Job state served by GET /api/navdata/lnm-import ──────────────────────────

export type LnmImportState = 'receiving' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface LnmImportJob {
  id: string;
  origin: 'upload' | 'path';
  sourceFileName: string;
  sourceBytes: number;
  state: LnmImportState;
  stage: LnmStage | null;
  fraction: number;
  startedAt: number;
  finishedAt: number | null;
  error: { code: LnmImportErrorCode; message: string } | null;
  result: { dataset: NavdataDataset; counts: LnmImportCounts; warnings: number } | null;
}
export interface LnmImportFilesResponse {
  /** navdataImportDir(), absolute. */
  dir: string;
  files: { name: string; sizeBytes: number; modifiedAt: number }[];
  /** LNM_UPLOAD_MAX_BYTES. */
  maxUploadBytes: number;
  /** statfs of dir; null when statfs fails. */
  availableBytes: number | null;
  /** Build reserve plus margin: an upload of n bytes needs n + reserveBytes. */
  reserveBytes: number;
}
