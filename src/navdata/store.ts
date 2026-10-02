// ── Applying sidecar rows to the replica ──────────────────────────────────────
//
// Every write into navdata.db goes through here, and every table merges by the
// same rules: a row is found by its key alone, and a column the sidecar did not
// send keeps whatever is stored. Any nav_* row can be assembled from more than
// one message — a runway's geometry and its ILS idents, an airport's position
// and its detail — arriving in either order, so no message may erase what
// another one filled in. NULL means "this fetch had no value"; 0 means the
// simulator reported zero, and the two are never conflated.
//
// One exception: nav_absent.first_seen_at only ever moves backwards.
//
// Writes use INSERT ... ON CONFLICT DO UPDATE, never INSERT OR REPLACE:
// REPLACE deletes the conflicting row first, which fires ON DELETE CASCADE and
// would drop an airport's runways, frequencies and procedures every time the
// airport row was touched.

import type Database from 'better-sqlite3';
import DatabaseCtor from 'better-sqlite3';
import { applyNavdataSchema } from './schema';
import {
  NAVDATA_SCHEMA_VERSION,
  NAVDATA_WIRE_VERSION,
  NAV_ROW_ORDER,
  type IncrementalAck,
  type IncrementalBatch,
  type NavRow,
  type NavRowType,
  type NavdataErrorCode,
  type Rev,
  type SnapshotHeaderLine,
  type SnapshotId,
} from './wire';
import { getNavDb } from './connection';

/** Rows the sender aims for in one incremental batch; a single-rev batch may exceed it. */
export const NAVDATA_MAX_BATCH_ROWS = 2000;

/** Rows above which any incremental batch is refused, single-rev or not. */
export const NAVDATA_BATCH_HARD_ROW_CEILING = 20000;

/** Largest JSON body accepted on the incremental rows route. */
export const NAVDATA_BATCH_MAX_BYTES = '4mb';

export type NavValue = string | number | null;

/** Carries what the sync routes have to answer with, so the HTTP layer maps rather than decides. */
export class NavdataStoreError extends Error {
  readonly code: NavdataErrorCode;
  readonly status: number;
  readonly serverSnapshotId?: SnapshotId | null;
  readonly serverRev?: Rev;
  readonly serverSchemaVersion?: number;

  constructor(
    code: NavdataErrorCode,
    message: string,
    extra: {
      status?: number;
      serverSnapshotId?: SnapshotId | null;
      serverRev?: Rev;
      serverSchemaVersion?: number;
    } = {},
  ) {
    super(message);
    this.name = 'NavdataStoreError';
    this.code = code;
    this.status = extra.status ?? 400;
    if ('serverSnapshotId' in extra) this.serverSnapshotId = extra.serverSnapshotId;
    if (extra.serverRev !== undefined) this.serverRev = extra.serverRev;
    if (extra.serverSchemaVersion !== undefined) this.serverSchemaVersion = extra.serverSchemaVersion;
  }
}

const badBatch = (message: string): NavdataStoreError =>
  new NavdataStoreError('NAVDATA_BAD_BATCH', message, { status: 400 });

// ── Table geometry, derived from the DDL itself ───────────────────────────────

const TABLE_FOR_ROW: Record<NavRowType, string> = {
  airport: 'nav_airport',
  navaid: 'nav_navaid',
  waypoint: 'nav_waypoint',
  airway_leg: 'nav_airway_leg',
  runway: 'nav_runway',
  frequency: 'nav_airport_frequency',
  procedure: 'nav_procedure',
  procedure_transition: 'nav_procedure_transition',
  procedure_leg: 'nav_procedure_leg',
  coverage_cell: 'nav_coverage_cell',
  absent: 'nav_absent',
};

