// ── Little Navmap import pipeline ────────────────────────────────────────────
//
// The one place that sequences an import: open the atools file read-only, build
// the replica under its incoming name, convert every table in foreign-key
// order, finalise the counters, write the coverage grid and the header last,
// and prove the file complete before handing it back. runLnmPipeline is
// synchronous and runs in a worker thread (worker.ts), so the server's event
// loop never waits on it.
//
// Failure is clean by construction: any throw closes both handles and removes
// the incoming file with its journal siblings, so a failed or cancelled import
// leaves nothing behind. Only LnmImportError text ever leaves the worker; every
// other exception is reduced to a fixed message and a name/code log line,
// because its message may carry a row value or a path from inside the atools
// file (toLnmWorkerError).

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { LNM_DATASET_DDL } from '../dataset';
import { applyNavdataSchema } from '../schema';
import { NavdataStoreError, verifyNavdataColumns } from '../store';
import { airportsConverter } from './airports';
import { airwaysConverter } from './airways';
import { COVERAGE_CELLS_PER_KIND, writeCoverageGrid } from './coverage';
import { detectFlavour } from './flavour';
import { writeLnmMeta } from './meta';
import { navaidsConverter } from './navaids';
import { proceduresConverter } from './procedures';
import { buildSourceIndex } from './sourceIndex';
import {
  LnmImportError,
  type ConverterStats, type LnmContext, type LnmConverter, type LnmImportCounts, type LnmImportResult,
  type LnmStage, type LnmWorkerMessage, type LnmWorkerRequest,
} from './types';
import { waypointsConverter } from './waypoints';

/** Foreign-key order: an airport row comes before its runways, frequencies and procedures. */
const CONVERTERS: readonly LnmConverter[] = [
  airportsConverter, navaidsConverter, waypointsConverter, airwaysConverter, proceduresConverter,
];

/** At most one progress message per stage in this window, besides the first and the last. */
const PROGRESS_INTERVAL_MS = 250;

/** SQLite's page cache per connection, in KiB (64 MiB). Explicit so the native memory of the worker is bounded and known. */
const CACHE_SIZE_KIB = 65_536;

/**
 * Bytes the incoming file may grow by before the worker writes it out to disk.
 * The build runs with synchronous OFF, so its pages would otherwise pile up in
 * the OS cache, up to hundreds of MB, and every other write on the same
 * filesystem (the simulator's ingest, a session's hourly expiry save) would
 * wait for the filesystem journal to commit them before it could finish.
 */
export const INCOMING_FLUSH_BYTES = 32 * 1024 ** 2;

const LOG = '[Navdata] LNM import';

export type LnmProgressMessage = Extract<LnmWorkerMessage, { type: 'progress' }>;
export type LnmErrorMessage = Extract<LnmWorkerMessage, { type: 'error' }>;

export interface LnmPipelineOptions {
  /** Asked between transactions and at every stage boundary; true stops the build with LnmCancelledError. */
  isCancelled?: () => boolean;
  /** Receives each converter's counters as it finishes. */
  onStats?: (stage: LnmStage, stats: ConverterStats) => void;
  /** The converters in foreign-key order; a test substitutes one to force a failure. */
  converters?: readonly LnmConverter[];
  /** Epoch ms. Stage timing, the completion time and the progress rate limit all read it. */
  clock?: () => number;
  /** Bytes the incoming file may grow by between two write-outs. Defaults to INCOMING_FLUSH_BYTES; a test lowers it. */
  flushThresholdBytes?: number;
  /** Writes the incoming file's data out to disk through an open descriptor. Defaults to fs.fdatasyncSync; a test counts the calls. */
  syncIncoming?: (fd: number) => void;
}

/** Thrown at the first check after a cancel; the runners swallow it, it is never an import failure. */
export class LnmCancelledError extends Error {
  constructor() {
    super('import cancelled');
    this.name = 'LnmCancelledError';
  }
}

