// ── Navdata replica handles ───────────────────────────────────────────────────
//
// Owns the process-wide handles on the two replica files: the simulator replica
// (navdata.db, built by the MCDU sidecar) and the Little Navmap replica
// (navdata.db.lnm, built by an import). Either file may be absent until it is
// first delivered; every caller must cope with a null handle.
//
// getNavDb() is the simulator replica, always: every sidecar code path calls it
// and must never be retargeted by the Settings choice. Browser routes read
// getActiveNavDb(), the handle of the selected source. Each swap is synchronous
// end to end, so a handler that queries without awaiting between getting a
// handle and its last query can never see a half-swapped file.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { NavdataSource } from './dataset';
import { NAVDATA_SCHEMA_VERSION } from './wire';

export type { NavdataSource } from './dataset';

const DEFAULT_NAVDATA_FILENAME = 'navdata.db';
const LNM_SUFFIX = '.lnm';
const INCOMING_INFIX = '.incoming-';
const UPLOAD_INFIX = '.upload-';

/** Thrown by getNavDb() and getActiveNavDb() while a swap is in progress. */
export class NavdataBusyError extends Error {
  readonly retryAfterSeconds = 2;
  constructor() {
    super('navdata replica is being replaced');
    this.name = 'NavdataBusyError';
  }
}

/** NAVDATA_DB_PATH overrides; unset and empty mean <cwd>/navdata.db. Read per call. */
export function resolveNavdataPath(): string {
  return process.env.NAVDATA_DB_PATH || path.join(process.cwd(), DEFAULT_NAVDATA_FILENAME);
}

/** The Little Navmap replica: beside the simulator replica, so rename(2) stays atomic and it lives on the navdata volume. */
export function resolveLnmNavdataPath(): string {
  return resolveNavdataPath() + LNM_SUFFIX;
}

/** The only directory a server-side Little Navmap import may read from. */
export function navdataImportDir(): string {
  return path.dirname(resolveNavdataPath());
}

type Slot = 'mcdu' | 'lnm';

let mcduDb: Database.Database | null = null;
let lnmDb: Database.Database | null = null;
let selectedSource: NavdataSource = 'mcdu';
let busy = false;

const handleOf = (slot: Slot): Database.Database | null => {
  const db = slot === 'mcdu' ? mcduDb : lnmDb;
  return db && db.open ? db : null;
};

function setHandle(slot: Slot, db: Database.Database | null): void {
  if (slot === 'mcdu') mcduDb = db;
  else lnmDb = db;
}

function closeSlot(slot: Slot): void {
  const db = slot === 'mcdu' ? mcduDb : lnmDb;
  if (db && db.open) checkpointAndClose(db);
  setHandle(slot, null);
}

/** Plain close, no checkpoint: for a handle that may point at a file that was replaced or deleted under it. */
function releaseSlot(slot: Slot): void {
  const db = slot === 'mcdu' ? mcduDb : lnmDb;
  if (db && db.open) db.close();
  setHandle(slot, null);
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function checkpointAndClose(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort; close still flushes.
  }
  db.close();
}

/** An fs error's message embeds absolute paths; its code does not. */
const errorLabel = (err: unknown): string => {
  const e = err as { code?: unknown; name?: unknown };
  return String(e.code ?? e.name ?? 'Error');
};

/** Opens the file and confirms its schema version; null (handle closed) when unusable. */
function openAndCheck(file: string): Database.Database | null {
  const name = path.basename(file);
  let db: Database.Database | null = null;
  try {
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const meta = db.prepare('SELECT schema_version FROM nav_meta WHERE id = 1').get() as
      | { schema_version: number }
      | undefined;
    if (meta && meta.schema_version === NAVDATA_SCHEMA_VERSION) return db;
    console.warn(
      `navdata: ${name} has schema_version ${meta ? meta.schema_version : 'none'}, ` +
        `expected ${NAVDATA_SCHEMA_VERSION}; treating the replica as absent`,
    );
  } catch (err) {
    console.warn(`navdata: cannot open ${name}: ${errorLabel(err)}; treating the replica as absent`);
  }
  if (db && db.open) db.close();
  return null;
}

/** Unlinks every file in the target's directory whose name starts with prefix. */
function unlinkByPrefix(dir: string, prefix: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      unlinkQuiet(path.join(dir, name));
    } catch (err) {
      console.warn(`navdata: could not remove stale ${name}: ${errorLabel(err)}`);
    }
  }
}

function unlinkStaleIncoming(target: string): void {
  unlinkByPrefix(path.dirname(target), path.basename(target) + INCOMING_INFIX);
}

/** Path for an incoming snapshot: same directory as the target so rename(2) stays atomic. */
export function incomingNavdataPath(target: string = resolveNavdataPath()): string {
  return `${target}${INCOMING_INFIX}${process.pid}-${Date.now()}`;
}

/** Path for an uploaded Little Navmap database in flight: the navdata volume, never the OS temp directory. */
export function lnmUploadSpoolPath(): string {
  return `${resolveLnmNavdataPath()}${UPLOAD_INFIX}${process.pid}-${Date.now()}`;
}

/**
 * Startup: clears leftover incoming and upload files of both replicas and opens
 * each replica that exists. Nothing else in the directory is touched (the
 * operator's own .sqlite files live there).
 */