const KEY_COLUMNS: Record<NavRowType, readonly string[]> = {
  airport: ['ident'],
  navaid: ['kind', 'ident', 'region'],
  waypoint: ['wpt_key'],
  airway_leg: ['leg_key'],
  runway: ['rwy_key'],
  frequency: ['freq_key'],
  procedure: ['proc_key'],
  procedure_transition: ['trans_key'],
  procedure_leg: ['trans_key', 'seq'],
  coverage_cell: ['kind', 'cell_id'],
  absent: ['kind', 'ident', 'region'],
};

/** Overwritten or kept as a unit, by source precedence, on the tables that carry them. */
const POSITION_COLUMNS = ['lat', 'lon', 'alt_m', 'position_source', 'position_fetched_at'] as const;
const POSITION_RANK: Record<string, number> = { facility: 3, list: 2, minimal: 1, route: 1 };

/** A row's own revision is the sidecar's bookkeeping and never a reason to rewrite a row. */
const REV_COLUMN = 'rev';

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: number;
  defaultValue: NavValue | undefined;
}

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function parseDefault(raw: string | null): NavValue | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  const quoted = /^'(.*)'$/s.exec(t);
  if (quoted) return quoted[1].replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.toUpperCase() === 'NULL') return null;
  return undefined;
}

function readTableInfo(db: Database.Database, table: string): ColumnInfo[] {
  const rows = db.pragma(`table_info(${table})`) as PragmaColumn[];
  return rows.map(c => ({
    name: c.name,
    type: c.type,
    notNull: c.notnull !== 0,
    pk: c.pk,
    defaultValue: parseDefault(c.dflt_value),
  }));
}

let expectedColumns: Map<string, ColumnInfo[]> | null = null;

/**
 * Column layout of every nav_* table, read back from a throwaway in-memory
 * database built with the shipped DDL — so the validator and the schema can
 * never drift apart by a hand-maintained list.
 */
export function expectedNavdataColumns(): Map<string, ColumnInfo[]> {
  if (expectedColumns) return expectedColumns;
  const mem = new DatabaseCtor(':memory:');
  try {
    applyNavdataSchema(mem);
    const names = (
      mem.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nav\\_%' ESCAPE '\\' ORDER BY name").all() as
        { name: string }[]
    ).map(r => r.name);
    const map = new Map<string, ColumnInfo[]>();
    for (const name of names) map.set(name, readTableInfo(mem, name));
    expectedColumns = map;
  } finally {
    mem.close();
  }
  return expectedColumns;
}

const signature = (cols: ColumnInfo[]): string =>
  cols.map(c => `${c.name}:${c.type}:${c.notNull ? 1 : 0}:${c.pk}`).join(',');

/**
 * Refuses a replica whose tables differ from the shipped DDL by so much as a
 * column, beyond the schema_version number it also carries. A file that
 * announces version 1 but was written by a different build of the sidecar is
 * more dangerous than no file at all.
 */
export function verifyNavdataColumns(db: Database.Database): void {
  for (const [table, expect] of expectedNavdataColumns()) {
    const actual = readTableInfo(db, table);
    if (actual.length === 0) {
      throw new NavdataStoreError('NAVDATA_SCHEMA_UNSUPPORTED', `navdata replica is missing table ${table}`, {
        status: 409,
        serverSchemaVersion: NAVDATA_SCHEMA_VERSION,
      });
    }
    if (signature(actual) !== signature(expect)) {
      throw new NavdataStoreError(
        'NAVDATA_SCHEMA_UNSUPPORTED',
        `navdata replica table ${table} has columns [${actual.map(c => c.name).join(', ')}], ` +
          `expected [${expect.map(c => c.name).join(', ')}]`,
        { status: 409, serverSchemaVersion: NAVDATA_SCHEMA_VERSION },
      );
    }
  }
}

function columnsOf(table: string): ColumnInfo[] {
  const cols = expectedNavdataColumns().get(table);
  if (!cols) throw badBatch(`unknown navdata table ${table}`);
  return cols;
}

// ── Row validation ───────────────────────────────────────────────────────────

interface ValidRow {
  type: NavRowType;
  table: string;
  values: Record<string, NavValue>;
}

