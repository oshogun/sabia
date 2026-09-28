import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getDb } from './connection';
import type { McpTokenSummary } from '../types';

// A deliberate, self-contained copy of ingestTokens.ts's shape: no import edge
// to that file, so revoking or changing the policy of either credential never
// requires reading the other.

export const MCP_TOKEN_SECRET_PREFIX = 'sbm_';
export const MCP_TOKEN_LABEL_MAX_LENGTH = 64;
export const MAX_ACTIVE_MCP_TOKENS = 20;
/** last_used_at is written at most once per this many ms per token. */
export const MCP_TOKEN_LAST_USED_RESOLUTION_MS = 60_000;

const MAX_PUBLIC_ID_ATTEMPTS = 3;

export interface McpTokenCreated {
  summary: McpTokenSummary;
  /** The plaintext. Returned here and nowhere else, ever. */
  secret: string;
}

export interface McpTokenVerification {
  /** Non-revoked rows at the moment of the check. */
  activeCount: number;
  /** id of the matching active row, or null. */
  matchedId: number | null;
}

interface McpTokenRow {
  id: number;
  public_id: string;
  token_digest: Buffer;
}

interface McpTokenSummaryRow {
  id: number;
  public_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** Self-contained — no import from src/auth/, no import from src/db/ingestTokens.ts. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function generateSecret(): string {
  return MCP_TOKEN_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

function generatePublicId(): string {
  return randomBytes(4).toString('hex');
}

/** label must already be validated/trimmed by the caller. */
export function createMcpToken(label: string, now: Date = new Date()): McpTokenCreated {
  const createdAt = now.toISOString();

  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    const secret = generateSecret();
    const publicId = generatePublicId();
    try {
      const result = getDb().prepare(`
        INSERT INTO mcp_tokens (public_id, token_digest, label, created_at)
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
  throw new Error('createMcpToken: exhausted retries without creating a row');
}

/** Active rows only, ORDER BY id ASC. Never a digest, never a secret. */
export function listMcpTokens(): McpTokenSummary[] {
  const rows = getDb().prepare(`
    SELECT id, public_id, label, created_at, last_used_at
    FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY id
  `).all() as McpTokenSummaryRow[];
  return rows;
}

export function countActiveMcpTokens(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/** Idempotent. false iff no row with this id exists at all (revoked or not). */
export function revokeMcpToken(id: number, now: Date = new Date()): boolean {
  const result = getDb().prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now.toISOString(), id);
  if (result.changes > 0) return true;
  const existing = getDb().prepare('SELECT 1 FROM mcp_tokens WHERE id = ?').get(id);
  return existing !== undefined;
}

export function verifyMcpToken(presented: string | undefined, now: Date = new Date()): McpTokenVerification {
  const rows = getDb().prepare('SELECT id, public_id, token_digest FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY id')
    .all() as McpTokenRow[];

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
      const staleBefore = new Date(now.getTime() - MCP_TOKEN_LAST_USED_RESOLUTION_MS).toISOString();
      getDb().prepare(`
        UPDATE mcp_tokens SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)
      `).run(nowIso, matchedId, staleBefore);
    } catch (err) {
      // A busy writer must not turn a valid token into a rejected request.
      console.warn(`[Auth] Could not record token use: ${(err as Error).message}`);
    }
  }

  return { activeCount: rows.length, matchedId };
}