// ── Error text that may leave the worker ─────────────────────────────────────

/** `Name CODE` of an exception with everything but identifier characters removed: safe for a log line. */
function describeError(err: unknown): string {
  const clean = (v: unknown): string => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  const name = err instanceof Error ? clean(err.name) : typeof err;
  const code = typeof err === 'object' && err !== null ? clean((err as { code?: unknown }).code) : '';
  return code ? `${name} ${code}` : name;
}

/**
 * The error message a worker posts for a throw in `stage`. An LnmImportError
 * carries its own code and message (they name structure only). Anything else is
 * replaced by a fixed message: the exception's own text may embed a row value
 * or an absolute path, so only its name and code are logged.
 */
export function toLnmWorkerError(err: unknown, stage: LnmStage): LnmErrorMessage {
  if (err instanceof LnmImportError) {
    console.error(`${LOG}: ${err.code} in stage ${stage}`);
    return { type: 'error', code: err.code, message: err.message };
  }
  console.error(`${LOG}: ${describeError(err)} in stage ${stage}`);
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') {
    return { type: 'error', code: 'LNM_DISK_FULL', message: `disk full in stage ${stage}` };
  }
  return { type: 'error', code: 'LNM_BUILD_FAILED', message: `import failed in stage ${stage}` };
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Removes an incoming replica and the journal files SQLite may have left beside it. Never throws. */
export function removeIncomingFiles(incomingPath: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(incomingPath + suffix, { force: true });
    } catch (err) {
      console.warn(`${LOG}: could not remove ${path.basename(incomingPath + suffix)}: ${describeError(err)}`);
    }
  }
}

/** A SQLite failure while reading the source means the file is not a database this process can read. */
function asOpenFailure(err: unknown): unknown {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('SQLITE_')
    ? new LnmImportError('LNM_OPEN_FAILED', 'the file could not be read as a SQLite database')
    : err;
}

/**
 * Opens the atools file read-only. Sorts spill to RAM, never to the OS temp
 * directory, and the page cache is explicit. A file that is not a database
 * opens fine and fails on the first read, so the first read happens here.
 */
export function openSource(sourcePath: string): Database.Database {
  let src: Database.Database | null = null;
  try {
    src = new Database(sourcePath, { readonly: true, fileMustExist: true });
    src.pragma('temp_store = MEMORY');
    src.pragma(`cache_size = -${CACHE_SIZE_KIB}`);
    src.prepare('SELECT COUNT(*) FROM sqlite_master').pluck().get();
    return src;
  } catch (err) {
    src?.close();
    throw asOpenFailure(err);
  }
}

/**
 * Creates the incoming replica. DELETE rather than WAL: a build of several
 * hundred MB in WAL would grow a WAL of the same order between checkpoints, and
 * the file is discarded on any failure, so synchronous OFF costs nothing. The
 * finished file is switched to WAL before it is handed back (switchToWal).
 * temp_store keeps the finalising COUNT(DISTINCT) and foreign_key_check out of
 * the OS temp directory.
 */
export function openIncoming(incomingPath: string): Database.Database {
  removeIncomingFiles(incomingPath);
  const out = new Database(incomingPath);
  try {
    out.pragma('synchronous = OFF');
    out.pragma('foreign_keys = ON');
    out.pragma(`cache_size = -${CACHE_SIZE_KIB}`);
    out.pragma('temp_store = MEMORY');
    applyNavdataSchema(out);
    out.exec(LNM_DATASET_DDL);
    // The schema script switches the file to WAL; the build must not run in it.
    out.pragma('journal_mode = DELETE');
  } catch (err) {
    out.close();
    throw err;
  }
  return out;
}

function closeQuietly(db: Database.Database | null): void {
  try {
    db?.close();
  } catch {
    // The failure that got us here is the one worth reporting.
  }
}

