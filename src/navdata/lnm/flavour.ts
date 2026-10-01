// ── Little Navmap flavour detection ──────────────────────────────────────────
//
// An atools file is Navigraph-flavoured or MSFS-flavoured, and the two encode
// the same columns differently (com frequencies in kHz or Hz, leg coordinates
// present or absent). The flavour is read once from metadata.data_source and is
// then cross-checked against what the data actually holds: a file that says one
// thing and contains the other is refused rather than converted by guesswork.
//
// Every refusal is an LnmImportError whose message names only structure: a
// table, a column, the data_source value. Never a row value.

import type Database from 'better-sqlite3';
import type { LnmDataSource } from '../dataset';
import { LnmImportError, type AtoolsMetadata, type LnmFlavour } from './types';

/**
 * The atools tables and columns the importer reads: the subset of the Little
 * Navmap schema every supported file carries. A file lacking any of them is not
 * one this importer understands.
 */
export const ATOOLS_COLUMNS = {
  metadata: [
    'db_version_major', 'db_version_minor', 'last_load_timestamp', 'has_sid_star', 'airac_cycle', 'valid_through',
    'data_source', 'compiler_version', 'properties',
  ],
  airport: [
    'airport_id', 'file_id', 'ident', 'icao', 'iata', 'faa', 'local', 'name', 'city', 'state', 'country', 'region',
    'flatten', 'type', 'fuel_flags', 'has_avgas', 'has_jetfuel', 'has_tower_object', 'tower_frequency',
    'atis_frequency', 'awos_frequency', 'asos_frequency', 'unicom_frequency', 'is_closed', 'is_military', 'is_addon',
    'num_com', 'num_parking_gate', 'num_parking_ga_ramp', 'num_parking_cargo', 'num_parking_mil_cargo',
    'num_parking_mil_combat', 'num_approach', 'num_runway_hard', 'num_runway_soft', 'num_runway_water',
    'num_runway_light', 'num_runway_end_closed', 'num_runway_end_vasi', 'num_runway_end_als', 'num_runway_end_ils',
    'num_apron', 'num_taxi_path', 'num_helipad', 'num_jetway', 'num_starts', 'longest_runway_length',
    'longest_runway_width', 'longest_runway_heading', 'longest_runway_surface', 'num_runways', 'largest_parking_ramp',
    'largest_parking_gate', 'rating', 'is_3d', 'scenery_local_path', 'bgl_filename', 'left_lonx', 'top_laty',
    'right_lonx', 'bottom_laty', 'mag_var', 'tower_altitude', 'tower_lonx', 'tower_laty', 'transition_altitude',
    'transition_level', 'altitude', 'lonx', 'laty',
  ],
  runway: [
    'runway_id', 'airport_id', 'primary_end_id', 'secondary_end_id', 'surface', 'smoothness', 'shoulder', 'length',
    'width', 'heading', 'pattern_altitude', 'marking_flags', 'edge_light', 'center_light', 'has_center_red',
    'primary_lonx', 'primary_laty', 'secondary_lonx', 'secondary_laty', 'altitude', 'lonx', 'laty',
  ],
  runway_end: [
    'runway_end_id', 'name', 'end_type', 'offset_threshold', 'blast_pad', 'overrun', 'left_vasi_type',
    'left_vasi_pitch', 'right_vasi_type', 'right_vasi_pitch', 'has_closed_markings', 'has_stol_markings',
    'is_takeoff', 'is_landing', 'is_pattern', 'app_light_system_type', 'has_end_lights', 'has_reils',
    'has_touchdown_lights', 'num_strobes', 'ils_ident', 'heading', 'altitude', 'lonx', 'laty',
  ],
  com: [
    'com_id', 'airport_id', 'type', 'frequency', 'name',
  ],
  vor: [
    'vor_id', 'file_id', 'ident', 'name', 'region', 'airport_id', 'airport_ident', 'type', 'frequency', 'channel',
    'range', 'mag_var', 'dme_only', 'dme_altitude', 'dme_lonx', 'dme_laty', 'altitude', 'lonx', 'laty',
  ],
  ndb: [
    'ndb_id', 'file_id', 'ident', 'name', 'region', 'airport_id', 'airport_ident', 'type', 'frequency', 'range',
    'mag_var', 'altitude', 'lonx', 'laty',
  ],
  ils: [
    'ils_id', 'ident', 'name', 'region', 'type', 'perf_indicator', 'provider', 'frequency', 'range', 'mag_var',
    'has_backcourse', 'dme_range', 'dme_altitude', 'dme_lonx', 'dme_laty', 'gs_range', 'gs_pitch', 'gs_altitude',
    'gs_lonx', 'gs_laty', 'loc_runway_end_id', 'loc_airport_ident', 'loc_runway_name', 'loc_heading', 'loc_width',
    'end1_lonx', 'end1_laty', 'end_mid_lonx', 'end_mid_laty', 'end2_lonx', 'end2_laty', 'altitude', 'lonx', 'laty',
  ],
  waypoint: [
    'waypoint_id', 'file_id', 'nav_id', 'ident', 'name', 'region', 'airport_id', 'airport_ident', 'artificial',
    'type', 'arinc_type', 'num_victor_airway', 'num_jet_airway', 'mag_var', 'lonx', 'laty',
  ],
  airway: [
    'airway_id', 'airway_name', 'airway_type', 'route_type', 'airway_fragment_no', 'sequence_no', 'from_waypoint_id',
    'to_waypoint_id', 'direction', 'minimum_altitude', 'maximum_altitude', 'left_lonx', 'top_laty', 'right_lonx',
    'bottom_laty', 'from_lonx', 'from_laty', 'to_lonx', 'to_laty',
  ],
  approach: [
    'approach_id', 'airport_id', 'runway_end_id', 'arinc_name', 'airport_ident', 'runway_name', 'type', 'suffix',
    'has_gps_overlay', 'has_vertical_angle', 'has_rnp', 'fix_type', 'fix_ident', 'fix_region', 'fix_airport_ident',
    'aircraft_category', 'altitude', 'heading', 'missed_altitude',
  ],
  approach_leg: [
    'approach_leg_id', 'approach_id', 'is_missed', 'type', 'arinc_descr_code', 'approach_fix_type', 'alt_descriptor',
    'turn_direction', 'rnp', 'fix_type', 'fix_ident', 'fix_region', 'fix_airport_ident', 'fix_lonx', 'fix_laty',
    'recommended_fix_type', 'recommended_fix_ident', 'recommended_fix_region', 'recommended_fix_lonx',
    'recommended_fix_laty', 'is_flyover', 'is_true_course', 'course', 'distance', 'time', 'theta', 'rho', 'altitude1',
    'altitude2', 'speed_limit_type', 'speed_limit', 'vertical_angle',
  ],
  transition: [
    'transition_id', 'approach_id', 'type', 'fix_type', 'fix_ident', 'fix_region', 'fix_airport_ident',
    'aircraft_category', 'altitude', 'dme_ident', 'dme_region', 'dme_airport_ident', 'dme_radial', 'dme_distance',
  ],
  transition_leg: [
    'transition_leg_id', 'transition_id', 'type', 'arinc_descr_code', 'approach_fix_type', 'alt_descriptor',
    'turn_direction', 'rnp', 'fix_type', 'fix_ident', 'fix_region', 'fix_airport_ident', 'fix_lonx', 'fix_laty',
    'recommended_fix_type', 'recommended_fix_ident', 'recommended_fix_region', 'recommended_fix_lonx',
    'recommended_fix_laty', 'is_flyover', 'is_true_course', 'course', 'distance', 'time', 'theta', 'rho', 'altitude1',
    'altitude2', 'speed_limit_type', 'speed_limit', 'vertical_angle',
  ],
} as const;

