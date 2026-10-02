import express, { type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { MulterError } from 'multer';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { extendBodyDeadline } from '../bodyDeadline';
import {
  getLnmNavDb, incomingNavdataPath, lnmUploadSpoolPath, navdataImportDir, resolveLnmNavdataPath, swapInLnmReplica,
} from '../navdata/connection';
import { readNavdataDataset } from '../navdata/dataset';
import { workerRunner } from '../navdata/lnm';
import { removeIncomingFiles } from '../navdata/lnm/pipeline';
import {
  LNM_STAGE_WEIGHTS, LnmImportError,
  type LnmImportErrorCode, type LnmImportFilesResponse, type LnmImportJob, type LnmImportResult, type LnmImportRunner,
  type LnmStage, type LnmWorkerMessage,
} from '../navdata/lnm/types';
import { NavdataStoreError, verifyNavdataColumns } from '../navdata/store';
import { NAVDATA_SCHEMA_VERSION } from '../navdata/wire';
import {
  createUploadLnmDatabase, LNM_BUILD_RESERVE_BYTES, LNM_DISK_MARGIN_BYTES, LNM_MEMORY_RESERVE_BYTES,
  LNM_UPLOAD_MAX_BYTES, LNM_UPLOAD_MULTIPART_SLACK_BYTES, NAVDATA_UPLOAD_REQUEST_TIMEOUT_MS, setLnmSpoolPath,
} from './uploads';

const LOG = '[Navdata] LNM import';
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** How often the replica being built is written out to disk while the build runs. */
const BUILD_SYNC_INTERVAL_MS = 500;

const UPLOAD_FIELD = 'lnmDatabase';
const BAD_UPLOAD_MESSAGE = `Send exactly one file in the field ${UPLOAD_FIELD} and nothing else`;
const ABORTED_MESSAGE = 'Upload stopped: the page was closed or the connection dropped';
const WORKER_STOPPED_MESSAGE = 'import worker stopped unexpectedly';
const SWAP_FAILED_MESSAGE = 'could not replace the Little Navmap data';
const SPOOL_FULL_MESSAGE = 'Not enough disk space to receive the upload';
const SPOOL_FAILED_MESSAGE = 'The server could not store the upload';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

export interface NavdataImportOptions {
  /** How an import runs; tests substitute an in-process or fake runner. Default: a worker thread. */
  runner?: LnmImportRunner;
  now?: () => number;
  /** Free space of the filesystem holding `dir`; tests use it to force a refusal. */
  statfs?: (dir: string) => { availableBytes: number };
  /** Free memory of the process; tests use it to force a refusal. */
  availableMemory?: () => number;
  /** Defaults to LNM_UPLOAD_MAX_BYTES; tests lower it to reach the multer size limit with a small file. */
  maxUploadBytes?: number;
  /** Opens the incoming file for write-out; tests substitute a fake. Default: a read-write file handle that never creates the file. */
  openForSync?: (file: string) => Promise<SyncHandle>;
  /** Milliseconds between write-outs while the build runs; tests shorten it. */
  syncIntervalMs?: number;
}

/** What the write-out of the replica being built needs from an open file. */
export interface SyncHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Writes one file out to disk now and then, from the thread pool, for as long as a build runs. */
interface BuildSync {
  /** Starts the timer. Does nothing once the sync has been stopped. */
  start(): void;
  /** Stops the timer, waits for a write-out in progress, writes the file out once more and closes it. */
  flushAndClose(): Promise<void>;
  /** Stops the timer and closes the file once a write-out in progress is over, without writing anything more. */
  abandon(): void;
}

/** The job as the API serves it, plus what only the server needs. */
interface ActiveJob {
  job: LnmImportJob;
  cancelRequested: boolean;
  spoolPath: string | null;
  incomingPath: string | null;
  uploadReq: Request | null;
  handle: { done: Promise<void>; cancel(): void } | null;
  /** The build has finished and its file is being moved into place; the runner exiting is not a failure then. */
  finishing: boolean;
  buildSync: BuildSync | null;
}

interface Refusal {
  status: number;
  body: { error: string; code: LnmImportErrorCode; requiredBytes?: number; availableBytes?: number };
}

const STAGE_ORDER = Object.keys(LNM_STAGE_WEIGHTS) as LnmStage[];

/** 0..1 across the weighted stages: every finished stage plus the share of the current one. */
function stageFraction(stage: LnmStage, done: number, total: number): number {
  let finished = 0;
  for (const s of STAGE_ORDER) {
    if (s === stage) break;
    finished += LNM_STAGE_WEIGHTS[s];
  }
  const share = Math.min(Math.max(done / Math.max(total, 1), 0), 1);
  const fraction = (finished + LNM_STAGE_WEIGHTS[stage] * share) / 100;
  return Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
}

function describeBytes(bytes: number): string {
  if (bytes >= GIB) return `${+(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= MIB) return `${+(bytes / MIB).toFixed(1)} MiB`;
  return `${bytes} bytes`;
}

/** A server-side import reads only a plain .sqlite file name from the import directory itself. */
function isImportableName(name: unknown): name is string {
  return typeof name === 'string' &&
    name.length >= 1 && name.length <= 255 &&
    name === path.basename(name) &&
    !/[/\\\0]/.test(name) &&
    !name.startsWith('.') &&
    /\.sqlite$/i.test(name);
}

/** The name an upload is shown under: no directories, no control characters, at most 255 characters. */
function displayName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'upload.sqlite';
}

function hasSqliteHeader(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The errno name (ENOSPC, EACCES, ...) of a filesystem error, or null for any
 * other error: a malformed multipart body arrives as a plain Error with no code,
 * multer's own limits as a MulterError, and Node's non-filesystem codes contain
 * an underscore.
 */
function filesystemErrorCode(err: unknown): string | null {
  if (!(err instanceof Error) || err instanceof MulterError) return null;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

/** The Content-Length header as a byte count, or null when it is missing or not a plain non-negative integer. */
function contentLength(req: Request): number | null {
  const header = req.headers['content-length'];
  if (typeof header !== 'string' || !/^\d+$/.test(header)) return null;
  const n = Number(header);
  return Number.isSafeInteger(n) ? n : null;
}

/** What the incoming file must be before it replaces the live replica; any failure here is a verification failure. */
function verifyIncoming(check: Database.Database, snapshotId: string): void {
  const fail = (what: string): LnmImportError => new LnmImportError('LNM_VERIFY_FAILED', `verification failed: ${what}`);
  try {
    verifyNavdataColumns(check);
    const meta = check.prepare('SELECT schema_version, snapshot_id FROM nav_meta WHERE id = 1').get() as
      { schema_version: number; snapshot_id: string } | undefined;
    if (!meta || meta.schema_version !== NAVDATA_SCHEMA_VERSION) throw fail('the replica has an unexpected schema version');
    const dataset = check.prepare('SELECT snapshot_id FROM lnm_dataset WHERE id = 1').get() as { snapshot_id: string } | undefined;
    if (meta.snapshot_id !== snapshotId || dataset?.snapshot_id !== snapshotId) throw fail('the header and the dataset row disagree');
  } catch (err) {
    if (err instanceof LnmImportError) throw err;
    if (err instanceof NavdataStoreError) throw fail('the replica tables differ from the schema');
    throw fail('the replica could not be read');
  }
}

/**
 * Writes `file` out to disk every `intervalMs` while it is being built, on the
 * thread pool so the event loop never waits for it.
 *
 * The build runs with synchronous OFF, so its pages stay in memory, up to
 * hundreds of MB, until the kernel flushes them in one burst. Every write the
 * main thread makes meanwhile (the simulator's ingest, a session's hourly
 * expiry save) waits for that burst to be committed, and the event loop stalls
 * for seconds with it. Writing the file out at short intervals keeps each
 * burst small.
 *
 * One file handle stays open from the first write-out to the end: closing any
 * descriptor of a file drops the process's locks on it, and the worker's SQLite
 * connection holds some. The handle is closed only after the worker has
 * finished (flushAndClose) or when the job ends another way (abandon).
 * A failure to open or write is ignored: it is not an import failure, and the
 * worker writes the whole file out itself before it reports done.
 */
function createBuildSync(file: string, open: (file: string) => Promise<SyncHandle>, intervalMs: number): BuildSync {
  let handle: SyncHandle | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();
  let started = false;
  let stopped = false;
  let abandoned = false;

  const closeHandle = (): Promise<void> => {
    const held = handle;
    handle = null;
    return held ? held.close().catch(() => undefined) : Promise.resolve();
  };

  const writeOut = async (): Promise<void> => {
    try {
      if (!handle) {
        const opened = await open(file);
        if (abandoned) {
          await opened.close().catch(() => undefined);
          return;
        }
        handle = opened;
      }
      await handle.sync();
    } catch {
      // The file does not exist yet or any more.
    }
  };

  const arm = (): void => {
    timer = setTimeout(tick, intervalMs);
    timer.unref();
  };

  const tick = (): void => {
    timer = null;
    if (stopped) return;
    inflight = writeOut().then(() => {
      if (!stopped) arm();
    });
  };

  const stopTimer = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      arm();
    },
    async flushAndClose(): Promise<void> {
      stopTimer();
      await inflight;
      await writeOut();
      abandoned = true;
      await closeHandle();
    },
    abandon(): void {
      stopTimer();
      abandoned = true;
      void inflight.then(closeHandle);
    },
  };
}

let shutdownActiveImport: () => void = () => {};

/**
 * Called first in the signal handler, before the server stops accepting: ends
 * an upload in flight, stops the build and removes its files, so neither the
 * server's close nor its exit timer waits on them. Never throws.
 */
export function cancelLnmImportForShutdown(): void {
  shutdownActiveImport();
}

/**
 * The Little Navmap import: upload or server-side path in, a build in a worker
 * thread, a swap into the Little Navmap replica when it is done. One job at a
 * time per router. It never shares the sidecar sync's import flag: a build
 * does not touch the simulator replica, so sidecar traffic is never refused
 * because of it.
 */
export function createNavdataImportRouter(opts: NavdataImportOptions = {}): express.Router {
  const router = express.Router();
  const runner = opts.runner ?? workerRunner;
  const now = opts.now ?? Date.now;
  const maxUploadBytes = opts.maxUploadBytes ?? LNM_UPLOAD_MAX_BYTES;
  const statfs = opts.statfs ?? ((dir: string) => {
    const s = fs.statfsSync(dir);
    return { availableBytes: s.bavail * s.bsize };
  });
  const availableMemory = opts.availableMemory ?? (() => process.availableMemory());
  const reserveBytes = LNM_BUILD_RESERVE_BYTES + LNM_DISK_MARGIN_BYTES;
  const uploadLnmDatabase = createUploadLnmDatabase(maxUploadBytes);
  const openForSync = opts.openForSync ?? ((file: string): Promise<SyncHandle> => fs.promises.open(file, 'r+'));
  const syncIntervalMs = opts.syncIntervalMs ?? BUILD_SYNC_INTERVAL_MS;

  let current: ActiveJob | null = null;
  let spoolSequence = 0;

  const isBusy = (): boolean => current !== null && (current.job.state === 'receiving' || current.job.state === 'running');

  // ── Ending a job ─────────────────────────────────────────────────────────

  const removeSpool = (a: ActiveJob): void => {
    if (!a.spoolPath) return;
    try {
      fs.rmSync(a.spoolPath, { force: true });
    } catch {
      // The startup sweep removes what is left.
    }
  };

  /** Moves a job to its one terminal state; a job that already has one is left as it is. */
  const finish = (
    a: ActiveJob, state: 'succeeded' | 'failed' | 'cancelled',
    detail: { error?: { code: LnmImportErrorCode; message: string }; result?: LnmImportJob['result'] } = {},
  ): boolean => {
    if (a.job.state !== 'receiving' && a.job.state !== 'running') return false;
    a.buildSync?.abandon();
    a.buildSync = null;
    removeSpool(a);
    if (state !== 'succeeded' && a.incomingPath) removeIncomingFiles(a.incomingPath);
    a.job.state = state;
    a.job.finishedAt = now();
    a.job.error = detail.error ?? null;
    a.job.result = detail.result ?? null;
    if (state === 'succeeded') a.job.fraction = 1;
    a.uploadReq = null;
    a.handle = null;
    if (state !== 'succeeded') console.log(`${LOG}: ${state}${detail.error ? ` (${detail.error.code})` : ''}`);
    return true;
  };

  const cancelled = (a: ActiveJob): boolean => finish(a, 'cancelled');

  /** A failure; a job the user asked to cancel is reported as cancelled, whatever stopped it. */
  const failed = (a: ActiveJob, code: LnmImportErrorCode, message: string): boolean =>
    a.cancelRequested ? cancelled(a) : finish(a, 'failed', { error: { code, message } });

  const uploadAborted = (a: ActiveJob): boolean => failed(a, 'LNM_UPLOAD_ABORTED', ABORTED_MESSAGE);

  // ── Running and swapping ─────────────────────────────────────────────────

  const newBuildSync = (a: ActiveJob): BuildSync => {
    a.buildSync ??= createBuildSync(a.incomingPath as string, openForSync, syncIntervalMs);
    return a.buildSync;
  };

  const swapIn = async (a: ActiveJob, result: LnmImportResult): Promise<void> => {
    a.finishing = true;
    a.job.stage = 'swapping';
    a.job.fraction = Math.max(a.job.fraction, stageFraction('swapping', 0, 1));
    // The worker has switched the file to WAL and written it out before reporting done, so the swap's opens on the
    // main thread find nothing to write. This last write-out, on the thread pool, stops the timer and closes the handle.
    await newBuildSync(a).flushAndClose();
    // A cancel or a shutdown can arrive while the file is being written out.
    if (a.job.state !== 'running') return;
    if (a.cancelRequested) {
      cancelled(a);
      return;
    }
    try {
      swapInLnmReplica(a.incomingPath as string, check => verifyIncoming(check, result.snapshotId));
      const dataset = readNavdataDataset(getLnmNavDb(), 'lnm', now());
      if (!dataset) throw new LnmImportError('LNM_SWAP_FAILED', 'the imported data could not be opened');
      const { counts } = result;
      console.log(
        `${LOG}: swapped in ${counts.airports} airports, ${counts.navaids} navaids, ${counts.waypoints} waypoints, ` +
        `${counts.airwayLegs} airway legs, ${counts.procedures} procedures, ${counts.legs} legs`,
      );
      finish(a, 'succeeded', { result: { dataset, counts, warnings: result.warnings } });
    } catch (err) {
      // An fs error's text embeds absolute paths, so only a verification or our own message is shown.
      if (err instanceof LnmImportError) failed(a, err.code, err.message);
      else failed(a, 'LNM_SWAP_FAILED', SWAP_FAILED_MESSAGE);
    }
  };

  const onMessage = (a: ActiveJob, message: LnmWorkerMessage): void => {
    // After the build's result nothing more is expected from the worker.
    if (a.job.state !== 'running' || a.finishing) return;
    if (message.type === 'progress') {
      a.job.stage = message.stage;
      a.job.fraction = Math.max(a.job.fraction, stageFraction(message.stage, message.done, message.total));
      // The incoming file is created while the build validates; from the next stage on it grows.
      if (message.stage !== 'validating') newBuildSync(a).start();
    } else if (message.type === 'error') {
      failed(a, message.code, message.message);
    } else if (a.cancelRequested) {
      // The cancel arrived after the build finished: the file is complete, but the user asked for no change.
      cancelled(a);
    } else {
      swapIn(a, message.result).catch(() => failed(a, 'LNM_SWAP_FAILED', SWAP_FAILED_MESSAGE));
    }
  };

  /** The runner's promise settles once the worker has exited: a cancel is final then, and so is a silent stop. */
  const onSettled = (a: ActiveJob): void => {
    if (a.job.state !== 'running' || a.finishing) return;
    if (a.cancelRequested) cancelled(a);
    else failed(a, 'LNM_WORKER_FAILED', WORKER_STOPPED_MESSAGE);
  };

  const startRun = (a: ActiveJob, sourcePath: string): void => {
    a.job.state = 'running';
    a.incomingPath = incomingNavdataPath(resolveLnmNavdataPath());
    try {
      const handle = runner.start({
        sourcePath, sourceFileName: a.job.sourceFileName, sourceBytes: a.job.sourceBytes,
        incomingPath: a.incomingPath, now: now(),
      }, message => onMessage(a, message));
      if (a.job.state === 'running') a.handle = handle;
      handle.done.then(() => onSettled(a), () => onSettled(a));
    } catch {
      failed(a, 'LNM_WORKER_FAILED', WORKER_STOPPED_MESSAGE);
    }
  };

  shutdownActiveImport = (): void => {
    const a = current;
    if (!a || (a.job.state !== 'receiving' && a.job.state !== 'running')) return;
    try {
      a.uploadReq?.destroy();
      a.handle?.cancel();
    } catch {
      // The process is exiting; a failure here changes nothing.
    }
    finish(a, 'failed', { error: { code: 'LNM_INTERRUPTED', message: 'The import was interrupted by a server shutdown' } });
  };

  // ── Prechecks ────────────────────────────────────────────────────────────

  /** Space for the spooled file, the build and a margin; memory for the build. Null when both are there. */
  const checkResources = (spoolBytes: number): Refusal | null => {
    let available: number | null = null;
    try {
      available = statfs(navdataImportDir()).availableBytes;
    } catch {
      // Space that cannot be measured is not refused: a build that runs out of it fails cleanly as LNM_DISK_FULL.
    }
    const required = spoolBytes + reserveBytes;
    if (available !== null && available < required) {
      return {
        status: 507,
        body: {
          error: `Not enough disk space: need ${Math.ceil(required / MIB)} MiB free in the navdata directory, ${Math.floor(available / MIB)} MiB available`,
          code: 'LNM_INSUFFICIENT_STORAGE', requiredBytes: required, availableBytes: available,
        },
      };
    }
    const memory = availableMemory();
    if (memory < LNM_MEMORY_RESERVE_BYTES) {
      return {
        status: 507,
        body: {
          error: `Not enough free memory to import: need ${Math.ceil(LNM_MEMORY_RESERVE_BYTES / MIB)} MiB, ${Math.floor(memory / MIB)} MiB available`,
          code: 'LNM_INSUFFICIENT_MEMORY', requiredBytes: LNM_MEMORY_RESERVE_BYTES, availableBytes: memory,
        },
      };
    }
    return null;
  };

  const refuse = (res: Response, status: number, code: LnmImportErrorCode, error: string): void => {
    res.status(status).json({ error, code });
  };

  /**
   * Nothing else creates the import directory on a native install, so the first
   * use does. A directory that cannot be created is not reported here: the
   * listing, the file lookup or the spool write that needs it reports its own error.
   */
  const ensureImportDir = (): void => {
    try {
      fs.mkdirSync(navdataImportDir(), { recursive: true });
    } catch {
      // Reported by the operation that needed the directory.
    }
  };

  const newJob = (origin: 'upload' | 'path', sourceFileName: string, sourceBytes: number): ActiveJob => ({
    job: {
      id: randomBytes(6).toString('hex'), origin, sourceFileName, sourceBytes,
      state: origin === 'upload' ? 'receiving' : 'running', stage: null, fraction: 0,
      startedAt: now(), finishedAt: null, error: null, result: null,
    },
    cancelRequested: false, spoolPath: null, incomingPath: null, uploadReq: null, handle: null, finishing: false,
    buildSync: null,
  });

  // ── GET the job, the files and the limits ────────────────────────────────

  router.get('/navdata/lnm-import', (_req, res) => {
    res.json({ job: current?.job ?? null });
  });

  router.get('/navdata/lnm-import/files', (_req, res) => {
    ensureImportDir();
    const dir = navdataImportDir();
    const files: LnmImportFilesResponse['files'] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      // An unreadable directory is reported as having no files.
    }
    for (const name of names) {
      if (!isImportableName(name)) continue;
      try {
        const st = fs.lstatSync(path.join(dir, name));
        if (st.isFile()) files.push({ name, sizeBytes: st.size, modifiedAt: Math.round(st.mtimeMs) });
      } catch {
        // Removed between the listing and the stat.
      }
    }
    let availableBytes: number | null = null;
    try {
      availableBytes = statfs(dir).availableBytes;
    } catch {
      // Reported as unknown.
    }
    const body: LnmImportFilesResponse = { dir, files, maxUploadBytes, availableBytes, reserveBytes };
    res.json(body);
  });

  // ── Server-side path ─────────────────────────────────────────────────────

  router.post('/navdata/lnm-import/path', (req, res) => {
    const fileName: unknown = (req.body as { fileName?: unknown } | null | undefined)?.fileName;
    if (!isImportableName(fileName)) {
      refuse(res, 400, 'LNM_BAD_REQUEST', 'fileName must be the name of a .sqlite file in the import directory');
      return;
    }
    if (isBusy()) {
      refuse(res, 409, 'LNM_IMPORT_BUSY', 'Another Little Navmap import is already running');
      return;
    }
    ensureImportDir();
    const full = path.join(navdataImportDir(), fileName);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        refuse(res, 404, 'LNM_FILE_NOT_FOUND', 'No such file in the import directory');
      } else {
        refuse(res, 400, 'LNM_BAD_REQUEST', 'The file cannot be read');
      }
      return;
    }
    if (!st.isFile()) {
      refuse(res, 400, 'LNM_BAD_REQUEST', 'The name must be a regular file in the import directory');
      return;
    }
    if (!hasSqliteHeader(full)) {
      refuse(res, 400, 'LNM_NOT_SQLITE', 'The file is not a SQLite database');
      return;
    }
    const refusal = checkResources(0);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    const a = newJob('path', fileName, st.size);
    current = a;
    startRun(a, full);
    res.status(202).json({ job: a.job });
  });

  // ── Upload ───────────────────────────────────────────────────────────────

  const uploadDone = (a: ActiveJob, req: Request, res: Response, err: unknown): void => {
    // A client that disconnected mid-body can reach this callback as multer's
    // truncated-stream error, as a normal completion of a partial file, or
    // after the close hook already ended the job; all of those are one abort,
    // never a bad request. A request stream that finished is also `destroyed`
    // by the time this runs, so the abort is a destroyed stream that never got
    // its whole body. A body that is not multipart is not read at all before
    // this callback, so an unread stream is not an abort. A cancel destroys the
    // request before its close events have been seen, so it is checked as well.
    if ((req.destroyed && !req.complete) || res.destroyed || res.writableEnded || a.cancelRequested || a.job.state !== 'receiving') {
      uploadAborted(a);
      removeSpool(a);
      return;
    }
    const reject = (status: number, code: LnmImportErrorCode, message: string): void => {
      failed(a, code, message);
      res.status(status).json({ error: message, code });
    };
    if (err) {
      const fsCode = filesystemErrorCode(err);
      if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
        reject(413, 'LNM_TOO_LARGE', `File exceeds ${describeBytes(maxUploadBytes)}`);
      } else if (fsCode) {
        // The error's own text embeds the spool path, so only its code is logged and the answer is fixed text.
        console.error(`${LOG}: the upload could not be written to disk: ${fsCode}`);
        if (fsCode === 'ENOSPC' || fsCode === 'EDQUOT') reject(507, 'LNM_INSUFFICIENT_STORAGE', SPOOL_FULL_MESSAGE);
        else reject(500, 'LNM_SPOOL_FAILED', SPOOL_FAILED_MESSAGE);
      } else {
        reject(400, 'LNM_BAD_REQUEST', BAD_UPLOAD_MESSAGE);
      }
      return;
    }
    const file = req.file;
    if (!file) {
      reject(400, 'LNM_BAD_REQUEST', BAD_UPLOAD_MESSAGE);
      return;
    }
    if (!hasSqliteHeader(file.path)) {
      reject(400, 'LNM_NOT_SQLITE', 'The file is not a SQLite database');
      return;
    }
    a.job.sourceFileName = displayName(file.originalname);
    a.job.sourceBytes = file.size;
    startRun(a, file.path);
    res.status(202).json({ job: a.job });
  };

  router.post('/navdata/lnm-import/upload', (req, res) => {
    if (isBusy()) {
      refuse(res, 409, 'LNM_IMPORT_BUSY', 'Another Little Navmap import is already running');
      return;
    }
    const length = contentLength(req);
    if (length === null) {
      refuse(res, 411, 'LNM_LENGTH_REQUIRED', 'The upload must state its Content-Length');
      return;
    }
    if (length > maxUploadBytes + LNM_UPLOAD_MULTIPART_SLACK_BYTES) {
      refuse(res, 413, 'LNM_TOO_LARGE', `File exceeds ${describeBytes(maxUploadBytes)}`);
      return;
    }
    ensureImportDir();
    const refusal = checkResources(length);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }

    const a = newJob('upload', '', length);
    // Two uploads claimed in the same millisecond must not share a spool file.
    a.spoolPath = `${lnmUploadSpoolPath()}-${++spoolSequence}`;
    a.uploadReq = req;
    current = a;
    setLnmSpoolPath(req, a.spoolPath);
    // Only this request, only now that it is authenticated and accepted, may take up to an hour.
    extendBodyDeadline(req, NAVDATA_UPLOAD_REQUEST_TIMEOUT_MS);
    res.once('close', () => {
      if (a.job.state === 'receiving') uploadAborted(a);
    });
    // Called here, not as route middleware, so that every multer error is answered
    // below with this route's own codes and recorded on the job.
    uploadLnmDatabase.single(UPLOAD_FIELD)(req, res, err => uploadDone(a, req, res, err));
  });

  // ── Cancel ───────────────────────────────────────────────────────────────

  router.delete('/navdata/lnm-import', (_req, res) => {
    const a = current;
    if (!a || !isBusy()) {
      refuse(res, 409, 'LNM_NOT_RUNNING', 'No Little Navmap import is running');
      return;
    }
    a.cancelRequested = true;
    if (a.job.state === 'receiving') a.uploadReq?.destroy();
    else a.handle?.cancel();
    res.status(202).json({ job: a.job });
  });

  return router;
}
