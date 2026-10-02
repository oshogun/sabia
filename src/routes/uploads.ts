import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';

/**
 * The multipart upload limits, in one place because two of them are read twice:
 * the routes that accept the file, and src/server.ts's error handler, which
 * turns a MulterError back into the message that names the limit it hit.
 */

// Multer's own defaults are `fields: Infinity` and `fieldSize: 1MB`, so a
// multipart request could otherwise carry unbounded non-file fields. A
// legitimate PDF upload sends one file and no fields; the .lnmpln import sends
// at most 25 files and one field (allow_duplicates).
export const MAX_FLIGHT_PLAN_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FIELDS = 5;
const MAX_UPLOAD_FIELD_BYTES = 8192;
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FLIGHT_PLAN_BYTES,
    files: 1,
    fields: MAX_UPLOAD_FIELDS,
    fieldSize: MAX_UPLOAD_FIELD_BYTES,
    parts: 1 + MAX_UPLOAD_FIELDS,   // 6 — one file plus the field allowance
  },
});

// ── LNMPLN import ──────────────────────────────────────────────────────────
// A separate multer instance, deliberately: a real .lnmpln plan is a few KB of
// XML, so it gets its own, much smaller, limit rather than sharing
// MAX_FLIGHT_PLAN_BYTES (20 MB, PDFs).
export const MAX_LNMPLN_BYTES = 512 * 1024;
export const MAX_LNMPLN_FILES = 25;
export const uploadLnmpln = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_LNMPLN_BYTES,
    files: MAX_LNMPLN_FILES,
    fields: MAX_UPLOAD_FIELDS,
    fieldSize: MAX_UPLOAD_FIELD_BYTES,
    parts: MAX_LNMPLN_FILES + MAX_UPLOAD_FIELDS + 1,   // 31 — 25 files plus the field allowance
  },
});

// ── Navdata snapshot ───────────────────────────────────────────────────────
// Disk storage, unlike the two above: a snapshot is far larger than a PDF, is
// consumed as a stream, and holding 64 MiB per request in memory is not a cost
// this server should pay. The route deletes the temp file when it is done.
// The directory is created on the first upload, not at import, with
// owner-only permissions, so the upload location is neither predictable nor
// readable by other local users and a process that never receives a snapshot
// leaves nothing behind.
let snapshotDir: string | null = null;
export function snapshotUploadDir(): string | null {
  return snapshotDir;
}
function ensureSnapshotUploadDir(): string {
  if (!snapshotDir) {
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msfslogger-navdata-'));
    fs.chmodSync(snapshotDir, 0o700);
  }
  return snapshotDir;
}
process.on('exit', () => {
  if (!snapshotDir) return;
  try {
    fs.rmdirSync(snapshotDir);
  } catch {
    // Non-empty or already gone: nothing worth failing an exit over.
  }
});
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const uploadNavdataSnapshot = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, ensureSnapshotUploadDir());
      } catch (err) {
        cb(err as Error, '');
      }
    },
  }),
  limits: { fileSize: SNAPSHOT_MAX_BYTES, files: 1, fields: 0, parts: 1 },
});

// ── Little Navmap database ─────────────────────────────────────────────────
// A Little Navmap database is hundreds of MB, so it is spooled to disk on the
// navdata volume (never the OS temp directory, which may be a small tmpfs)
// and read by the import worker from there.
/** 2 GiB: the largest known database is about 850 MB; this leaves room for a bigger compile. */
export const LNM_UPLOAD_MAX_BYTES = 2 * 1024 ** 3;
/** Multipart framing around the file: boundaries and the part headers. */
export const LNM_UPLOAD_MULTIPART_SLACK_BYTES = 64 * 1024;
/** Free space an import needs beyond the spooled file: about twice the measured size of a built replica. */
export const LNM_BUILD_RESERVE_BYTES = 1024 ** 3;
export const LNM_DISK_MARGIN_BYTES = 256 * 1024 ** 2;
/** Free memory an import needs: the worker's heap cap, plus SQLite's own page caches and sorts. */
export const LNM_MEMORY_RESERVE_BYTES = 1024 ** 3;
/** How long the upload's body may take to arrive; every other request body gets the default deadline. */
export const NAVDATA_UPLOAD_REQUEST_TIMEOUT_MS = 3_600_000;

const lnmSpoolPaths = new WeakMap<object, string>();

/** Names the file the next multer write for this request goes to; the route sets it before calling multer. */
export function setLnmSpoolPath(req: Request, spoolPath: string): void {
  lnmSpoolPaths.set(req, spoolPath);
}

/**
 * One file in the field lnmDatabase and nothing else. The limit is a parameter
 * so a test can use a small one. The destination and name come from the path
 * the route set for the request, per request, because the replica directory
 * can change between requests (NAVDATA_DB_PATH) and a string destination would
 * be fixed when this is built.
 */
export function createUploadLnmDatabase(maxBytes: number): multer.Multer {
  const fromSpoolPath = (
    req: Request, pick: (spoolPath: string) => string, cb: (error: Error | null, value: string) => void,
  ): void => {
    const spoolPath = lnmSpoolPaths.get(req);
    if (spoolPath) cb(null, pick(spoolPath));
    else cb(new Error('no spool path was set for this upload'), '');
  };
  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => fromSpoolPath(req, path.dirname, cb),
      filename: (req, _file, cb) => fromSpoolPath(req, path.basename, cb),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  });
}
