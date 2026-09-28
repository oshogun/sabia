import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getDb } from './connection';
import type { IngestTokenSummary } from '../types';

export const INGEST_TOKEN_SECRET_PREFIX = 'sbi_';
export const INGEST_TOKEN_LABEL_MAX_LENGTH = 64;
export const MAX_ACTIVE_INGEST_TOKENS = 20;
/** last_used_at is written at most once per this many ms per token. */
export const INGEST_TOKEN_LAST_USED_RESOLUTION_MS = 60_000;

const MAX_PUBLIC_ID_ATTEMPTS = 3;

export interface IngestTokenCreated {
  summary: IngestTokenSummary;
  /** The plaintext. Returned here and nowhere else, ever. */
  secret: string;
}

export interface IngestTokenVerification {
  /** Non-revoked rows at the moment of the check. */
  activeCount: number;
  /** id of the matching active row, or null. */
  matchedId: number | null;
}

interface IngestTokenRow {
  id: number;
  public_id: string;
  token_digest: Buffer;
}

interface IngestTokenSummaryRow {
  id: number;
  public_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** Self-contained — no import from src/auth/, no import from src/db/mcpTokens.ts. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function generateSecret(): string {
  return INGEST_TOKEN_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

function generatePublicId(): string {
  return randomBytes(4).toString('hex');
}

/** label must already be validated/trimmed by the caller. */
export function createIngestToken(label: string, now: Date = new Date()): IngestTokenCreated {
  const createdAt = now.toISOString();

  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    const secret = generateSecret();
    const publicId = generatePublicId();
    try {
      const result = getDb().prepare(`
        INSERT INTO ingest_tokens (public_id, token_digest, label, created_at)
        VALUES (?, ?, ?, ?)
      `).run(publicId, digest(secret), label, createdAt);
      return {
        summary: {
          id: Number(result.lastInsertRowid),
          public_id: publicId,
          label,
          created_at: createdAt,
          last_used_at: null,
        },
        secret,
      };
    } catch (err) {
      const isUniqueViolation = err instanceof Error && err.message.includes('UNIQUE constraint failed');
      if (!isUniqueViolation || attempt === MAX_PUBLIC_ID_ATTEMPTS - 1) throw err;
    }
  }
  // Unreachable: the loop above either returns or rethrows on its last attempt.
  throw new Error('createIngestToken: exhausted retries without creating a row');
}

/** Active rows only, ORDER BY id ASC. Never a digest, never a secret. */
export function listIngestTokens(): IngestTokenSummary[] {
  const rows = getDb().prepare(`
    SELECT id, public_id, label, created_at, last_used_at
    FROM ingest_tokens WHERE revoked_at IS NULL ORDER BY id
  `).all() as IngestTokenSummaryRow[];
  return rows;
}

export function countActiveIngestTokens(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM ingest_tokens WHERE revoked_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/** Idempotent. false iff no row with this id exists at all (revoked or not). */
export function revokeIngestToken(id: number, now: Date = new Date()): boolean {
  const result = getDb().prepare('UPDATE ingest_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now.toISOString(), id);
  if (result.changes > 0) return true;
  const existing = getDb().prepare('SELECT 1 FROM ingest_tokens WHERE id = ?').get(id);
  return existing !== undefined;
}

export function verifyIngestToken(presented: string | undefined, now: Date = new Date()): IngestTokenVerification {
  const rows = getDb().prepare('SELECT id, public_id, token_digest FROM ingest_tokens WHERE revoked_at IS NULL ORDER BY id')
    .all() as IngestTokenRow[];

  if (!presented) {
    return { activeCount: rows.length, matchedId: null };
  }

  const presentedDigest = digest(presented);
  let matchedId: number | null = null;
  // No early exit: every row is compared so the check takes the same time
  // whether the token is the first, the last, or absent entirely.
  for (const row of rows) {
    if (timingSafeEqual(presentedDigest, row.token_digest) && matchedId === null) {
      matchedId = row.id;
    }
  }

  if (matchedId !== null) {
    try {
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - INGEST_TOKEN_LAST_USED_RESOLUTION_MS).toISOString();
      getDb().prepare(`
        UPDATE ingest_tokens SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)
      `).run(nowIso, matchedId, staleBefore);
    } catch (err) {
      // A busy writer must not turn a valid token into a rejected request.
      console.warn(`[Auth] Could not record token use: ${(err as Error).message}`);
    }
  }

  return { activeCount: rows.length, matchedId };
}