export type AtoolsTable = keyof typeof ATOOLS_COLUMNS;

const SUPPORTED_SOURCES = 'NAVIGRAPH, MSFS and MSFS24';

/** metadata.data_source trimmed and upper-cased; null when it is none of the supported values. */
export function normaliseDataSource(raw: string | null | undefined): LnmDataSource | null {
  const value = (raw ?? '').trim().toUpperCase();
  return value === 'NAVIGRAPH' || value === 'MSFS' || value === 'MSFS24' ? value : null;
}

/** MSFS24 is converted with the MSFS rules. */
export function flavourOf(provider: LnmDataSource): LnmFlavour {
  return provider === 'NAVIGRAPH' ? 'NAVIGRAPH' : 'MSFS';
}

/** A data_source value is echoed in messages and logs only with its unsafe characters removed, cut to 16. */
function echoDataSource(raw: string | null): string {
  return (raw ?? '').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 16);
}

function notAtools(reason: string): LnmImportError {
  return new LnmImportError('LNM_NOT_ATOOLS', `not a Little Navmap database: ${reason}`);
}

function checkSchema(src: Database.Database): void {
  for (const table of Object.keys(ATOOLS_COLUMNS) as AtoolsTable[]) {
    const have = new Set(
      (src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name),
    );
    if (have.size === 0) throw notAtools(`missing table ${table}`);
    for (const column of ATOOLS_COLUMNS[table]) {
      if (!have.has(column)) throw notAtools(`missing column ${table}.${column}`);
    }
  }
}

