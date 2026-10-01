// ── Little Navmap dataset metadata ───────────────────────────────────────────
//
// What the replica says about itself: which cycle (or which simulator build) it
// holds, the window it is valid for, and the label shown beside the map. The
// pure parsers turn the atools `metadata` row into those facts; writeLnmMeta
// stores them as the lnm_dataset row and the nav_meta header, last, so a file
// that carries a header is a file whose rows are all in.

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isExpired, type LnmDataSource, type NavdataDataset } from '../dataset';
import { writeNavMeta } from '../store';
import { NAVDATA_SCHEMA_VERSION } from '../wire';
import type { AtoolsMetadata } from './types';

const DAY_MS = 86_400_000;
const AIRAC_PERIOD_MS = 28 * DAY_MS;
/** AIRAC 2001 took effect on 2020-01-02; every later cycle is a whole number of 28-day periods on. */
const AIRAC_REFERENCE_MS = Date.UTC(2020, 0, 2);

const PROVIDER_NAME: Record<LnmDataSource, string> = {
  NAVIGRAPH: 'Navigraph',
  MSFS: 'MSFS 2020',
  MSFS24: 'MSFS 2024',
};

/** The replica's sim_id has to be one of '2020', '2024', 'fsx'; no code branches on it. */
const SIM_ID: Record<LnmDataSource, '2020' | '2024'> = {
  NAVIGRAPH: '2024',
  MSFS: '2020',
  MSFS24: '2024',
};

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** metadata.properties holds `Key=value` lines; NavigraphUpdate=true marks an MSFS file built over Navigraph data. */
export function parseNavigraphUpdate(properties: string | null | undefined): boolean | null {
  if (properties == null) return null;
  for (const line of properties.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('NavigraphUpdate=')) continue;
    const value = trimmed.slice('NavigraphUpdate='.length);
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

/** 'YYNN', kept only when it is exactly four digits. */
export function parseAiracCycle(raw: string | null | undefined): string | null {
  const cycle = (raw ?? '').trim();
  return /^\d{4}$/.test(cycle) ? cycle : null;
}

export interface Validity { validFrom: string | null; validThrough: string | null }

/** Both dates in 'YYYY-MM-DD', or null when the day does not exist (a 31st of February). */
function calendarMs(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : null;
}

/** metadata.valid_through as `fromDD fromMM toDD toMM YY`; a cycle over New Year starts in the year before it ends. */
function validityFromRange(raw: string | null | undefined): Validity | null {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const [fromDay, fromMonth, toDay, toMonth, yy] = m.slice(1).map(Number);
  const toYear = 2000 + yy;
  const fromYear = fromMonth <= toMonth ? toYear : toYear - 1;
  const from = calendarMs(fromYear, fromMonth, fromDay);
  const through = calendarMs(toYear, toMonth, toDay);
  if (from === null || through === null || from > through) return null;
  return { validFrom: isoDate(from), validThrough: isoDate(through) };
}

/** The AIRAC calendar: cycle NN of year YY starts (NN - 1) periods after the first period start of that year. */
function validityFromCycle(cycle: string | null): Validity | null {
  if (cycle === null) return null;
  const year = 2000 + Number(cycle.slice(0, 2));
  const number = Number(cycle.slice(2));
  if (number < 1) return null;
  const periodsBefore = Math.ceil((Date.UTC(year, 0, 1) - AIRAC_REFERENCE_MS) / AIRAC_PERIOD_MS);
  const first = AIRAC_REFERENCE_MS + periodsBefore * AIRAC_PERIOD_MS;
  const from = first + (number - 1) * AIRAC_PERIOD_MS;
  if (new Date(from).getUTCFullYear() !== year) return null;
  return { validFrom: isoDate(from), validThrough: isoDate(from + 27 * DAY_MS) };
}

/**
 * The validity window, by the first rule that yields one: the explicit range
 * the file carries, then the AIRAC calendar for its cycle, else neither date.
 */
export function parseValidity(
  validThrough: string | null | undefined,
  airacCycle: string | null | undefined,
): Validity {
  return validityFromRange(validThrough)
    ?? validityFromCycle(parseAiracCycle(airacCycle))
    ?? { validFrom: null, validThrough: null };
}

export interface LabelInput {
  provider: LnmDataSource;
  airacCycle: string | null;
  navigraphUpdate: boolean | null;
  /** metadata.last_load_timestamp: zone-less local time text, used for its calendar date only. */
  compiledAt: string | null;
}

/**
 * The text shown beside the map: 'Navigraph AIRAC 2610', or for a file with no cycle
 * 'MSFS 2020 scenery with Navigraph update, compiled 2026-09-27'.
 */
export function datasetLabel(input: LabelInput): string {
  const name = PROVIDER_NAME[input.provider];
  if (input.airacCycle !== null) return `${name} AIRAC ${input.airacCycle}`;
  const compiled = input.compiledAt !== null && /^\d{4}-\d{2}-\d{2}/.test(input.compiledAt)
    ? `, compiled ${input.compiledAt.slice(0, 10)}`
    : '';
  return `${name} scenery${input.navigraphUpdate === true ? ' with Navigraph update' : ''}${compiled}`;
}

export interface WriteLnmMetaInput {
  provider: LnmDataSource;
  metadata: AtoolsMetadata;
  /** Basename of the atools file, never a path. */
  sourceFileName: string;
  sourceBytes: number;
  /** Import start and end, epoch ms. */
  startedAt: number;
  completedAt: number;
}

/**
 * Writes the lnm_dataset row and then the nav_meta header into a replica whose
 * rows are all in. The replica must already carry the lnm_dataset table.
 * Returns what the status response will report for the file.
 */
export function writeLnmMeta(
  out: Database.Database,
  input: WriteLnmMetaInput,
): { snapshotId: string; dataset: NavdataDataset } {
  const { provider, metadata } = input;
  const airacCycle = parseAiracCycle(metadata.airac_cycle);
  const navigraphUpdate = parseNavigraphUpdate(metadata.properties);
  const { validFrom, validThrough } = parseValidity(metadata.valid_through, airacCycle);
  const compiledAt = metadata.last_load_timestamp;
  const label = datasetLabel({ provider, airacCycle, navigraphUpdate, compiledAt });
  const snapshotId = `lnm-${provider.toLowerCase()}-${input.startedAt}-${randomBytes(4).toString('hex')}`;

  const write = out.transaction(() => {
    out.prepare(
      `INSERT INTO lnm_dataset (
         id, snapshot_id, data_source, airac_cycle, valid_from, valid_through, compiled_at, navigraph_update,
         atools_db_version, source_file_name, source_bytes, imported_at, label
       ) VALUES (1, @snapshot_id, @data_source, @airac_cycle, @valid_from, @valid_through, @compiled_at,
         @navigraph_update, @atools_db_version, @source_file_name, @source_bytes, @imported_at, @label)`,
    ).run({
      snapshot_id: snapshotId,
      data_source: provider,
      airac_cycle: airacCycle,
      valid_from: validFrom,
      valid_through: validThrough,
      compiled_at: compiledAt,
      navigraph_update: navigraphUpdate === null ? null : navigraphUpdate ? 1 : 0,
      atools_db_version: `${metadata.db_version_major}.${metadata.db_version_minor}`,
      source_file_name: input.sourceFileName,
      source_bytes: input.sourceBytes,
      imported_at: input.completedAt,
      label,
    });

    const airports = out.prepare('SELECT COUNT(*) FROM nav_airport').pluck().get() as number;
    writeNavMeta(out, {
      kind: 'header',
      v: 1,
      schemaVersion: NAVDATA_SCHEMA_VERSION,
      snapshotId,
      rev: 1,
      simId: SIM_ID[provider],
      simAppName: 'Little Navmap',
      simAppVersion: label,
      sidecarVersion: 'lnm-import',
      createdAt: input.completedAt,
      counts: {},
      bulkStartedAt: input.startedAt,
      bulkCompletedAt: input.completedAt,
      bulkRowCount: airports,
    } as Parameters<typeof writeNavMeta>[1], input.completedAt);
  });
  write();

  return {
    snapshotId,
    dataset: {
      source: 'lnm',
      label,
      provider,
      airacCycle,
      validFrom,
      validThrough,
      expired: isExpired(validThrough, input.completedAt),
      compiledAt,
      navigraphUpdate,
      importedAt: input.completedAt,
    },
  };
}
