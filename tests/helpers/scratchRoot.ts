// Temporary storage root for test databases, replica snapshots and scratch files.
// Exported for use by tests that do not import the real src/db module.

import fs from 'fs';
import os from 'os';

// ── Where the scratch file goes ─────────────────────────────────────────────

let cachedRoot: string | undefined;

/** '/dev/shm' when it exists and is writable, else os.tmpdir(). Memoised. */
export function scratchDbRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  try {
    fs.accessSync('/dev/shm', fs.constants.W_OK);
    if (fs.statSync('/dev/shm').isDirectory()) {
      cachedRoot = '/dev/shm';
      return cachedRoot;
    }
  } catch {
    // fall through to the tmpdir default
  }
  cachedRoot = os.tmpdir();
  return cachedRoot;
}
