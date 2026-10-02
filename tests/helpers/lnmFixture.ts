// ── Synthetic Little Navmap (atools) databases for tests ─────────────────────
//
// buildLnmFixture() creates a SQLite file shaped like an atools database,
// holding only invented rows: idents in the ZZ/XZ style, regions ZZ and ZY,
// coordinates in an empty stretch of the Pacific (plus the exact edge values
// the importer must survive: latitude 90, longitude 180, an airway across the
// antimeridian). Nothing here is read from, or copied out of, a real database;
// only the table definitions come from the atools schema.
//
// Two presets, navigraph() and msfs(), differ in exactly the traits the two
// flavours really differ in: the metadata row, com frequencies (kHz truncated
// to 10 kHz against Hz), leg coordinates (present against absent), the fix
// type codes, the vertical angle encoding, the ILS region (set against NULL),
// the approach altitude/heading columns, and the transition DME columns.
//
// A test adds the case it needs through `extra`, without touching this file:
//
//   buildLnmFixture(dir, msfs({ extra: { com: [{ airport_id: 1, type: 'T', frequency: 118_000_000 }] } }))
//
// Every row, preset or extra, is completed with a zero (numbers) or '' (text)
// for each NOT NULL column it leaves out, except the columns that identify or
// place a row or carry a measured magnitude: those must be given, or the
// builder throws. A column the table does not have throws too. Preset ids stay
// below 1000, so a caller's own ids can start there.
//
// What the presets hold (ids in parentheses):
//   airports   ZZAA (1) with two runways, five frequencies and the procedures
//              below; ZZAB (2) closed; Navigraph only: ZZAC twice (3 loses to 4)
//   runways    09L/27R (1) with an offset threshold and an ILS ident; 18T/36 (2),
//              the T end named by true bearing and a width of 0; 05/23 (3), 10/28 (4)
//   com        .x20 and .x70 channels, a UHF row, an orphan with airport_id -1;
//              Navigraph also an HF and a LF row (MSFS has none: Hz only)
//   vor        ZZV high (1), ZZT TACAN (2), ZZD DME-only (3)
//   ndb        two rows sharing ZZN/ZZ (1 free, 2 at ZZAA and an airway endpoint)
//   ils        IZZA on 27R (1); ZZV sharing the VOR's ident and region (2)
//   waypoint   V and N copies (1-3), WN/WU (4-7), lon 180 (8), lat 90 (9), the
//              antimeridian pair (10, 11); MSFS adds RNAV (13), a VFR fix
//              sharing the VOR's ident and region far away (14), a NULL region (15)
//   airway     ZZ1 (V), ZZ2 (J) ending on the NDB copy, ZZ3 (B) starting on the
//              VOR copy, ZZ4 across the antimeridian
//   approach   SID ZZ1D on two runways sharing a tail (1, 2); STAR ZZ2A as an
//              ALL row and a runway row (3, 4); two ILS approaches to 27R that
//              share a base key (5, 6)
//   transition enroute transitions for the SID and the STAR; approach 5 has two
//              transitions with one name and a DME arc with an AF leg
//   legs       RF and AF legs, a hold with a time, a runway (R) fix, a terminal
//              NDB leg (TN on MSFS), a final leg with a vertical angle

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ATOOLS_COLUMNS, type AtoolsTable } from '../../src/navdata/lnm/flavour';
import { scratchDbRoot } from './scratchRoot';

export type { AtoolsTable } from '../../src/navdata/lnm/flavour';

