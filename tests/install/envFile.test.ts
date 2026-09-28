// tests/install/envFile.test.ts — parseEnvLines() and mergeEnvFile() against
// the merge rules for `sabia.env`. Pure functions: no filesystem, no network.

import { describe, expect, it, vi } from 'vitest';
import { MANAGED_KEYS, mergeEnvFile, parseEnvLines, type MergeInput } from '../../src/install/envFile';

const baseInput = (over: Partial<MergeInput> = {}): MergeInput => ({
  root: '/opt/sabia',
  defaultBindHost: '0.0.0.0',
  pathSep: '/',
  newToken: () => 'a'.repeat(64),
  ...over,
});

describe('parseEnvLines()', () => {
  it('classifies blank, comment and pair lines, capturing the raw text', () => {
    const lines = parseEnvLines('# header\n\nPORT=3000\nBIND_HOST=0.0.0.0\n');
    expect(lines).toEqual([
      { kind: 'comment', raw: '# header' },
      { kind: 'blank', raw: '' },
      { kind: 'pair', raw: 'PORT=3000', key: 'PORT', value: '3000' },
      { kind: 'pair', raw: 'BIND_HOST=0.0.0.0', key: 'BIND_HOST', value: '0.0.0.0' },
    ]);
  });

  it('truncates a value at the first "#", matching Node\'s own --env-file reader', () => {
    const lines = parseEnvLines('TLS_CERT_FILE=/opt/sabia/certs/sabia.crt#comment\n');
    expect(lines).toEqual([{ kind: 'pair', raw: 'TLS_CERT_FILE=/opt/sabia/certs/sabia.crt#comment', key: 'TLS_CERT_FILE', value: '/opt/sabia/certs/sabia.crt' }]);
  });
});

describe('mergeEnvFile() — file absent', () => {
  it('writes every managed key and reports created:true', () => {
    const result = mergeEnvFile(null, baseInput());
    expect(result.created).toBe(true);
    expect(result.appended).toEqual([...MANAGED_KEYS]);
    expect(result.replaced).toEqual([]);
    expect(result.values.PORT).toBe('3000');
    expect(result.values.BIND_HOST).toBe('0.0.0.0');
    expect(result.values.TLS_CERT_FILE).toBe('/opt/sabia/certs/sabia.crt');
    expect(result.values.INGEST_TOKEN).toBe('a'.repeat(64));
    expect(result.text).not.toMatch(/^﻿/);
    expect(result.text.endsWith('\n')).toBe(true);
    for (const key of MANAGED_KEYS) expect(result.text).toContain(`${key}=`);
  });

  it('honours an explicit port/bind-host on first install', () => {
    const result = mergeEnvFile(null, baseInput({ port: 8443, bindHost: '192.168.1.5' }));
    expect(result.values.PORT).toBe('8443');
    expect(result.values.BIND_HOST).toBe('192.168.1.5');
  });
});

