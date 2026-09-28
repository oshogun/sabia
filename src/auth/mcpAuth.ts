import type { McpConfig } from '../config';
import type { McpAuthMode } from '../types';
import { verifyMcpToken } from '../db/mcpTokens';
import { mcpSha256, mcpTokenMatches } from './mcpToken';

export type McpCredentialDecision = 'valid' | 'invalid' | 'disabled';

/**
 * 'ui_tokens' if at least one Settings-page MCP token is active; else
 * 'env_token' if MCP_TOKEN is set; else 'disabled'. "UI token wins" is
 * applied here too, for symmetry with the frozen ingest rule (src/auth/ingestAuth.ts).
 */
export function mcpAuthMode(mcp: McpConfig, activeUiTokens: number): McpAuthMode {
  if (activeUiTokens >= 1) return 'ui_tokens';
  if (mcp.token !== null) return 'env_token';
  return 'disabled';
}

/**
 * The one function the /mcp gate calls. Verifies against the live token store
 * on every call, so a token created or revoked on the Settings page takes
 * effect on the very next request, with no restart.
 */
export function checkMcpCredential(
  mcp: McpConfig,
  presented: string | undefined,
  now?: Date,
): McpCredentialDecision {
  const verification = verifyMcpToken(presented, now);
  switch (mcpAuthMode(mcp, verification.activeCount)) {
    case 'ui_tokens':
      return verification.matchedId !== null ? 'valid' : 'invalid';
    case 'env_token':
      return presented && mcpTokenMatches(presented, mcpSha256(mcp.token as string)) ? 'valid' : 'invalid';
    case 'disabled':
      return 'disabled';
  }
}