export function openNavdata(): void {
  const mcdu = resolveNavdataPath();
  const lnm = resolveLnmNavdataPath();
  unlinkStaleIncoming(mcdu);
  unlinkStaleIncoming(lnm);
  unlinkByPrefix(path.dirname(lnm), path.basename(lnm) + UPLOAD_INFIX);
  releaseSlot('mcdu');
  releaseSlot('lnm');
  mcduDb = fs.existsSync(mcdu) ? openAndCheck(mcdu) : null;
  lnmDb = fs.existsSync(lnm) ? openAndCheck(lnm) : null;
}

/**
 * The simulator replica handle, or null when absent. Throws NavdataBusyError
 * mid-swap. Never await between this call and the last query on the returned
 * handle. This is not the browser's handle: that is getActiveNavDb().
 */
export function getNavDb(): Database.Database | null {
  if (busy) throw new NavdataBusyError();
  return handleOf('mcdu');
}

/** The Little Navmap replica handle, or null when absent or unusable. Never throws. */
export function getLnmNavDb(): Database.Database | null {
  return handleOf('lnm');
}

/** In-memory only: the caller persists the choice. */
export function setSelectedNavdataSource(source: NavdataSource): void {
  selectedSource = source;
}

export function getSelectedNavdataSource(): NavdataSource {
  return selectedSource;
}

/** 'lnm' only when it is selected and its replica is usable; otherwise the simulator replica answers. */
export function effectiveNavdataSource(): NavdataSource {
  return selectedSource === 'lnm' && getLnmNavDb() !== null ? 'lnm' : 'mcdu';
}

/**
 * The handle of the effective source: what every browser-facing read uses. Null
 * when that replica is absent. Throws NavdataBusyError mid-swap. Never await
 * between this call and the last query on the returned handle.
 */
export function getActiveNavDb(): Database.Database | null {
  if (busy) throw new NavdataBusyError();
  return handleOf(effectiveNavdataSource());
}

export function isNavdataBusy(): boolean {
  return busy;
}

/** Checkpoints and closes both replica handles. */
export function closeNavDb(): void {
  closeSlot('mcdu');
  closeSlot('lnm');
}

function discardIncoming(incomingPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkQuiet(incomingPath + suffix);
    } catch {
      // Nothing more to do for a temp file.
    }
  }
}

/**
 * Replaces one replica with a fully built incoming file. `verify` runs on a
 * read-only handle of the checkpointed incoming file and throws to abort; the
 * live file is untouched on an abort. Synchronous: no request runs between
 * marking busy and reopening.
 *
 * If the rename itself fails the target was not replaced, so the old file is
 * reopened and keeps being served (no retry: waiting here would block the event
 * loop while busy). Only a failure after a successful rename leaves the slot
 * empty.
 */
function swapInto(
  target: string,
  slot: Slot,
  incomingPath: string,
  verify?: (incoming: Database.Database) => void,
): void {
  try {
    const built = new Database(incomingPath);
    checkpointAndClose(built);
    if (verify) {
      const check = new Database(incomingPath, { readonly: true });
      try {
        verify(check);
      } finally {
        check.close();
        // Opening a WAL file read-only can leave -wal/-shm beside it; the
        // main file is about to be renamed away, so they would be orphans.
        for (const suffix of ['-wal', '-shm']) {
          try {
            unlinkQuiet(incomingPath + suffix);
          } catch {
            // Best effort; startup clears any stale incoming files.
          }
        }
      }
    }
  } catch (err) {
    discardIncoming(incomingPath);
    throw err;
  }

  let renameFailure: { err: unknown } | null = null;
  busy = true;
  try {
    closeSlot(slot);
    unlinkQuiet(`${target}-wal`);
    unlinkQuiet(`${target}-shm`);
    try {
      fs.renameSync(incomingPath, target);
    } catch (err) {
      renameFailure = { err };
    }
    if (renameFailure) {
      setHandle(slot, fs.existsSync(target) ? openAndCheck(target) : null);
      console.error(`navdata: swap failed, ${path.basename(target)} was not replaced: ${errorLabel(renameFailure.err)}`);
      discardIncoming(incomingPath);
    } else {
      setHandle(slot, openAndCheck(target));
    }
  } catch (err) {
    console.error(`navdata: swap failed, ${path.basename(target)} is absent: ${errorLabel(err)}`);
    releaseSlot(slot);
    discardIncoming(incomingPath);
    throw err;
  } finally {
    busy = false;
  }
  if (renameFailure) throw renameFailure.err;
}

/**
 * Replaces the simulator replica with an incoming file built beside it. The
 * only function that may write navdata.db, and only the sidecar import calls it.
 */
export function swapInReplica(incomingPath: string, verify?: (incoming: Database.Database) => void): void {
  swapInto(resolveNavdataPath(), 'mcdu', incomingPath, verify);
}

/** Replaces the Little Navmap replica; the same algorithm, closing and reopening only its own handle. */
export function swapInLnmReplica(incomingPath: string, verify?: (incoming: Database.Database) => void): void {
  swapInto(resolveLnmNavdataPath(), 'lnm', incomingPath, verify);
}