describe('mergeEnvFile() — file present', () => {
  it('preserves every existing line byte-for-byte, order included, appending only missing keys', () => {
    const existing = '# my custom header\nCUSTOM_VAR=keep-me\n\nPORT=9000\nBIND_HOST=127.0.0.1\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=existingtoken1234\n';
    const result = mergeEnvFile(existing, baseInput());

    const lines = result.text.split('\n');
    expect(lines[0]).toBe('# my custom header');
    expect(lines[1]).toBe('CUSTOM_VAR=keep-me');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('PORT=9000');
    expect(lines[4]).toBe('BIND_HOST=127.0.0.1');

    expect(result.created).toBe(false);
    expect(result.appended).toEqual(['NAVDATA_DB_PATH', 'PUPPETEER_CACHE_DIR']);
    expect(result.replaced).toEqual([]);
    expect(result.values.PORT).toBe('9000');
    expect(result.values.BIND_HOST).toBe('127.0.0.1');
    expect(result.values.INGEST_TOKEN).toBe('existingtoken1234');
  });

  it('replaces PORT/BIND_HOST only when the corresponding flag was given this run', () => {
    const existing = 'PORT=9000\nBIND_HOST=127.0.0.1\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=existingtoken1234\n';

    const untouched = mergeEnvFile(existing, baseInput());
    expect(untouched.replaced).toEqual([]);
    expect(untouched.values.PORT).toBe('9000');

    const withPortFlag = mergeEnvFile(existing, baseInput({ port: 3100 }));
    expect(withPortFlag.replaced).toEqual(['PORT']);
    expect(withPortFlag.values.PORT).toBe('3100');
    expect(withPortFlag.values.BIND_HOST).toBe('127.0.0.1'); // BIND_HOST untouched: no flag this run

    const withBoth = mergeEnvFile(existing, baseInput({ port: 3100, bindHost: '0.0.0.0' }));
    expect(withBoth.replaced.sort()).toEqual(['BIND_HOST', 'PORT']);
    expect(withBoth.values.BIND_HOST).toBe('0.0.0.0');
  });

  it('never regenerates an existing, non-empty INGEST_TOKEN — pairing survives every re-run', () => {
    const existing = 'PORT=3000\nBIND_HOST=0.0.0.0\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=paired-with-the-mcdu\n';
    const newToken = vi.fn(() => 'should-never-be-used');

    const result = mergeEnvFile(existing, baseInput({ newToken }));
    expect(result.values.INGEST_TOKEN).toBe('paired-with-the-mcdu');
    expect(result.text).toContain('INGEST_TOKEN=paired-with-the-mcdu');
    expect(result.text).not.toContain('should-never-be-used');

    // Running the merge again, and again, must be a true no-op for the token.
    const again = mergeEnvFile(result.text, baseInput({ newToken }));
    expect(again.values.INGEST_TOKEN).toBe('paired-with-the-mcdu');
  });

  it('fills an INGEST_TOKEN that is present but empty', () => {
    const existing = 'PORT=3000\nBIND_HOST=0.0.0.0\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=\n';
    const result = mergeEnvFile(existing, baseInput());
    expect(result.values.INGEST_TOKEN).toBe('a'.repeat(64));
    expect(result.text).toContain(`INGEST_TOKEN=${'a'.repeat(64)}`);
  });

  it('keeps the last occurrence of a duplicated key and edits only that one', () => {
    const existing = 'PORT=1111\nBIND_HOST=0.0.0.0\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=tok\nPORT=2222\n';
    const result = mergeEnvFile(existing, baseInput({ port: 3100 }));
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('PORT=1111'); // first (stale) occurrence untouched
    expect(lines[5]).toBe('PORT=3100'); // second occurrence is the one edited, in place
    expect(result.values.PORT).toBe('3100');
  });

  it('strips a leading BOM from the content it writes back', () => {
    const existing = '﻿PORT=3000\nBIND_HOST=0.0.0.0\nTLS_CERT_FILE=/opt/sabia/certs/sabia.crt\nTLS_KEY_FILE=/opt/sabia/certs/sabia.key\nINGEST_TOKEN=tok\n';
    const result = mergeEnvFile(existing, baseInput());
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.values.PORT).toBe('3000');
  });

  it('throws rather than write a value containing "#"', () => {
    expect(() => mergeEnvFile(null, baseInput({ root: '/opt/sabia#bad' }))).toThrow(/#/);
  });

  it('throws rather than let a newline in --bind-host or --root inject an extra line', () => {
    expect(() => mergeEnvFile(null, baseInput({ bindHost: '0.0.0.0\nALLOW_UNAUTHENTICATED_INGEST=1' })))
      .toThrow(/line break/);
    expect(() => mergeEnvFile(null, baseInput({ root: '/opt/sabia\r\nEVIL=1' })))
      .toThrow(/line break/);
  });
});