/** The atools table definitions the importer reads; schema only. */
export const ATOOLS_SUBSET_DDL = `
CREATE TABLE metadata
 (
  db_version_major integer not null,
  db_version_minor integer not null,
  last_load_timestamp varchar(100),
  has_sid_star integer,
  airac_cycle varchar(10),
  valid_through varchar(10),
  data_source varchar(10),
  compiler_version varchar(1000),
  properties varchar(2000)
 );
CREATE TABLE airport
 (
  airport_id integer primary key,
  file_id integer not null,
  ident varchar(10) not null,
  icao varchar(10),
  iata varchar(10),
  faa varchar(10),
  local varchar(10),
  name varchar(50) collate nocase,
  city varchar(50) collate nocase,
  state varchar(50) collate nocase,
  country varchar(50) collate nocase,
  region varchar(4) collate nocase,
  flatten integer,
  type integer,
  fuel_flags integer not null,
  has_avgas integer not null,
  has_jetfuel integer not null,
  has_tower_object integer not null,
  tower_frequency integer,
  atis_frequency integer,
  awos_frequency integer,
  asos_frequency integer,
  unicom_frequency integer,
  is_closed integer not null,
  is_military integer not null,
  is_addon integer not null,
  num_com integer not null,
  num_parking_gate integer not null,
  num_parking_ga_ramp integer not null,
  num_parking_cargo integer not null,
  num_parking_mil_cargo integer not null,
  num_parking_mil_combat integer not null,
  num_approach integer not null,
  num_runway_hard integer not null,
  num_runway_soft integer not null,
  num_runway_water integer not null,
  num_runway_light integer not null,
  num_runway_end_closed integer not null,
  num_runway_end_vasi integer not null,
  num_runway_end_als integer not null,
  num_runway_end_ils integer,
  num_apron integer not null,
  num_taxi_path integer not null,
  num_helipad integer not null,
  num_jetway integer not null,
  num_starts integer not null,
  longest_runway_length integer not null,
  longest_runway_width integer not null,
  longest_runway_heading double not null,
  longest_runway_surface varchar(15),
  num_runways integer not null,
  largest_parking_ramp varchar(20),
  largest_parking_gate varchar(20),
  rating integer not null,
  is_3d integer not null,
  scenery_local_path varchar(250) collate nocase,
  bgl_filename varchar(300) collate nocase,
  left_lonx double not null,
  top_laty double not null,
  right_lonx double not null,
  bottom_laty double not null,
  mag_var double not null,
  tower_altitude integer,
  tower_lonx double,
  tower_laty double,
  transition_altitude double,
  transition_level double,
  altitude integer not null,
  lonx double not null,
  laty double not null,
 foreign key(file_id) references bgl_file(bgl_file_id)
 );
CREATE TABLE runway
 (
  runway_id integer primary key,
  airport_id integer not null,
  primary_end_id integer not null,
  secondary_end_id integer not null,
  surface varchar(15),
  smoothness double,
  shoulder varchar(15),
  length double not null,
  width double not null,
  heading double not null,
  pattern_altitude integer not null,
  marking_flags integer not null,
  edge_light varchar(15),
  center_light varchar(15),
  has_center_red integer not null,
  primary_lonx double not null,
  primary_laty double not null,
  secondary_lonx double not null,
  secondary_laty double not null,
  altitude integer not null,
  lonx double not null,
  laty double not null,
 foreign key(airport_id) references airport(airport_id),
 foreign key(primary_end_id) references runway_end(runway_end_id),
 foreign key(secondary_end_id) references runway_end(runway_end_id)
 );
CREATE TABLE runway_end
 (
  runway_end_id integer primary key,
  name varchar(10) not null,
  end_type varchar(1) not null,
  offset_threshold double not null,
  blast_pad double not null,
  overrun double not null,
  left_vasi_type varchar(15),
  left_vasi_pitch double,
  right_vasi_type varchar(15),
  right_vasi_pitch double,
  has_closed_markings integer not null,
  has_stol_markings integer not null,
  is_takeoff integer not null,
  is_landing integer not null,
  is_pattern varchar(10) not null,
  app_light_system_type varchar(15),
  has_end_lights integer not null,
  has_reils integer not null,
  has_touchdown_lights integer not null,
  num_strobes integer,
  ils_ident varchar(10),
  heading double not null,
  altitude integer,
  lonx double not null,
  laty double not null
 );
CREATE TABLE com
 (
  com_id integer primary key,
  airport_id integer not null,
  type varchar(30),
  frequency integer not null,
  name varchar(50),
 foreign key(airport_id) references airport(airport_id)
 );
CREATE TABLE vor
 (
  vor_id integer primary key,
  file_id integer not null,
  ident varchar(5),
  name varchar(50),
  region varchar(2),
  airport_id integer,
  airport_ident varchar(4),
  type varchar(15),
  frequency integer,
  channel varchar(5),
  range integer,
  mag_var double,
  dme_only integer not null,
  dme_altitude integer,
  dme_lonx double,
  dme_laty double,
  altitude integer,
  lonx double not null,
  laty double not null,
 foreign key(file_id) references bgl_file(bgl_file_id),
 foreign key(airport_id) references airport(airport_id)
 );
CREATE TABLE ndb
 (
  ndb_id integer primary key,
  file_id integer not null,
  ident varchar(5),
  name varchar(50),
  region varchar(2),
  airport_id integer,
  airport_ident varchar(4),
  type varchar(15),
  frequency integer not null,
  range integer,
  mag_var double not null,
  altitude integer,
  lonx double not null,
  laty double not null,
 foreign key(file_id) references bgl_file(bgl_file_id),
 foreign key(airport_id) references airport(airport_id)
 );
CREATE TABLE ils
 (
  ils_id integer primary key,
  ident varchar(5),
  name varchar(50),
  region varchar(2),
  type varchar(1),
  perf_indicator varchar(10),
  provider varchar(10),
  frequency integer,
  range integer,
  mag_var double not null,
  has_backcourse integer not null,
  dme_range integer,
  dme_altitude integer,
  dme_lonx double,
  dme_laty double,
  gs_range integer,
  gs_pitch double,
  gs_altitude integer,
  gs_lonx double,
  gs_laty double,
  loc_runway_end_id integer,
  loc_airport_ident varchar(4),
  loc_runway_name varchar(10),
  loc_heading double,
  loc_width double,
  end1_lonx double,
  end1_laty double,
  end_mid_lonx double,
  end_mid_laty double,
  end2_lonx double,
  end2_laty double,
  altitude integer not null,
  lonx double not null,
  laty double not null,
 foreign key(loc_runway_end_id) references runway_end(runway_end_id)
 );
CREATE TABLE waypoint
 (
  waypoint_id integer primary key,
  file_id integer not null,
  nav_id integer,
  ident varchar(5) not null,
  name varchar(50),
  region varchar(2),
  airport_id integer,
  airport_ident varchar(4),
  artificial integer,
  type varchar(15),
  arinc_type varchar(4),
  num_victor_airway integer not null,
  num_jet_airway integer not null,
  mag_var double not null,
  lonx double not null,
  laty double not null,
 foreign key(file_id) references bgl_file(bgl_file_id),
 foreign key(airport_id) references airport(airport_id)
 );
CREATE TABLE airway
 (
  airway_id integer primary key,
  airway_name varchar(5) not null,
  airway_type varchar(15) not null,
  route_type varchar(5),
  airway_fragment_no integer not null,
  sequence_no integer not null,
  from_waypoint_id integer not null,
  to_waypoint_id integer not null,
  direction varchar(1),
  minimum_altitude integer,
  maximum_altitude integer,
  left_lonx double not null,
  top_laty double not null,
  right_lonx double not null,
  bottom_laty double not null,
  from_lonx double not null,
  from_laty double not null,
  to_lonx double not null,
  to_laty double not null,
 foreign key(from_waypoint_id) references waypoint(waypoint_id),
 foreign key(to_waypoint_id) references waypoint(waypoint_id)
 );
CREATE TABLE approach
 (
  approach_id integer primary key,
  airport_id integer,
  runway_end_id integer,
  arinc_name varchar(6),
  airport_ident varchar(4),
  runway_name varchar(10),
  type varchar(25) not null,
  suffix varchar(1),
  has_gps_overlay integer not null,
  has_vertical_angle integer,
  has_rnp integer,
  fix_type varchar(25),
  fix_ident varchar(5),
  fix_region varchar(2),
  fix_airport_ident varchar(4),
  aircraft_category varchar(4),
  altitude integer,
  heading double,
  missed_altitude integer,
 foreign key(airport_id) references airport(airport_id),
 foreign key(runway_end_id) references runway_end(runway_end_id)
 );
CREATE TABLE approach_leg
 (
  approach_leg_id integer primary key,
  approach_id integer not null,
  is_missed integer not null,
  type varchar(10),
  arinc_descr_code varchar(25),
  approach_fix_type varchar(1),
  alt_descriptor varchar(10),
  turn_direction varchar(10),
  rnp double,
  fix_type varchar(25),
  fix_ident varchar(5),
  fix_region varchar(2),
  fix_airport_ident varchar(4),
  fix_lonx double,
  fix_laty double,
  recommended_fix_type varchar(25),
  recommended_fix_ident varchar(5),
  recommended_fix_region varchar(2),
  recommended_fix_lonx double,
  recommended_fix_laty double,
  is_flyover integer not null,
  is_true_course integer not null,
  course double,
  distance double,
  time double,
  theta double,
  rho double,
  altitude1 double,
  altitude2 double,
  speed_limit_type varchar(2),
  speed_limit integer,
  vertical_angle double,
 foreign key(approach_id) references approach(approach_id)
 );
CREATE TABLE transition
 (
  transition_id integer primary key,
  approach_id integer not null,
  type varchar(25) not null,
  fix_type varchar(25),
  fix_ident varchar(5),
  fix_region varchar(2),
  fix_airport_ident varchar(4),
  aircraft_category varchar(4),
  altitude integer,
  dme_ident varchar(5),
  dme_region varchar(2),
  dme_airport_ident varchar(5),
  dme_radial double,
  dme_distance integer,
 foreign key(approach_id) references approach(approach_id)
 );
CREATE TABLE transition_leg
 (
  transition_leg_id integer primary key,
  transition_id integer not null,
  type varchar(10) not null,
  arinc_descr_code varchar(25),
  approach_fix_type varchar(1),
  alt_descriptor varchar(10),
  turn_direction varchar(10),
  rnp double,
  fix_type varchar(25),
  fix_ident varchar(5),
  fix_region varchar(2),
  fix_airport_ident varchar(4),
  fix_lonx double,
  fix_laty double,
  recommended_fix_type varchar(25),
  recommended_fix_ident varchar(5),
  recommended_fix_region varchar(2),
  recommended_fix_lonx double,
  recommended_fix_laty double,
  is_flyover integer not null,
  is_true_course integer not null,
  course double,
  distance double,
  time double,
  theta double,
  rho double,
  altitude1 double,
  altitude2 double,
  speed_limit_type varchar(2),
  speed_limit integer,
  vertical_angle double,
 foreign key(transition_id) references transition(transition_id)
 );
`;