/** Writes the incoming replica out to disk. Each call blocks only the thread it runs on, the worker. */
interface IncomingFlusher {
  /** Writes the file out if it has grown by the threshold since the last write-out. */
  flushIfDue(): void;
  /** Writes the file out now, whatever its growth. */
  flush(): void;
  close(): void;
}

/**
 * The commits happen inside the converters, which only report progress, so this
 * is asked at every progress call and at every stage end: the size of the file
 * is what it measures. A write-out while a transaction is open is harmless; it
 * only persists what SQLite has already handed to the OS.
 *
 * One descriptor is opened here and kept until close(), which the pipeline calls
 * after the connection is closed: closing any descriptor of a file drops the
 * process's locks on it, and the connection holds some. A failed write-out
 * propagates: the file on disk cannot be trusted after it.
 */
function openIncomingFlusher(incomingPath: string, thresholdBytes: number, sync: (fd: number) => void): IncomingFlusher {
  const fd = fs.openSync(incomingPath, 'r+');
  let flushedSize = fs.fstatSync(fd).size;
  const flush = (): void => {
    const size = fs.fstatSync(fd).size;
    sync(fd);
    flushedSize = size;
  };
  return {
    flushIfDue(): void {
      if (fs.fstatSync(fd).size - flushedSize >= thresholdBytes) flush();
    },
    flush,
    close(): void {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing is written through this descriptor, so there is nothing to lose.
      }
    },
  };
}

/**
 * Switches the finished replica to WAL, the mode every reader opens it in. The
 * switch rewrites the file header in a small transaction of its own. Made here,
 * on the worker's synchronous OFF connection, it syncs nothing; left to the
 * server's first open after the swap, it would run on the main thread with
 * four syncs, each waiting for whatever else the disk is writing.
 */
function switchToWal(out: Database.Database): void {
  if (out.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
    throw new LnmImportError('LNM_VERIFY_FAILED', 'verification failed: the replica could not be switched to WAL');
  }
}

// ── Finalising and verification ──────────────────────────────────────────────

/**
 * The counters the converters leave at 0 because they need every table in:
 * per-airport runway and procedure totals, and the number of distinct airways
 * through each waypoint.
 */
function finaliseCounters(out: Database.Database, progress: (done: number, total: number) => void): void {
  const run = out.transaction(() => {
    out.exec(`
      UPDATE nav_airport SET
        n_runways         = (SELECT COUNT(*) FROM nav_runway r WHERE r.airport_ident = nav_airport.ident),
        detail_runways    = (SELECT COUNT(*) FROM nav_runway r WHERE r.airport_ident = nav_airport.ident),
        n_approaches      = (SELECT COUNT(*) FROM nav_procedure p WHERE p.airport_ident = nav_airport.ident AND p.kind = 'APPROACH'),
        n_departures      = (SELECT COUNT(*) FROM nav_procedure p WHERE p.airport_ident = nav_airport.ident AND p.kind = 'SID'),
        n_arrivals        = (SELECT COUNT(*) FROM nav_procedure p WHERE p.airport_ident = nav_airport.ident AND p.kind = 'STAR'),
        detail_procedures = (SELECT COUNT(*) FROM nav_procedure p WHERE p.airport_ident = nav_airport.ident)`);
    progress(1, 2);
    out.exec(`
      UPDATE nav_waypoint SET n_routes = (
        SELECT COUNT(DISTINCT airway) FROM (
          SELECT airway FROM nav_airway_leg WHERE from_key = nav_waypoint.wpt_key
          UNION ALL
          SELECT airway FROM nav_airway_leg WHERE to_key = nav_waypoint.wpt_key))`);
    progress(2, 2);
  });
  run();
}

const COUNTED_TABLES: Record<keyof LnmImportCounts, string> = {
  airports: 'nav_airport', runways: 'nav_runway', frequencies: 'nav_airport_frequency', navaids: 'nav_navaid',
  waypoints: 'nav_waypoint', airwayLegs: 'nav_airway_leg', procedures: 'nav_procedure',
  transitions: 'nav_procedure_transition', legs: 'nav_procedure_leg', coverageCells: 'nav_coverage_cell',
};