function validateRow(row: NavRow, index: number): ValidRow {
  const where = `row ${index}`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw badBatch(`${where} is not an object`);
  const table = TABLE_FOR_ROW[row.t];
  if (!table) throw badBatch(`${where} has unknown type ${JSON.stringify(row.t)}`);
  const r = row.r;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw badBatch(`${where} (${row.t}) has no column object`);

  const known = new Set(columnsOf(table).map(c => c.name));
  const values: Record<string, NavValue> = {};
  for (const [key, value] of Object.entries(r)) {
    if (!known.has(key)) throw badBatch(`${where} (${row.t}) has unknown column ${JSON.stringify(key)}`);
    if (value === null) {
      values[key] = null;
    } else if (typeof value === 'string') {
      values[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      values[key] = value;
    } else {
      throw badBatch(`${where} (${row.t}) column ${key} is not a string, number or null`);
    }
  }
  const rev = values[REV_COLUMN];
  if (typeof rev !== 'number' || !Number.isInteger(rev)) throw badBatch(`${where} (${row.t}) has no integer rev`);
  return { type: row.t, table, values };
}

/** Key value as written, falling back to the column's DDL default when the row omits it. */
function keyValue(row: ValidRow, column: string): NavValue {
  if (Object.prototype.hasOwnProperty.call(row.values, column)) {
    const v = row.values[column];
    if (v !== null) return v;
    throw badBatch(`${row.type} row has a null key column ${column}`);
  }
  const info = columnsOf(row.table).find(c => c.name === column);
  if (info && info.defaultValue !== undefined && info.defaultValue !== null) return info.defaultValue;
  throw badBatch(`${row.type} row is missing key column ${column}`);
}

// ── Writing ──────────────────────────────────────────────────────────────────

const quoteList = (cols: readonly string[]): string => cols.join(', ');

function conflictUpdate(table: string, keyCols: readonly string[], cols: readonly string[]): string {
  const updatable = cols.filter(c => !keyCols.includes(c));
  if (updatable.length === 0) return `ON CONFLICT (${quoteList(keyCols)}) DO NOTHING`;
  const assignments = updatable.map(c => `${c} = excluded.${c}`);
  const changed = updatable.map(c => `${table}.${c} IS NOT excluded.${c}`).join(' OR ');
  return `ON CONFLICT (${quoteList(keyCols)}) DO UPDATE SET ${assignments.join(', ')} WHERE ${changed}`;
}

/** Returns true when the statement inserted or updated a row. */
function upsert(
  db: Database.Database,
  table: string,
  keyCols: readonly string[],
  values: Record<string, NavValue>,
): boolean {
  const cols = Object.keys(values);
  const sql =
    `INSERT INTO ${table} (${quoteList(cols)}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    conflictUpdate(table, keyCols, cols);
  const info = db.prepare(sql).run(...cols.map(c => values[c]));
  return info.changes > 0;
}

function rankOf(source: NavValue | undefined): number | null {
  return typeof source === 'string' && POSITION_RANK[source] !== undefined ? POSITION_RANK[source] : null;
}

const isCoordinate = (v: NavValue | undefined): boolean => typeof v === 'number' && Number.isFinite(v);

/**
 * Drops a position source that no latitude and longitude back up. Letting it
 * through would label a position with a precedence it was never fetched at,
 * and every later report from the real source would then be refused as a
 * demotion.
 */
function withoutUnbackedPositionSource(values: Record<string, NavValue>): Record<string, NavValue> {
  if (values.position_source == null) return values;
  if (isCoordinate(values.lat) && isCoordinate(values.lon)) return values;
  const copy = { ...values };
  delete copy.position_source;
  delete copy.position_fetched_at;
  return copy;
}

/**
 * The one merge policy, used by every table: identity columns stay as stored,
 * a column the row omits (or sends as null) keeps its stored value, and a
 * position moves as a unit by source precedence on the tables that record one.
 * A lower-ranked source only fills positions that are still missing — but a
 * stored row with no position source at all takes any incoming position, since
 * there is nothing there to demote.
 *
 * first_seen_at is the single column that is neither kept nor replaced: it
 * means what its name says, so it takes the earlier of the two.
 */
function mergeValues(
  table: string,
  keyCols: readonly string[],
  stored: Record<string, NavValue>,
  incoming: Record<string, NavValue>,
): Record<string, NavValue> {
  const storedRank = rankOf(stored.position_source);
  const incomingRank = rankOf(incoming.position_source);
  const fillPositionOnly = storedRank !== null && incomingRank !== null && incomingRank < storedRank;
  const positionCols = new Set<string>(POSITION_COLUMNS.filter(c => c in stored));

  const merged: Record<string, NavValue> = {};
  for (const col of columnsOf(table)) {
    const name = col.name;
    const storedValue = stored[name] ?? null;
    const incomingValue = Object.prototype.hasOwnProperty.call(incoming, name) ? incoming[name] : null;
    if (keyCols.includes(name)) {
      merged[name] = storedValue;
    } else if (table === 'nav_absent' && name === 'first_seen_at') {
      merged[name] =
        typeof storedValue === 'number' && typeof incomingValue === 'number'
          ? Math.min(storedValue, incomingValue)
          : incomingValue !== null ? incomingValue : storedValue;
    } else if (fillPositionOnly && positionCols.has(name)) {
      merged[name] = storedValue !== null ? storedValue : incomingValue;
    } else {
      merged[name] = incomingValue !== null ? incomingValue : storedValue;
    }
  }
  return merged;
}

/** True when the merged row would change something the replica actually serves. */
function differs(table: string, merged: Record<string, NavValue>, stored: Record<string, NavValue>): boolean {
  for (const col of columnsOf(table)) {
    if (col.name === REV_COLUMN) continue;
    if (!Object.is(merged[col.name] ?? null, stored[col.name] ?? null)) return true;
  }
  return false;
}

/** Reads the stored row, merges in code, and writes only when something changed. */
function applyMerged(db: Database.Database, row: ValidRow): boolean {
  const keyCols = KEY_COLUMNS[row.type];
  const keys = keyCols.map(c => keyValue(row, c));
  const incoming = withoutUnbackedPositionSource(row.values);
  const stored = db
    .prepare(`SELECT * FROM ${row.table} WHERE ${keyCols.map(c => `${c} = ?`).join(' AND ')}`)
    .get(...keys) as Record<string, NavValue> | undefined;

  if (!stored) {
    // Only the columns the sidecar sent, so the DDL's own defaults fill the rest.
    return upsert(db, row.table, keyCols, incoming);
  }
  const merged = mergeValues(row.table, keyCols, stored, incoming);
  if (!differs(row.table, merged, stored)) return false;
  return upsert(db, row.table, keyCols, merged);
}

/** An airport known to be missing from the simulator is recorded on its own row when it has one. */
function markAirportAbsent(db: Database.Database, ident: NavValue, rev: NavValue): void {
  db.prepare(
    "UPDATE nav_airport SET detail_state = 'absent', rev = ? WHERE ident = ? AND detail_state != 'absent'",
  ).run(rev, ident);
}

/** Applies one row. Returns true when the replica changed. */
export function applyNavRow(db: Database.Database, row: NavRow, index = 0): boolean {
  const valid = validateRow(row, index);
  const keyCols = KEY_COLUMNS[valid.type];
  for (const c of keyCols) keyValue(valid, c);

  const wrote = applyMerged(db, valid);
  if (valid.type === 'absent' && valid.values.kind === 'A') {
    markAirportAbsent(db, keyValue(valid, 'ident'), valid.values.rev ?? 0);
  }
  return wrote;
}

export interface ApplyResult {
  /** Rows that actually changed the replica. */
  applied: number;
  /** Per row type, rows that actually changed the replica. */
  counts: Partial<Record<NavRowType, number>>;
}

/**
 * Applies a batch in one transaction. `sort` puts the rows in parents-first
 * order (stable within a type) for an incremental batch; a snapshot already
 * arrives that way and keeps its own order.
 */
export function applyNavRows(db: Database.Database, rows: NavRow[], opts: { sort?: boolean } = {}): ApplyResult {
  if (!Array.isArray(rows)) throw badBatch('rows is not an array');
  const ordered = opts.sort
    ? rows
        .map((row, i) => ({ row, i }))
        .sort((a, b) => {
          const ra = NAV_ROW_ORDER.indexOf(a.row?.t);
          const rb = NAV_ROW_ORDER.indexOf(b.row?.t);
          return ra === rb ? a.i - b.i : ra - rb;
        })
        .map(e => e.row)
    : rows;

  const result: ApplyResult = { applied: 0, counts: {} };
  let current: NavRow | undefined;
  const run = db.transaction(() => {
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i];
      current = row;
      if (applyNavRow(db, row, i)) {
        result.applied += 1;
        result.counts[row.t] = (result.counts[row.t] ?? 0) + 1;
      }
    }
  });
  try {
    run();
  } catch (err) {
    // A row the schema refuses (a child of a missing parent, say) is the
    // sender's fault, not the server's; the transaction has already rolled back.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw badBatch(`a ${current?.t ?? 'row'} row violates a constraint (${code}); the batch was not applied`);
    }
    throw err;
  }
  return result;
}

// ── nav_meta ─────────────────────────────────────────────────────────────────

export interface NavMetaRow {
  id: number;
  schema_version: number;
  snapshot_id: string;
  rev: number;
  sim_id: string;
  sim_app_name: string | null;
  sim_app_version: string | null;
  bulk_started_at: number | null;
  bulk_completed_at: number | null;
  bulk_row_count: number;
  created_at: number;
  updated_at: number;
}

const writeGenerations = new WeakMap<Database.Database, number>();

/**
 * Counts writes of one database handle's replica header: every applied batch and
 * every snapshot import to that handle bumps its count, so a reader that
 * remembers anything derived from the rows can tell they changed even when the
 * snapshot id, revision and timestamp did not. A write to another handle (the
 * simulator replica versus the Little Navmap one) leaves this count alone.
 */
export const navdataWriteGeneration = (db: Database.Database): number => writeGenerations.get(db) ?? 0;

const bumpWriteGeneration = (db: Database.Database): void => {
  writeGenerations.set(db, navdataWriteGeneration(db) + 1);
};

export function readNavMeta(db: Database.Database): NavMetaRow | null {
  return (db.prepare('SELECT * FROM nav_meta WHERE id = 1').get() as NavMetaRow | undefined) ?? null;
}

/** The one row the server owns inside the replica, written from a snapshot header. */
export function writeNavMeta(db: Database.Database, header: SnapshotHeaderLine, updatedAt: number): void {
  bumpWriteGeneration(db);
  const bulk = header as unknown as {
    bulkStartedAt?: number | null;
    bulkCompletedAt?: number | null;
    bulkRowCount?: number | null;
  };
  db.prepare(
    `INSERT INTO nav_meta (
       id, schema_version, snapshot_id, rev, sim_id, sim_app_name, sim_app_version,
       bulk_started_at, bulk_completed_at, bulk_row_count, created_at, updated_at
     ) VALUES (1, @schema_version, @snapshot_id, @rev, @sim_id, @sim_app_name, @sim_app_version,
       @bulk_started_at, @bulk_completed_at, @bulk_row_count, @created_at, @updated_at)
     ON CONFLICT (id) DO UPDATE SET
       schema_version = excluded.schema_version, snapshot_id = excluded.snapshot_id,
       rev = excluded.rev, sim_id = excluded.sim_id, sim_app_name = excluded.sim_app_name,
       sim_app_version = excluded.sim_app_version, bulk_started_at = excluded.bulk_started_at,
       bulk_completed_at = excluded.bulk_completed_at, bulk_row_count = excluded.bulk_row_count,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
  ).run({
    schema_version: header.schemaVersion,
    snapshot_id: header.snapshotId,
    rev: header.rev,
    sim_id: header.simId,
    sim_app_name: header.simAppName ?? null,
    sim_app_version: header.simAppVersion ?? null,
    bulk_started_at: bulk.bulkStartedAt ?? null,
    bulk_completed_at: bulk.bulkCompletedAt ?? null,
    bulk_row_count: bulk.bulkRowCount ?? 0,
    created_at: header.createdAt,
    updated_at: updatedAt,
  });
}

