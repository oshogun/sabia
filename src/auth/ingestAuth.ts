import type { IngestConfig } from '../config';
import type { IngestAuthMode } from '../types';
import { verifyIngestToken } from '../db/ingestTokens';
import { sha256, ingestTokenMatches } from './ingestToken';

export type IngestCredentialDecision = 'valid' | 'invalid' | 'open';

/**
 * Precedence, first match wins:
 *   1. activeUiTokens >= 1        -> 'ui_tokens'          (env token and opt-out ignored)
 *   2. ingest.token !== null      -> 'env_token'
 *   3. ingest.allowUnauthenticated -> 'unauthenticated'
 *   4. otherwise                  -> 'closed'
 * Pure: no I/O, no clock.
 */
export function ingestAuthMode(ingest: IngestConfig, activeUiTokens: number): IngestAuthMode {
  if (activeUiTokens >= 1) return 'ui_tokens';
  if (ingest.token !== null) return 'env_token';
  if (ingest.allowUnauthenticated) return 'unauthenticated';
  return 'closed';
}

/**
 * The one function every ingest-token check site calls. Verifies against the
 * live token store on every call (never a digest computed once at
 * construction), so a token created or revoked on the Settings page takes
 * effect on the very next request, with no restart.
 */
export function checkIngestCredential(
  ingest: IngestConfig,
  presented: string | undefined,
  now?: Date,
): IngestCredentialDecision {
  const verification = verifyIngestToken(presented, now);
  switch (ingestAuthMode(ingest, verification.activeCount)) {
    case 'ui_tokens':
      return verification.matchedId !== null ? 'valid' : 'invalid';
    case 'env_token':
      return presented && ingestTokenMatches(presented, sha256(ingest.token as string)) ? 'valid' : 'invalid';
    case 'unauthenticated':
      return 'open';
    case 'closed':
      return 'invalid';
  }
}