function countRows(out: Database.Database): LnmImportCounts {
  const counts = {} as LnmImportCounts;
  for (const [key, table] of Object.entries(COUNTED_TABLES) as [keyof LnmImportCounts, string][]) {
    counts[key] = out.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  }
  return counts;
}

/** Checks the finished file the way a reader will meet it. Every failure is LNM_VERIFY_FAILED. */
export function verifyReplica(out: Database.Database, snapshotId: string): void {
  const fail = (what: string): LnmImportError => new LnmImportError('LNM_VERIFY_FAILED', `verification failed: ${what}`);

  const violation = out.prepare('PRAGMA foreign_key_check').get() as { table: string; parent: string } | undefined;
  if (violation) throw fail(`a row of ${violation.table} refers to a missing ${violation.parent} row`);

  try {
    verifyNavdataColumns(out);
  } catch (err) {
    if (err instanceof NavdataStoreError) throw fail('the replica tables differ from the schema');
    throw err;
  }

  const count = (sql: string): number => out.prepare(sql).pluck().get() as number;
  if (count('SELECT COUNT(*) FROM nav_airport') === 0) throw fail('no airports were imported');
  const cells = count('SELECT COUNT(*) FROM nav_coverage_cell');
  if (cells !== COVERAGE_CELLS_PER_KIND * 3) throw fail(`the coverage grid has ${cells} cells`);
  const headerId = out.prepare('SELECT snapshot_id FROM nav_meta WHERE id = 1').pluck().get();
  const datasetId = out.prepare('SELECT snapshot_id FROM lnm_dataset WHERE id = 1').pluck().get();
  if (headerId !== snapshotId || datasetId !== snapshotId) throw fail('the header and the dataset row disagree');
}

// ── The pipeline ─────────────────────────────────────────────────────────────

const written = (stats: ConverterStats): string =>
  Object.entries(stats.written).map(([name, n]) => `${n} ${name}`).join(', ');

/**
 * Builds the replica at `req.incomingPath` from the atools file at
 * `req.sourcePath`. Throws LnmImportError for a refusal that may be shown as it
 * is, LnmCancelledError after a cancel, and anything else for an unexpected
 * failure (see toLnmWorkerError). Whatever it throws, no incoming file is left.
 * Progress is reported per stage: one message when the stage starts, at most
 * one per 250 ms while it runs, and one with done equal to total when it ends.
 */