export function setNavMetaRev(db: Database.Database, rev: Rev, updatedAt: number): void {
  bumpWriteGeneration(db);
  db.prepare('UPDATE nav_meta SET rev = ?, updated_at = ? WHERE id = 1').run(rev, updatedAt);
}

// ── Incremental batches ──────────────────────────────────────────────────────

function isSingleRev(rows: NavRow[]): boolean {
  const first = rows[0]?.r?.rev;
  if (typeof first !== 'number' || !Number.isInteger(first)) return false;
  return rows.every(row => row?.r?.rev === first);
}

/**
 * Applies an incremental batch to the live replica. Every refusal carries the
 * code and status the sync route answers with; a revision is only meaningful
 * inside its own epoch, so a batch for another snapshot is refused rather than
 * merged.
 */
export function applyIncrementalBatch(batch: IncrementalBatch, now: number = Date.now()): IncrementalAck {
  if (!batch || typeof batch !== 'object') throw badBatch('batch is not an object');
  if (batch.v !== NAVDATA_WIRE_VERSION || batch.schemaVersion !== NAVDATA_SCHEMA_VERSION) {
    throw new NavdataStoreError(
      'NAVDATA_SCHEMA_UNSUPPORTED',
      `batch declares v ${batch.v} / schema ${batch.schemaVersion}`,
      { status: 409, serverSchemaVersion: NAVDATA_SCHEMA_VERSION },
    );
  }

  const db = getNavDb();
  const meta = db ? readNavMeta(db) : null;
  if (!db || !meta || meta.snapshot_id !== batch.snapshotId) {
    throw new NavdataStoreError(
      'NAVDATA_SNAPSHOT_MISMATCH',
      meta ? `replica holds snapshot ${meta.snapshot_id}` : 'no navdata replica is present',
      { status: 409, serverSnapshotId: meta ? meta.snapshot_id : null, serverRev: meta ? meta.rev : 0 },
    );
  }

  if (!Array.isArray(batch.rows)) throw badBatch('rows is not an array');
  if (batch.rows.length > NAVDATA_BATCH_HARD_ROW_CEILING) {
    throw badBatch(`batch carries ${batch.rows.length} rows, more than ${NAVDATA_BATCH_HARD_ROW_CEILING}`);
  }
  // A revision's rows are written in one transaction on the sender and never
  // split, so only a batch that stays inside one rev may outgrow the target.
  if (batch.rows.length > NAVDATA_MAX_BATCH_ROWS && !isSingleRev(batch.rows)) {
    throw badBatch(
      `batch of ${batch.rows.length} rows spans more than one rev; only a single-rev batch may exceed ${NAVDATA_MAX_BATCH_ROWS} rows`,
    );
  }
  if (!Number.isInteger(batch.toRev)) throw badBatch('toRev is not an integer');
  if (Number.isInteger(batch.fromRev) && batch.fromRev !== meta.rev) {
    console.warn(`navdata: batch starts at rev ${batch.fromRev} but the replica is at rev ${meta.rev}`);
  }

  let applied = 0;
  const run = db.transaction(() => {
    applied = applyNavRows(db, batch.rows, { sort: true }).applied;
    setNavMetaRev(db, batch.toRev, now);
  });
  run();
  return { ok: true, snapshotId: batch.snapshotId, rev: batch.toRev, applied };
}
