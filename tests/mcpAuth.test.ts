// tests/mcpAuth.test.ts — the precedence rule (mcpAuthMode) and the single
// live-verification function (checkMcpCredential) the /mcp gate calls. The
// token store is mocked with a controllable verifyMcpToken, since this file
// is about the decision logic, not the database.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConfig } from '../src/config';

const verifyMcpToken = vi.fn();
vi.mock('../src/db/mcpTokens', () => ({ verifyMcpToken: (...args: unknown[]) => verifyMcpToken(...args) }));

import { mcpAuthMode, checkMcpCredential } from '../src/auth/mcpAuth';

const ENV_TOKEN = 'env-mcp-token-0123456789';

beforeEach(() => {
  verifyMcpToken.mockReset();
});

describe('mcpAuthMode (precedence table)', () => {
  it.each([
    [0, null, 'disabled'],
    [0, ENV_TOKEN, 'env_token'],
    [1, null, 'ui_tokens'],
    [1, ENV_TOKEN, 'ui_tokens'],
  ] as const)('activeUiTokens=%i token=%s -> %s', (activeUiTokens, token, expected) => {
    const mcp: McpConfig = { token, enabled: token !== null };
    expect(mcpAuthMode(mcp, activeUiTokens)).toBe(expected);
  });
});

describe('checkMcpCredential', () => {
  it('ui_tokens mode: a matched UI token is valid, ignoring a correct env token value entirely', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 1, matchedId: 3 });
    const mcp: McpConfig = { token: ENV_TOKEN, enabled: true };

    expect(checkMcpCredential(mcp, ENV_TOKEN)).toBe('valid');
  });

  it('ui_tokens mode: no match is invalid, even though an env token is also configured', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 1, matchedId: null });
    const mcp: McpConfig = { token: ENV_TOKEN, enabled: true };

    expect(checkMcpCredential(mcp, 'wrong-value')).toBe('invalid');
  });

  it('env_token mode: the exact configured token is valid', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const mcp: McpConfig = { token: ENV_TOKEN, enabled: true };

    expect(checkMcpCredential(mcp, ENV_TOKEN)).toBe('valid');
  });

  it('env_token mode: a wrong value is invalid', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const mcp: McpConfig = { token: ENV_TOKEN, enabled: true };

    expect(checkMcpCredential(mcp, 'wrong-value')).toBe('invalid');
  });

  it('env_token mode: a missing bearer is invalid', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const mcp: McpConfig = { token: ENV_TOKEN, enabled: true };

    expect(checkMcpCredential(mcp, undefined)).toBe('invalid');
  });

  it('disabled mode: always disabled, regardless of the bearer', () => {
    verifyMcpToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const mcp: McpConfig = { token: null, enabled: false };

    expect(checkMcpCredential(mcp, undefined)).toBe('disabled');
    expect(checkMcpCredential(mcp, 'anything')).toBe('disabled');
  });
});