export function runLnmPipeline(
  req: LnmWorkerRequest,
  onProgress: (message: LnmProgressMessage) => void,
  options: LnmPipelineOptions = {},
): LnmImportResult {
  const clock = options.clock ?? Date.now;
  const converters = options.converters ?? CONVERTERS;
  const flushThresholdBytes = options.flushThresholdBytes ?? INCOMING_FLUSH_BYTES;
  const syncIncoming = options.syncIncoming ?? fs.fdatasyncSync;
  const startedAt = clock();
  // Only ever the name: a path would put a directory of the uploader's machine into the replica and the logs.
  const sourceFileName = path.basename(req.sourceFileName);
  let warnings = 0;

  let stage: LnmStage = 'validating';
  let lastEmitAt = 0;
  let lastTotal = 1;
  let endSent = false;
  let flusher: IncomingFlusher | null = null;

  const checkCancelled = (): void => {
    if (options.isCancelled?.()) throw new LnmCancelledError();
  };
  const emit = (done: number, total: number): void => {
    lastEmitAt = clock();
    if (done >= total) endSent = true;
    onProgress({ type: 'progress', stage, done, total });
  };
  const begin = (next: LnmStage): void => {
    checkCancelled();
    stage = next;
    lastTotal = 1;
    endSent = false;
    emit(0, 1);
  };
  const progress = (done: number, total: number): void => {
    checkCancelled();
    flusher?.flushIfDue();
    // A stage with nothing to do is complete, not 0 of 0.
    const t = Math.max(total, 1);
    const d = total <= 0 ? 1 : Math.min(Math.max(done, 0), t);
    lastTotal = t;
    if ((d >= t && !endSent) || (d < t && clock() - lastEmitAt >= PROGRESS_INTERVAL_MS)) emit(d, t);
  };
  const end = (): void => {
    flusher?.flushIfDue();
    if (!endSent) emit(lastTotal, lastTotal);
  };
  const warn = (message: string): void => {
    warnings++;
    console.warn(`${LOG}: ${message}`);
  };

  let src: Database.Database | null = null;
  let out: Database.Database | null = null;
  let finished = false;
  try {
    begin('validating');
    src = openSource(req.sourcePath);
    let detected: ReturnType<typeof detectFlavour>;
    try {
      detected = detectFlavour(src);
    } catch (err) {
      throw asOpenFailure(err);
    }
    const { flavour, provider, metadata } = detected;
    console.log(`${LOG}: ${sourceFileName} is ${provider} data`);
    out = openIncoming(req.incomingPath);
    flusher = openIncomingFlusher(req.incomingPath, flushThresholdBytes, syncIncoming);
    end();

    begin('indexing');
    const index = buildSourceIndex(src, flavour);
    end();

    const ctx: LnmContext = { src, out, flavour, provider, index, now: req.now, progress, warn };
    for (const converter of converters) {
      begin(converter.stage);
      const stats = converter.run(ctx);
      options.onStats?.(converter.stage, stats);
      console.log(`${LOG}: ${converter.stage}: wrote ${written(stats) || 'nothing'}`);
      end();
    }

    begin('finalising');
    finaliseCounters(out, progress);
    // The counters are rewritten in place: the file does not grow while they dirty its pages.
    flusher.flush();
    end();

    begin('coverage');
    writeCoverageGrid(out, req.now, progress);
    // The header goes in last: a file that carries one is a file whose rows are all in.
    const completedAt = Math.max(clock(), req.now);
    const { snapshotId, dataset } = writeLnmMeta(out, {
      provider, metadata, sourceFileName, sourceBytes: req.sourceBytes,
      startedAt: req.now, completedAt,
    });
    // The last rows are in: what is still unwritten goes out now, before verification reads the file back.
    flusher.flush();
    end();

    begin('verifying');
    verifyReplica(out, snapshotId);
    const counts = countRows(out);
    switchToWal(out);
    // Closed before the last write-out: closing a WAL connection removes its -wal and -shm files, and whatever
    // the close still writes is then on disk before the build reports done.
    out.close();
    out = null;
    flusher.flush();
    end();

    const durationMs = clock() - startedAt;
    console.log(`${LOG}: finished in ${(durationMs / 1000).toFixed(1)} s with ${warnings} warnings`);
    finished = true;
    return { snapshotId, dataset, counts, warnings, durationMs };
  } finally {
    closeQuietly(out);
    flusher?.close();
    closeQuietly(src);
    if (!finished) removeIncomingFiles(req.incomingPath);
  }
}

/**
 * Runs the pipeline and reports its outcome as worker messages: progress, then
 * exactly one of done or error, or nothing at all after a cancel. The one path
 * both the worker thread and the in-process runner go through, so the error
 * mapping is the same in both.
 */
export function runLnmPipelineToMessages(
  req: LnmWorkerRequest,
  post: (message: LnmWorkerMessage) => void,
  options: LnmPipelineOptions = {},
): void {
  let stage: LnmStage = 'validating';
  let result: LnmImportResult;
  try {
    result = runLnmPipeline(req, message => {
      stage = message.stage;
      post(message);
    }, options);
  } catch (err) {
    if (err instanceof LnmCancelledError) return;
    post(toLnmWorkerError(err, stage));
    return;
  }
  post({ type: 'done', result });
}
