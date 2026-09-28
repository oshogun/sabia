// tests/install/cli.test.ts — the pure --port parsing shared by every
// subcommand that takes a --port flag. No filesystem, no network, no DB.

import { describe, expect, it } from 'vitest';
import { parsePort } from '../../src/install/cli';

describe('parsePort()', () => {
  it('accepts an integer within the TCP port range', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects 0 and anything above 65535', () => {
    expect(parsePort('0')).toBeUndefined();
    expect(parsePort('65536')).toBeUndefined();
    expect(parsePort('999999')).toBeUndefined();
  });

  it('rejects non-integers and non-numeric input', () => {
    expect(parsePort('3000.5')).toBeUndefined();
    expect(parsePort('abc')).toBeUndefined();
    expect(parsePort('')).toBeUndefined();
    expect(parsePort('-1')).toBeUndefined();
    expect(parsePort('1e3')).toBeUndefined();
  });
});
