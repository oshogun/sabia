import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { assignProcKeys, type ProcKeyRecord } from '../src/navdata/keys';

const FILE = path.join(__dirname, 'fixtures', 'navdata', 'approach-collision-vectors.json');
const SHA256 = '8fa9a62a223fb619218387578029d0e25e8e2f6b40295580b5e23b6225a236cd';
const BYTES = 13816;

interface Vector {
  name: string;
  baseKey: string;
  orderIndependent: boolean;
  records: Record<string, unknown>[];
  expected: Record<string, string>;
  expectedReversed: Record<string, string>;
}

const raw = fs.readFileSync(FILE);
const vectors = (JSON.parse(raw.toString('utf8')) as { vectors: Vector[] }).vectors;

// JSON has no NaN literal; the fixture spells it as the string "NaN".
const load = (r: Record<string, unknown>): ProcKeyRecord => {
  const num = (v: unknown) => (v === 'NaN' ? Number.NaN : (v as number | null | undefined));
  return {
    id: r.id as string,
    fafIdent: r.fafIdent as string | null | undefined,
    nTransitions: num(r.nTransitions),
    missedLegCount: num(r.missedLegCount),
    missedAltM: num(r.missedAltM),
  };
};

const toObject = (m: Map<string, string>) => Object.fromEntries(m);

describe('shared approach collision vectors', () => {
  it('are the exact bytes both repositories agreed on', () => {
    expect(raw.length).toBe(BYTES);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(SHA256);
  });

  it.each(vectors.map(v => [v.name, v] as const))('%s: file order', (_n, v) => {
    expect(toObject(assignProcKeys(v.records.map(load), v.baseKey))).toEqual(v.expected);
  });

  it.each(vectors.map(v => [v.name, v] as const))('%s: reversed order', (_n, v) => {
    expect(toObject(assignProcKeys(v.records.map(load).reverse(), v.baseKey))).toEqual(v.expectedReversed);
  });

  it('covers all eleven vectors, including the mixed-case FAF one', () => {
    expect(vectors).toHaveLength(11);
    expect(vectors.some(v => v.name.startsWith('ZZBF 15'))).toBe(true);
  });

  it('flags orderIndependent exactly where reversing changes nothing', () => {
    for (const v of vectors) {
      const same = Object.entries(v.expected).every(([id, key]) => v.expectedReversed[id] === key);
      expect(v.orderIndependent, v.name).toBe(same);
    }
    expect(vectors.filter(v => !v.orderIndependent).map(v => v.name)).toEqual([expect.stringContaining('identical pair')]);
  });

  it('leaves the base key of a set of one byte-identical', () => {
    const one = vectors.find(v => v.records.length === 1)!;
    const out = assignProcKeys(one.records.map(load), one.baseKey);
    expect([...out.values()]).toEqual([one.baseKey]);
    expect(out.get(one.records[0].id as string)).not.toContain('#');
  });
});

describe('assignProcKeys', () => {
  const rec = (id: string, over: Partial<ProcKeyRecord> = {}): ProcKeyRecord => ({
    id, fafIdent: 'ZZF', nTransitions: 1, missedLegCount: 1, missedAltM: 1, ...over,
  });

  it('sorts an absent value last at every level', () => {
    const cases: Partial<ProcKeyRecord>[] = [
      { fafIdent: null }, { fafIdent: '' }, { nTransitions: null }, { nTransitions: Number.NaN },
      { missedLegCount: undefined }, { missedAltM: null }, { missedAltM: Number.NaN },
    ];
    for (const absent of cases) {
      // The absent record arrives first and must still come second.
      const out = assignProcKeys([rec('x', absent), rec('y')], 'K');
      expect(toObject(out), JSON.stringify(absent)).toEqual({ y: 'K', x: 'K#2' });
    }
  });

  it('ranks each field above the ones after it', () => {
    const out = assignProcKeys([
      rec('c', { missedAltM: 1 }),
      rec('b', { missedLegCount: 0, missedAltM: 9 }),
      rec('a', { nTransitions: 0, missedLegCount: 9, missedAltM: 9 }),
    ], 'K');
    expect(toObject(out)).toEqual({ a: 'K', b: 'K#2', c: 'K#3' });
  });

  it('compares numbers numerically, not as text', () => {
    const out = assignProcKeys([rec('ten', { nTransitions: 10 }), rec('nine', { nTransitions: 9 })], 'K');
    expect(toObject(out)).toEqual({ nine: 'K', ten: 'K#2' });
  });

  it('uses arrival position only when the data ties, and never emits #1', () => {
    const out = assignProcKeys([rec('p'), rec('q'), rec('r')], 'K');
    expect(toObject(out)).toEqual({ p: 'K', q: 'K#2', r: 'K#3' });
    expect([...out.values()].some(k => k.endsWith('#1'))).toBe(false);
  });

  it('gives the same answer for any input order when several fields are NaN or absent', () => {
    const set = [
      rec('a', { missedAltM: Number.NaN }), rec('b', { missedAltM: 5 }), rec('c', { missedAltM: null }),
      rec('d', { missedAltM: 2 }), rec('e', { nTransitions: Number.NaN }),
    ];
    const first = toObject(assignProcKeys(set, 'K'));
    expect(first).toMatchObject({ d: 'K', b: 'K#2' });
    for (const perm of [[...set].reverse(), [set[2], set[4], set[0], set[3], set[1]]]) {
      const got = toObject(assignProcKeys(perm, 'K'));
      expect(got.d).toBe('K');
      expect(got.b).toBe('K#2');
      expect(got.e).toBe('K#5');
    }
  });
});
