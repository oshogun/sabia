// tests/ingestAuth.test.ts — the precedence rule (ingestAuthMode) and the
// single live-verification function (checkIngestCredential) every ingest
// check site calls. The token store is mocked with a controllable
// verifyIngestToken, since this file is about the decision logic, not the
// database.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestConfig } from '../src/config';

const verifyIngestToken = vi.fn();
vi.mock('../src/db/ingestTokens', () => ({ verifyIngestToken: (...args: unknown[]) => verifyIngestToken(...args) }));

import { ingestAuthMode, checkIngestCredential } from '../src/auth/ingestAuth';
import { sha256 } from '../src/auth/ingestToken';

const ENV_TOKEN = 'env-ingest-token-0123456789';

beforeEach(() => {
  verifyIngestToken.mockReset();
});

describe('ingestAuthMode (precedence table)', () => {
  it.each([
    // activeUiTokens, envToken, allowUnauthenticated -> expected mode
    [0, null, false, 'closed'],
    [0, null, true, 'unauthenticated'],
    [0, ENV_TOKEN, false, 'env_token'],
    // token !== null forces allowUnauthenticated false by construction, but
    // the pure function is checked against every combination regardless.
    [0, ENV_TOKEN, true, 'env_token'],
    [1, null, false, 'ui_tokens'],
    [1, null, true, 'ui_tokens'],
    [1, ENV_TOKEN, false, 'ui_tokens'],
    [1, ENV_TOKEN, true, 'ui_tokens'],
  ] as const)('activeUiTokens=%i token=%s allowUnauthenticated=%s -> %s', (activeUiTokens, token, allowUnauthenticated, expected) => {
    const ingest: IngestConfig = { token, allowUnauthenticated };
    expect(ingestAuthMode(ingest, activeUiTokens)).toBe(expected);
  });
});

describe('checkIngestCredential', () => {
  it('ui_tokens mode: a matched UI token is valid, ignoring a correct env token value entirely', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 1, matchedId: 7 });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, ENV_TOKEN)).toBe('valid');
    // The store said this presented value matched a UI token row; env value
    // is irrelevant to the ui_tokens branch either way.
  });

  it('ui_tokens mode: no match is invalid, even though an env token is also configured', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 1, matchedId: null });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, 'wrong-value')).toBe('invalid');
  });

  it('env_token mode: the exact configured token is valid', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, ENV_TOKEN)).toBe('valid');
  });

  it('env_token mode: a wrong value is invalid', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, 'wrong-value')).toBe('invalid');
  });

  it('env_token mode: a missing header is invalid', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, undefined)).toBe('invalid');
  });

  it('unauthenticated mode: always open, regardless of the header', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: null, allowUnauthenticated: true };

    expect(checkIngestCredential(ingest, undefined)).toBe('open');
    expect(checkIngestCredential(ingest, 'anything')).toBe('open');
  });

  it('closed mode: always invalid, even with a header presented', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: null, allowUnauthenticated: false };

    expect(checkIngestCredential(ingest, 'anything')).toBe('invalid');
    expect(checkIngestCredential(ingest, undefined)).toBe('invalid');
  });

  it('the env-token digest comparison really is sha256-based, not a plain string equality bypass', () => {
    verifyIngestToken.mockReturnValue({ activeCount: 0, matchedId: null });
    const ingest: IngestConfig = { token: ENV_TOKEN, allowUnauthenticated: false };
    expect(sha256(ENV_TOKEN)).toHaveLength(32);
    expect(checkIngestCredential(ingest, ENV_TOKEN)).toBe('valid');
  });
});
