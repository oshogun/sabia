import { describe, expect, it } from 'vitest';
import type { FeatureNavaid } from '../../../types';
import { navaidFrequencyLabel, navaidGlyph, navaidRoseEligible } from './navaidGlyph';

function nav(over: Partial<FeatureNavaid> = {}): FeatureNavaid {
  return {
    kind: 'V', ident: 'ZZV', region: 'ZZ', lat: 0, lon: 0, frequencyHz: null, name: null,
    navType: 3, isDme: null, isNav: null, isTacan: null, magvar: null, ...over,
  };
}

describe('navaidGlyph symbol choice', () => {
  it('NDB rows are ndb whatever their flags say', () => {
    expect(navaidGlyph(nav({ kind: 'N', isNav: null, isTacan: null, magvar: 10 })).symbol).toBe('ndb');
    expect(navaidGlyph(nav({ kind: 'N', isNav: null, magvar: 10 })).rose).toBe(false);
  });
  it('ILS/LOC (navType 4) is basic with no rose, even with isNav and magvar', () => {
    const g = navaidGlyph(nav({ navType: 4, isNav: true, isTacan: false, isDme: true, magvar: 10 }));
    expect(g.symbol).toBe('basic');
    expect(g.rose).toBe(false);
    expect(g.roseRotationDeg).toBeNull();
  });
  it('null isNav or null isTacan is basic', () => {
    expect(navaidGlyph(nav({ isNav: null, isTacan: false, isDme: true })).symbol).toBe('basic');
    expect(navaidGlyph(nav({ isNav: true, isTacan: null, isDme: true, magvar: 5 })).symbol).toBe('basic');
    expect(navaidGlyph(nav()).symbol).toBe('basic');
  });
  it('VORTAC, TACAN, VOR/DME, VOR, DME', () => {
    expect(navaidGlyph(nav({ isNav: true, isTacan: true, isDme: true })).symbol).toBe('vortac');
    expect(navaidGlyph(nav({ isNav: false, isTacan: true, isDme: true, navType: null })).symbol).toBe('tacan');
    expect(navaidGlyph(nav({ isNav: true, isTacan: false, isDme: true })).symbol).toBe('vordme');
    expect(navaidGlyph(nav({ isNav: true, isTacan: false, isDme: false })).symbol).toBe('vor');
    expect(navaidGlyph(nav({ isNav: false, isTacan: false, isDme: true })).symbol).toBe('dme');
  });
  it('null isDme forces basic only where it decides the symbol', () => {
    expect(navaidGlyph(nav({ isNav: true, isTacan: false, isDme: null })).symbol).toBe('basic');
    expect(navaidGlyph(nav({ isNav: false, isTacan: false, isDme: null })).symbol).toBe('basic');
    expect(navaidGlyph(nav({ isNav: false, isTacan: false, isDme: false })).symbol).toBe('basic');
    expect(navaidGlyph(nav({ isNav: true, isTacan: true, isDme: null })).symbol).toBe('vortac');
  });
});

describe('navaidGlyph rose', () => {
  const vor = { isNav: true, isTacan: false, isDme: false } as const;
  it('rotates by mod360(-magvar)', () => {
    expect(navaidGlyph(nav({ ...vor, magvar: 20 })).roseRotationDeg).toBe(340);
    expect(navaidGlyph(nav({ ...vor, magvar: 346.5 })).roseRotationDeg).toBe(13.5);
    const zero = navaidGlyph(nav({ ...vor, magvar: 0 })).roseRotationDeg;
    expect(zero).toBe(0);
    expect(Object.is(zero, 0)).toBe(true);
  });
  it('is drawn for vor, vordme and vortac with a magvar', () => {
    expect(navaidGlyph(nav({ ...vor, magvar: 20 })).rose).toBe(true);
    expect(navaidGlyph(nav({ ...vor, isDme: true, magvar: 20 })).rose).toBe(true);
    expect(navaidGlyph(nav({ isNav: true, isTacan: true, isDme: true, magvar: 20 })).rose).toBe(true);
  });
  it('is absent without a magvar', () => {
    expect(navaidGlyph(nav({ ...vor, magvar: null })).rose).toBe(false);
    expect(navaidGlyph(nav({ ...vor, isDme: true, magvar: null })).rose).toBe(false);
    expect(navaidGlyph(nav({ isNav: true, isTacan: true, isDme: true, magvar: null })).rose).toBe(false);
  });
  it('is suppressed by the density rule', () => {
    const n = nav({ ...vor, magvar: 20 });
    expect(navaidRoseEligible(n)).toBe(true);
    expect(navaidGlyph(n, false).rose).toBe(false);
  });
  it('never appears on dme, tacan, ndb or basic', () => {
    for (const n of [
      nav({ isNav: false, isTacan: false, isDme: true, magvar: 20 }),
      nav({ isNav: false, isTacan: true, isDme: true, magvar: 20 }),
      nav({ kind: 'N', magvar: 20 }),
      nav({ magvar: 20 }),
    ]) {
      expect(navaidGlyph(n).rose).toBe(false);
      expect(navaidRoseEligible(n)).toBe(false);
    }
  });
});

describe('navaidGlyph class letter', () => {
  it('maps navType 3/2/1 to H/L/T and anything else to null', () => {
    expect(navaidGlyph(nav({ navType: 3 })).classLetter).toBe('H');
    expect(navaidGlyph(nav({ navType: 2 })).classLetter).toBe('L');
    expect(navaidGlyph(nav({ navType: 1 })).classLetter).toBe('T');
    expect(navaidGlyph(nav({ navType: 4 })).classLetter).toBeNull();
    expect(navaidGlyph(nav({ navType: null })).classLetter).toBeNull();
  });
  it('is null for NDBs', () => {
    expect(navaidGlyph(nav({ kind: 'N', navType: 3 })).classLetter).toBeNull();
  });
});

describe('navaidFrequencyLabel', () => {
  it('prints VHF in MHz with 2 decimals', () => {
    expect(navaidFrequencyLabel(nav({ frequencyHz: 116500000 }))).toBe('116.50');
    expect(navaidFrequencyLabel(nav({ frequencyHz: 108000000 }))).toBe('108.00');
  });
  it('prints NDB in kHz with 0 or 1 decimal', () => {
    expect(navaidFrequencyLabel(nav({ kind: 'N', frequencyHz: 373000 }))).toBe('373');
    expect(navaidFrequencyLabel(nav({ kind: 'N', frequencyHz: 382500 }))).toBe('382.5');
  });
  it('is null without a positive frequency', () => {
    expect(navaidFrequencyLabel(nav({ frequencyHz: null }))).toBeNull();
    expect(navaidFrequencyLabel(nav({ frequencyHz: 0 }))).toBeNull();
  });
});