export type AtoolsRow = Record<string, string | number | null>;
export type AtoolsRows = Record<AtoolsTable, AtoolsRow[]>;

export interface LnmFixtureOverrides {
  /** Rows appended per table after the preset's own, ids chosen by the caller. */
  extra?: Partial<Record<AtoolsTable, AtoolsRow[]>>;
  /** Columns of the single metadata row to replace. */
  metadata?: AtoolsRow;
  /** Replaces metadata.properties; null stores NULL. */
  properties?: string | null;
  /** File name inside the target directory. */
  fileName?: string;
}

export interface LnmFixtureSpec extends LnmFixtureOverrides {
  /** The preset's rows; `metadata` holds exactly one. */
  rows: AtoolsRows;
}

/** A fresh directory on the scratch root; the caller removes it. */
export function makeLnmFixtureDir(): string {
  return fs.mkdtempSync(path.join(scratchDbRoot(), 'msfslogger-lnm-'));
}

// ── Completing rows ──────────────────────────────────────────────────────────

interface ColumnInfo { name: string; type: string; notnull: number; pk: number }

/** Columns that name, place or measure a row, so a zero would be a silent lie. */
const MUST_BE_GIVEN = /^(ident|name|type|lonx|laty|frequency|airway_name|airway_type)$|^(?!file_id$).*_id$/;