function readMetadata(src: Database.Database): AtoolsMetadata {
  const rows = src.prepare('SELECT * FROM metadata LIMIT 2').all() as AtoolsMetadata[];
  if (rows.length === 0) throw notAtools('metadata has no row');
  if (rows.length > 1) throw notAtools('metadata has more than one row');
  return rows[0];
}

interface Range { lo: number | null; hi: number | null }

function frequencyRange(src: Database.Database, table: 'com' | 'vor' | 'ndb'): Range {
  return src.prepare(`SELECT MIN(frequency) AS lo, MAX(frequency) AS hi FROM ${table}`).get() as Range;
}

const exists = (src: Database.Database, sql: string): boolean =>
  src.prepare(`SELECT EXISTS(${sql}) AS e`).pluck().get() === 1;

/**
 * Cross-checks the declared data source against the magnitudes the two flavours
 * encode differently. A NULL value is ignored and an empty table skips its check.
 */
function checkMagnitudes(src: Database.Database, provider: LnmDataSource, flavour: LnmFlavour): void {
  const mismatch = (what: string): LnmImportError =>
    new LnmImportError('LNM_FLAVOUR_MISMATCH', `data source ${provider} does not match the file: ${what}`);

  const com = frequencyRange(src, 'com');
  if (com.lo !== null && com.hi !== null) {
    if (flavour === 'NAVIGRAPH' && com.hi >= 1_000_000) throw mismatch('com.frequency is not in kHz');
    if (flavour === 'MSFS' && com.lo < 1_000_000) throw mismatch('com.frequency is not in Hz');
  }

  const vor = frequencyRange(src, 'vor');
  if (vor.lo !== null && vor.hi !== null && (vor.lo < 100_000 || vor.hi >= 200_000)) {
    throw mismatch('vor.frequency is not in kHz');
  }

  const ndb = frequencyRange(src, 'ndb');
  if (ndb.lo !== null && ndb.hi !== null && (ndb.lo < 10_000 || ndb.hi > 200_000)) {
    throw mismatch('ndb.frequency is not in kHz x 100');
  }

  if (exists(src, 'SELECT 1 FROM approach_leg')) {
    const hasCoordinates = exists(src, 'SELECT 1 FROM approach_leg WHERE fix_laty IS NOT NULL');
    if (flavour === 'NAVIGRAPH' && !hasCoordinates) throw mismatch('approach_leg has no fix coordinates');
    if (flavour === 'MSFS' && hasCoordinates) throw mismatch('approach_leg has fix coordinates');
  }
}

/**
 * Reads the atools file's flavour and refuses what the importer cannot convert.
 * Checked in this order: schema, one metadata row, supported data source, at
 * least one airport, then the magnitude cross-checks.
 */
export function detectFlavour(src: Database.Database): {
  flavour: LnmFlavour; provider: LnmDataSource; metadata: AtoolsMetadata;
} {
  checkSchema(src);
  const metadata = readMetadata(src);

  const provider = normaliseDataSource(metadata.data_source);
  if (provider === null) {
    throw new LnmImportError(
      'LNM_UNSUPPORTED_SOURCE',
      `unsupported Little Navmap data source '${echoDataSource(metadata.data_source)}'; `
        + `only ${SUPPORTED_SOURCES} are supported`,
    );
  }

  if (!exists(src, 'SELECT 1 FROM airport')) {
    throw new LnmImportError('LNM_EMPTY', 'the Little Navmap database has no airports');
  }

  const flavour = flavourOf(provider);
  checkMagnitudes(src, provider, flavour);
  return { flavour, provider, metadata };
}
