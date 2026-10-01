// ── Navdata dataset label and validity ───────────────────────────────────────
//
// What a replica file is: which source it came from, the human label shown next
// to the map, and whether its validity window has passed. The simulator replica
// carries only a nav_meta row; the Little Navmap replica also carries one
// lnm_dataset row (structured cycle, validity and data source), which swaps
// atomically with the data it describes.

import type Database from 'better-sqlite3';

export type NavdataSource = 'mcdu' | 'lnm';
export type LnmDataSource = 'NAVIGRAPH' | 'MSFS' | 'MSFS24';

export interface NavdataDataset {
  /** Which replica this describes. */
  source: NavdataSource;
  /** Human text, computed once at import; never parsed by anyone. */
  label: string;
  /** Little Navmap metadata.data_source; null for the simulator replica. */
  provider: LnmDataSource | null;
  /** 'YYNN'; null when the dataset has none. */
  airacCycle: string | null;
  /** 'YYYY-MM-DD', a UTC calendar date, inclusive. */
  validFrom: string | null;
  /** 'YYYY-MM-DD', a UTC calendar date, inclusive. */
  validThrough: string | null;
  /** null = not knowable (no validThrough). */
  expired: boolean | null;
  /** Little Navmap metadata.last_load_timestamp verbatim: zone-less local time text, never parsed. */
  compiledAt: string | null;
  /** Little Navmap properties NavigraphUpdate=true; null when not stated. */
  navigraphUpdate: boolean | null;
  /** Epoch ms: lnm_dataset.imported_at, or the simulator replica's nav_meta.created_at. */
  importedAt: number | null;
}

/** Same three facts as the status response, under different names: selected is
 *  selectedSource, effective is source, fallback is sourceFallback. */
export interface NavdataSourceResponse {
  selected: NavdataSource;
  effective: NavdataSource;
  /** Set iff selected is 'lnm' and effective is 'mcdu'. */
  fallback: null | 'lnm-unavailable';
  mcdu: { present: boolean; dataset: NavdataDataset | null };
  lnm: { present: boolean; dataset: NavdataDataset | null };
  /** The directory a server-side import reads from, absolute. */
  importDir: string;
}

/** The one extra table only the Little Navmap replica carries. Not part of the
 *  frozen replica schema, so it is neither sent over the sidecar wire nor
 *  checked by the column verifier. */
export const LNM_DATASET_DDL = `
CREATE TABLE IF NOT EXISTS lnm_dataset (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_id        TEXT    NOT NULL,
  data_source        TEXT    NOT NULL CHECK (data_source IN ('NAVIGRAPH','MSFS','MSFS24')),
  airac_cycle        TEXT,
  valid_from         TEXT,
  valid_through      TEXT,
  compiled_at        TEXT,
  navigraph_update   INTEGER CHECK (navigraph_update IN (0,1)),
  atools_db_version  TEXT,
  source_file_name   TEXT    NOT NULL,
  source_bytes       INTEGER NOT NULL,
  imported_at        INTEGER NOT NULL,
  label              TEXT    NOT NULL
) STRICT;`;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An AIRAC cycle's last valid day is the day before the next cycle takes effect,
 * and the switch happens at 00:00Z of that next day, so a dataset is expired
 * from 00:00Z on the day after validThrough. null when there is no usable date.
 */
export function isExpired(validThrough: string | null, now: number): boolean | null {
  if (validThrough === null) return null;
  const m = DATE_ONLY.exec(validThrough);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const end = Date.UTC(year, month - 1, day + 1);
  return Number.isFinite(end) ? now >= end : null;
}

interface MetaRow {
  snapshot_id: string;
  sim_app_name: string | null;
  sim_app_version: string | null;
  created_at: number;
}

interface LnmDatasetRow {
  data_source: LnmDataSource;
  airac_cycle: string | null;
  valid_from: string | null;
  valid_through: string | null;
  compiled_at: string | null;
  navigraph_update: number | null;
  imported_at: number;
  label: string;
}

const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);

function lnmDatasetRow(nav: Database.Database, snapshotId: string): LnmDatasetRow | null {
  const table = nav.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lnm_dataset'").get();
  if (!table) return null;
  const row = nav.prepare(
    `SELECT data_source, airac_cycle, valid_from, valid_through, compiled_at, navigraph_update, imported_at, label
       FROM lnm_dataset WHERE id = 1 AND snapshot_id = ?`,
  ).get(snapshotId) as LnmDatasetRow | undefined;
  return row ?? null;
}

/**
 * Describes the replica behind `nav`, for the source it is held under. null when
 * there is no handle or no nav_meta row (the same condition the status response
 * calls "not present"). A Little Navmap file without a matching lnm_dataset row
 * (built by other code) still gets a label, with every structured field null.
 */
export function readNavdataDataset(
  nav: Database.Database | null,
  source: NavdataSource,
  now: number,
): NavdataDataset | null {
  if (!nav) return null;
  const meta = nav.prepare(
    'SELECT snapshot_id, sim_app_name, sim_app_version, created_at FROM nav_meta WHERE id = 1',
  ).get() as MetaRow | undefined;
  if (!meta) return null;

  if (source === 'lnm') {
    const row = lnmDatasetRow(nav, meta.snapshot_id);
    if (row) {
      return {
        source: 'lnm',
        label: row.label,
        provider: row.data_source,
        airacCycle: row.airac_cycle,
        validFrom: row.valid_from,
        validThrough: row.valid_through,
        expired: isExpired(row.valid_through, now),
        compiledAt: row.compiled_at,
        navigraphUpdate: bool(row.navigraph_update),
        importedAt: row.imported_at,
      };
    }
    return {
      source: 'lnm',
      label: meta.sim_app_version ?? 'Little Navmap import',
      provider: null, airacCycle: null, validFrom: null, validThrough: null, expired: null,
      compiledAt: null, navigraphUpdate: null,
      importedAt: meta.created_at,
    };
  }

  const label = meta.sim_app_name === null
    ? 'Simulator'
    : `Simulator (${meta.sim_app_name}${meta.sim_app_version ? ' ' + meta.sim_app_version : ''})`;
  return {
    source: 'mcdu',
    label,
    provider: null, airacCycle: null, validFrom: null, validThrough: null, expired: null,
    compiledAt: null, navigraphUpdate: null,
    importedAt: meta.created_at,
  };
}