interface Completion { defaults: AtoolsRow; required: string[] }

function completionFor(db: Database.Database, table: AtoolsTable): Completion {
  const defaults: AtoolsRow = {};
  const required: string[] = [];
  for (const c of db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]) {
    if (c.notnull !== 1 || c.pk !== 0) continue;
    if (MUST_BE_GIVEN.test(c.name)) required.push(c.name);
    else defaults[c.name] = /^(integer|double)/i.test(c.type) ? 0 : '';
  }
  return { defaults, required };
}

function insertRows(
  db: Database.Database, table: AtoolsTable, rows: AtoolsRow[], completion: Completion,
  statements: Map<string, Database.Statement>,
): void {
  const known = new Set<string>(ATOOLS_COLUMNS[table]);
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!known.has(column)) throw new Error(`lnm fixture: ${table} has no column ${column}`);
    }
    const full = { ...completion.defaults, ...row };
    for (const column of completion.required) {
      if (!(column in full)) throw new Error(`lnm fixture: ${table} row must set ${column}`);
    }
    const names = Object.keys(full);
    const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(n => `@${n}`).join(', ')})`;
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    stmt.run(full);
  }
}

/**
 * Writes the fixture into `dir` and returns its path. The database is created
 * with foreign keys off: the schema points at a bgl_file table the subset does
 * not carry, and real files hold orphan rows (a com row with airport_id -1).
 */
export function buildLnmFixture(dir: string, spec: LnmFixtureSpec = navigraph()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, spec.fileName ?? 'atools.sqlite');
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = OFF');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.exec(ATOOLS_SUBSET_DDL);
    const tables = Object.keys(ATOOLS_COLUMNS) as AtoolsTable[];
    const statements = new Map<string, Database.Statement>();
    db.transaction(() => {
      for (const table of tables) {
        const completion = completionFor(db, table);
        let rows = spec.rows[table];
        if (table === 'metadata') {
          const merged: AtoolsRow = { ...rows[0], ...spec.metadata };
          if (spec.properties !== undefined) merged.properties = spec.properties;
          rows = [merged, ...rows.slice(1)];
        }
        insertRows(db, table, [...rows, ...(spec.extra?.[table] ?? [])], completion, statements);
      }
    })();
  } finally {
    db.close();
  }
  return file;
}

// ── Presets ──────────────────────────────────────────────────────────────────

type Flavour = 'NAVIGRAPH' | 'MSFS';
type FixKind = 'W' | 'T' | 'V' | 'N' | 'TN' | 'R';

/** Positions of the invented fixes, [lon, lat]. */
const POS: Record<string, readonly [number, number]> = {
  ZZV: [-166, 12.5], ZZT: [-165.5, 13], ZZD: [-164, 13.5], ZZN1: [-167, 13], ZZN2: [-165.1, 12.1],
  ZZW01: [-163, 12], ZZW02: [-162, 12], ZZW03: [-161, 12], ZZT01: [-165.2, 12.2], ZZW04: [180, 11],
  ZZW05: [0, 90], ZZW06: [179.5, 12], ZZW07: [-179.5, 12.5], ZZR01: [-160.5, 11.5], ZZW10: [-159, 10],
  RW27R: [-164.97, 12],
};

function presetRows(flavour: Flavour): AtoolsRows {
  const nav = flavour === 'NAVIGRAPH';
  /** The Navigraph value, or the MSFS one. */
  const pick = <T>(navigraph: T, msfs: T): T => (nav ? navigraph : msfs);
  const lon = (ident: string): number => POS[ident][0];
  const lat = (ident: string): number => POS[ident][1];

  // A fix's identity: MSFS calls terminal waypoints TW and terminal NDBs TN, Navigraph plain W and N.
  const fixIdent = (ident: string, kind: FixKind): AtoolsRow => ({
    fix_type: kind === 'T' ? pick('W', 'TW') : kind === 'TN' ? pick('N', 'TN') : kind,
    fix_ident: ident,
    fix_region: kind === 'R' ? null : 'ZZ',
    fix_airport_ident: kind === 'T' || kind === 'TN' || kind === 'R' ? 'ZZAA' : null,
  });
  // A leg's fix: Navigraph carries its coordinates, MSFS none. `at` names the POS entry when it differs from the ident.
  const fix = (ident: string, kind: FixKind, extra: AtoolsRow = {}, at = ident): AtoolsRow => ({
    ...fixIdent(ident, kind),
    fix_lonx: nav ? lon(at) : null,
    fix_laty: nav ? lat(at) : null,
    ...extra,
  });
  // A leg's recommended navaid or arc centre; an ILS has no type on Navigraph and L on MSFS.
  const recommended = (ident: string, kind: 'V' | 'W' | 'I'): AtoolsRow => ({
    recommended_fix_type: kind === 'I' ? pick(null, 'L') : kind,
    recommended_fix_ident: ident,
    recommended_fix_region: nav || kind === 'V' ? 'ZZ' : null,
    recommended_fix_lonx: nav && kind === 'V' ? lon(ident) : null,
    recommended_fix_laty: nav && kind === 'V' ? lat(ident) : null,
  });
  const descr = (code: string): AtoolsRow => ({ arinc_descr_code: pick(code, null) });
  const verticalAngle = pick(-3.0, -3.57);

  // ── metadata ───────────────────────────────────────────────────────────────
  const metadata: AtoolsRow = {
    db_version_major: 14, db_version_minor: 1, has_sid_star: 1, compiler_version: 'fixture 1.0',
    ...pick(
      { last_load_timestamp: '2026-09-30T20:15:00', airac_cycle: '2610', valid_through: '0110281026', data_source: 'NAVIGRAPH', properties: null },
      { last_load_timestamp: '2026-09-27T10:15:00', airac_cycle: null, valid_through: null, data_source: 'MSFS', properties: 'NavigraphUpdate=true\n' },
    ),
  };

  // ── airports, runways, frequencies ─────────────────────────────────────────
  const region = pick('ZZ', null);
  const airport: AtoolsRow[] = [
    { airport_id: 1, ident: 'ZZAA', name: 'Zed Alpha Intl', region, mag_var: 12.5, altitude: 50, lonx: -165, laty: 12,
      num_runways: 2, num_com: 5, num_approach: 6 },
    { airport_id: 2, ident: 'ZZAB', name: 'Zed Bravo Closed', region, mag_var: 12.5, altitude: 20, lonx: -164.5, laty: 12.5,
      is_closed: 1, num_runways: 1, num_com: pick(3, 1) },
    ...(nav ? [
      { airport_id: 3, ident: 'ZZAC', name: 'Zed Charlie North', region: 'ZZ', mag_var: 11, altitude: 10, lonx: -163.5, laty: 14, num_com: 1 },
      { airport_id: 4, ident: 'ZZAC', name: 'Zed Charlie South', region: 'ZY', mag_var: 11, altitude: 10, lonx: -158.5, laty: 9,
        num_runways: 1, num_com: 1 },
    ] : []),
  ];

  const end = (id: number, name: string, endType: string, heading: number, lonx: number, laty: number, extra: AtoolsRow = {}): AtoolsRow =>
    ({ runway_end_id: id, name, end_type: endType, heading, altitude: 50, lonx, laty, ...extra });
  const runway_end: AtoolsRow[] = [
    end(11, '09L', 'P', 90, -165.02, 12),
    end(12, '27R', 'S', 270, -164.97, 12, { offset_threshold: 300, ils_ident: 'IZZA' }),
    end(13, '18T', 'P', 180, -165, 12.02),
    end(14, '36', 'S', 0, -165, 11.98),
    end(15, '05', 'P', 50, -164.52, 12.48),
    end(16, '23', 'S', 230, -164.48, 12.52),
    ...(nav ? [end(17, '10', 'P', 100, -158.52, 9), end(18, '28', 'S', 280, -158.48, 9)] : []),
  ];
  const rwy = (id: number, airportId: number, primary: number, secondary: number, extra: AtoolsRow): AtoolsRow =>
    ({ runway_id: id, airport_id: airportId, primary_end_id: primary, secondary_end_id: secondary, heading: 90, altitude: 50, ...extra });
  const runway: AtoolsRow[] = [
    rwy(1, 1, 11, 12, { surface: pick(null, 'A'), length: 9000, width: 150, heading: 90, pattern_altitude: 1000, lonx: -165, laty: 12 }),
    rwy(2, 1, 13, 14, { surface: pick(null, 'G'), length: 5000, width: 0, heading: 180, pattern_altitude: 0, lonx: -165, laty: 12 }),
    rwy(3, 2, 15, 16, { surface: pick(null, 'CE'), length: 6000, width: 100, heading: 50, pattern_altitude: 800, lonx: -164.5, laty: 12.5 }),
    ...(nav ? [rwy(4, 4, 17, 18, { length: 4000, width: 80, heading: 100, pattern_altitude: 1000, lonx: -158.5, laty: 9 })] : []),
  ];

  // com.frequency: Navigraph kHz truncated to 10 kHz (118.325 MHz is 118320), MSFS Hz.
  const com = (id: number, airportId: number, type: string, name: string, navKhz: number, msfsHz: number): AtoolsRow =>
    ({ com_id: id, airport_id: airportId, type, name, frequency: pick(navKhz, msfsHz) });
  const comRows: AtoolsRow[] = [
    com(1, 1, 'T', 'ZZAA TOWER', 118320, 118_325_000),
    com(2, 1, 'G', 'ZZAA GROUND', 121700, 121_700_000),
    com(3, 1, 'A', 'ZZAA APPROACH', 119370, 119_375_000),
    com(4, 1, 'ATIS', 'ZZAA ATIS', 133600, 133_600_000),
    com(5, 1, 'A', 'ZZAA APPROACH UHF', 257820, 257_825_000),
    com(6, 2, 'UC', 'ZZAB UNICOM', 122800, 122_800_000),
    ...(nav ? [
      com(7, 2, 'FSS', 'ZZAB RADIO', 5655, 0),
      com(8, 2, 'ATIS', 'ZZAB NDB ATIS', 395, 0),
      com(20, 3, 'UC', 'ZZAC NORTH UNICOM', 122800, 0),
      com(21, 4, 'UC', 'ZZAC SOUTH UNICOM', 122900, 0),
    ] : []),
    com(99, -1, 'UC', 'ZZ ORPHAN', 122800, 122_800_000),
  ];

  // ── navaids ────────────────────────────────────────────────────────────────
  const range = (nm: number): number => pick(nm, Math.round(nm * 1.5));
  const vor: AtoolsRow[] = [
    { vor_id: 1, ident: 'ZZV', name: 'Zed Victor', region: 'ZZ', type: 'H', frequency: 112300, channel: '70X', range: range(130),
      mag_var: 12, altitude: 50, lonx: lon('ZZV'), laty: lat('ZZV'), dme_altitude: 50, dme_lonx: lon('ZZV'), dme_laty: lat('ZZV') },
    { vor_id: 2, ident: 'ZZT', name: 'Zed Tango TACAN', region: 'ZZ', type: 'TC', frequency: 108600, channel: '57X', range: range(130),
      mag_var: 12, altitude: 30, lonx: lon('ZZT'), laty: lat('ZZT'), dme_altitude: 30, dme_lonx: lon('ZZT'), dme_laty: lat('ZZT') },
    { vor_id: 3, ident: 'ZZD', name: 'Zed Delta DME', region: 'ZZ', type: 'L', frequency: 113500, channel: '82X', range: range(40),
      mag_var: 12, dme_only: 1, altitude: 10, lonx: lon('ZZD'), laty: lat('ZZD'), dme_altitude: 10, dme_lonx: lon('ZZD'), dme_laty: lat('ZZD') },
  ];
  const ndb: AtoolsRow[] = [
    { ndb_id: 1, ident: 'ZZN', name: 'Zed November', region: 'ZZ', type: pick('MH', 'H'), frequency: 37500, range: range(50),
      mag_var: 12, altitude: pick(null, 0), lonx: lon('ZZN1'), laty: lat('ZZN1') },
    { ndb_id: 2, ident: 'ZZN', name: 'Zed November at ZZAA', region: 'ZZ', airport_id: 1, airport_ident: 'ZZAA', type: pick('MH', 'H'),
      frequency: 37500, range: range(50), mag_var: 12, altitude: pick(null, 20), lonx: lon('ZZN2'), laty: lat('ZZN2') },
  ];
  const ils: AtoolsRow[] = [
    { ils_id: 1, ident: 'IZZA', name: 'Zed Alpha ILS 27R', region: pick('ZZ', null), type: pick('I', 'U'), frequency: 110500,
      range: 25, mag_var: 12, has_backcourse: pick(0, 1), gs_range: 10, gs_pitch: 3, gs_altitude: 50, gs_lonx: -164.99, gs_laty: 12,
      loc_runway_end_id: 12, loc_airport_ident: 'ZZAA', loc_runway_name: '27R', loc_heading: 270, loc_width: 4,
      altitude: pick(0, 50), lonx: -165.03, laty: 12 },
    { ils_id: 2, ident: 'ZZV', name: 'Zed Victor localizer', region: pick('ZZ', null), type: pick('L', '0'), frequency: 109100,
      range: 18, mag_var: 12, has_backcourse: 0, loc_runway_end_id: 11, loc_airport_ident: 'ZZAA', loc_runway_name: '09L',
      loc_heading: 90, loc_width: 5, altitude: pick(0, 50), lonx: -164.9, laty: 12 },
  ];

  // ── waypoints and airways ──────────────────────────────────────────────────
  const at = (key: string): AtoolsRow => ({ lonx: lon(key), laty: lat(key) });
  const wpt = (id: number, ident: string, type: string, extra: AtoolsRow = {}): AtoolsRow =>
    ({ waypoint_id: id, ident, type, region: 'ZZ', mag_var: 12, ...(ident in POS ? at(ident) : {}), ...extra });
  const waypoint: AtoolsRow[] = [
    // LNM's artificial copies of VOR 1 and NDBs 2 and 1: not waypoints of their own.
    wpt(1, 'ZZV', 'V', { nav_id: 1, artificial: 1 }),
    wpt(2, 'ZZN', 'N', { nav_id: 2, artificial: 1, ...at('ZZN2') }),
    wpt(3, 'ZZN', 'N', { nav_id: 1, artificial: 1, ...at('ZZN1') }),
    wpt(4, 'ZZW01', 'WN'),
    wpt(5, 'ZZW02', 'WN'),
    wpt(6, 'ZZW03', 'WU'),
    wpt(7, 'ZZT01', 'WN', { airport_id: 1, airport_ident: 'ZZAA' }),
    wpt(8, 'ZZW04', 'WN'),
    wpt(9, 'ZZW05', 'WN'),
    wpt(10, 'ZZW06', 'WN'),
    wpt(11, 'ZZW07', 'WN'),
    ...(nav ? [] : [
      wpt(13, 'ZZR01', 'RNAV'),
      // A VFR reporting point named like VOR ZZV in the same region, hundreds of km from it.
      wpt(14, 'ZZV', 'VFR', { lonx: -160, laty: 15 }),
      wpt(15, 'ZZW10', 'WN', { region: null }),
    ]),
  ];
  const airwayLeg = (id: number, name: string, type: string, seq: number, from: number, to: number): AtoolsRow => {
    const a = waypoint.find(w => w.waypoint_id === from)!;
    const b = waypoint.find(w => w.waypoint_id === to)!;
    const [x1, y1, x2, y2] = [a.lonx, a.laty, b.lonx, b.laty] as number[];
    return {
      airway_id: id, airway_name: name, airway_type: type, route_type: 'R', airway_fragment_no: 1, sequence_no: seq,
      from_waypoint_id: from, to_waypoint_id: to, from_lonx: x1, from_laty: y1, to_lonx: x2, to_laty: y2,
      left_lonx: Math.min(x1, x2), right_lonx: Math.max(x1, x2), top_laty: Math.max(y1, y2), bottom_laty: Math.min(y1, y2),
    };
  };
  const airway: AtoolsRow[] = [
    airwayLeg(1, 'ZZ1', 'V', 1, 4, 5),
    airwayLeg(2, 'ZZ1', 'V', 2, 5, 6),
    airwayLeg(3, 'ZZ2', 'J', 1, 2, 4),
    airwayLeg(4, 'ZZ3', 'B', 1, 1, 4),
    airwayLeg(5, 'ZZ4', 'V', 1, 10, 11),
  ];

  // ── procedures ─────────────────────────────────────────────────────────────
  const approach = (id: number, extra: AtoolsRow): AtoolsRow =>
    ({ approach_id: id, airport_id: 1, airport_ident: 'ZZAA', fix_type: 'W', fix_region: 'ZZ', ...extra });
  const procedure = (name: string, suffix: 'D' | 'A'): AtoolsRow =>
    ({ type: 'GPS', suffix, has_gps_overlay: 1, fix_ident: name });
  const ils27 = (arinc: string, faf: string, altitude: number): AtoolsRow => ({
    arinc_name: arinc, runway_name: '27R', runway_end_id: 12, type: 'ILS', has_vertical_angle: 1, fix_ident: faf,
    fix_airport_ident: 'ZZAA', altitude: pick(null, altitude), heading: pick(null, 270), missed_altitude: pick(null, 3000),
  });
  const approachRows: AtoolsRow[] = [
    approach(1, { ...procedure('ZZ1D', 'D'), arinc_name: 'RW09L', runway_name: '09L', runway_end_id: 11 }),
    approach(2, { ...procedure('ZZ1D', 'D'), arinc_name: 'RW27R', runway_name: '27R', runway_end_id: 12 }),
    approach(3, { ...procedure('ZZ2A', 'A'), arinc_name: 'ALL', runway_name: null }),
    approach(4, { ...procedure('ZZ2A', 'A'), arinc_name: 'RW27R', runway_name: '27R', runway_end_id: 12 }),
    approach(5, ils27('I27R', 'ZZW02', 2500)),
    approach(6, ils27('I27R-Z', 'ZZW03', 3000)),
  ];

  const leg = (approachId: number, type: string, extra: AtoolsRow = {}): AtoolsRow =>
    ({ approach_id: approachId, type, ...extra });
  const approach_leg: AtoolsRow[] = [
    // SID ZZ1D: two runway rows whose last two legs are the same.
    leg(1, 'CA', { course: 90, altitude1: 500, alt_descriptor: '+' }),
    leg(1, 'TF', fix('ZZW01', 'W')),
    leg(1, 'TF', fix('ZZW02', 'W')),
    leg(1, 'TF', fix('ZZW03', 'W')),
    leg(2, 'CA', { course: 270, altitude1: 500, alt_descriptor: '+' }),
    leg(2, 'TF', fix('ZZW02', 'W')),
    leg(2, 'TF', fix('ZZW03', 'W')),
    // STAR ZZ2A: an ALL row and a runway row sharing their first three legs.
    leg(3, 'IF', fix('ZZW03', 'W')),
    leg(3, 'TF', fix('ZZW02', 'W')),
    leg(3, 'TF', fix('ZZW01', 'W')),
    leg(4, 'IF', fix('ZZW03', 'W')),
    leg(4, 'TF', fix('ZZW02', 'W')),
    leg(4, 'TF', fix('ZZW01', 'W')),
    leg(4, 'CF', fix('ZZT01', 'T', { course: 270, distance: 4 })),
    // Approach 5: IF, a final-approach leg on the ILS, the runway fix with the vertical angle, then a missed approach with a hold.
    leg(5, 'IF', { ...fix('ZZW01', 'W'), ...descr('E   '), altitude1: 3000, alt_descriptor: 'A' }),
    leg(5, 'CF', { ...fix('ZZW02', 'W'), ...recommended('IZZA', 'I'), ...descr('EE F'), course: 270, distance: 8, altitude1: 2500, alt_descriptor: 'A', speed_limit: 210, speed_limit_type: '-' }),
    leg(5, 'TF', { ...fix('RW27R', 'R'), ...descr('E   '), distance: 5, altitude1: 100, altitude2: 120, alt_descriptor: 'B', vertical_angle: verticalAngle }),
    leg(5, 'CA', { is_missed: 1, course: 270, altitude1: 1500, alt_descriptor: '+' }),
    leg(5, 'DF', { ...fix('ZZN', 'TN', {}, 'ZZN2'), is_missed: 1, altitude1: 2000, alt_descriptor: '+' }),
    leg(5, 'HM', { ...fix('ZZW03', 'W'), is_missed: 1, course: 90, time: 1, turn_direction: 'R', altitude1: 3000, alt_descriptor: 'A' }),
    // Approach 6: an RF leg whose centre is a waypoint.
    leg(6, 'IF', fix('ZZW03', 'W')),
    leg(6, 'RF', { ...fix('ZZW02', 'W'), ...recommended('ZZW01', 'W'), turn_direction: 'L', rho: 2, theta: 30 }),
    leg(6, 'TF', fix('RW27R', 'R', { distance: 3 })),
  ];

  // MSFS fills every transition's DME columns with values that mean nothing; Navigraph only the DME arc's.
  const garbageDme = pick<AtoolsRow>({}, { dme_ident: 'ZZQ', dme_region: 'ZZ', dme_airport_ident: 'ZZAA', dme_radial: 0, dme_distance: 0 });
  const arcDme = pick<AtoolsRow>({ dme_ident: 'ZZV', dme_region: 'ZZ', dme_airport_ident: 'ZZAA', dme_radial: 45, dme_distance: 10 }, {});
  const transition = (id: number, approachId: number, type: string, ident: string, kind: FixKind, extra: AtoolsRow = {}): AtoolsRow => ({
    transition_id: id, approach_id: approachId, type, ...fixIdent(ident, kind), ...garbageDme, ...extra,
  });
  const transitionRows: AtoolsRow[] = [
    transition(1, 1, 'F', 'ZZW04', 'W'),
    transition(2, 2, 'F', 'ZZW04', 'W'),
    transition(3, 3, 'F', 'ZZW06', 'W'),
    transition(5, 5, 'F', 'ZZW03', 'W', { altitude: pick(null, 4000) }),
    transition(6, 5, 'F', 'ZZW03', 'W', { altitude: pick(null, 4000) }),
    transition(7, 5, 'D', 'ZZV', 'V', arcDme),
  ];

  const tleg = (transitionId: number, type: string, extra: AtoolsRow = {}): AtoolsRow =>
    ({ transition_id: transitionId, type, ...extra });
  const transition_leg: AtoolsRow[] = [
    tleg(1, 'TF', fix('ZZW04', 'W')),
    tleg(2, 'TF', fix('ZZW04', 'W')),
    tleg(3, 'IF', fix('ZZW06', 'W')),
    tleg(3, 'TF', fix('ZZW03', 'W')),
    tleg(5, 'IF', { ...fix('ZZW03', 'W'), ...descr('E  A'), altitude1: 4000, alt_descriptor: 'A' }),
    tleg(5, 'TF', fix('ZZW02', 'W')),
    tleg(6, 'IF', { ...fix('ZZW03', 'W'), ...descr('E  A'), altitude1: 3500, alt_descriptor: 'A' }),
    tleg(6, 'TF', fix('ZZW02', 'W')),
    tleg(7, 'IF', { ...fix('ZZV', 'V'), ...descr('E  A') }),
    tleg(7, 'AF', { ...fix('ZZW01', 'W'), ...recommended('ZZV', 'V'), turn_direction: 'L', theta: 45, rho: 10, altitude1: 3000, alt_descriptor: 'A' }),
    tleg(7, 'TF', fix('ZZW02', 'W')),
  ];

  return {
    metadata: [metadata], airport, runway, runway_end, com: comRows, vor, ndb, ils, waypoint, airway,
    approach: approachRows, approach_leg, transition: transitionRows, transition_leg,
  };
}

/** A Navigraph-flavoured atools file: AIRAC 2610, kHz frequencies, coordinates on every fix. */
export function navigraph(over: LnmFixtureOverrides = {}): LnmFixtureSpec {
  return { rows: presetRows('NAVIGRAPH'), fileName: 'atools-navigraph.sqlite', ...over };
}

/** An MSFS-flavoured atools file: no cycle, Hz frequencies, no leg coordinates, TW/TN/L fix codes. */
export function msfs(over: LnmFixtureOverrides = {}): LnmFixtureSpec {
  return { rows: presetRows('MSFS'), fileName: 'atools-msfs.sqlite', ...over };
}
