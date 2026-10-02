import type { FeatureNavaid } from '../../../types';

export type NavaidSymbol = 'vor' | 'vordme' | 'dme' | 'vortac' | 'tacan' | 'ndb' | 'basic';

export interface NavaidGlyph {
  symbol: NavaidSymbol;
  /** True only for vor, vordme and vortac with a finite magvar, when the density rule allows roses. */
  rose: boolean;
  /** Clockwise screen degrees in [0, 360) the rose is turned by: mod360(-magvar). null when rose is false. */
  roseRotationDeg: number | null;
  /** 'H' navType 3, 'L' navType 2, 'T' navType 1, for kind 'V' only. null otherwise. */
  classLetter: 'H' | 'L' | 'T' | null;
  /** Half the symbol's width in px, used to place the label. */
  halfExtentPx: number;
}

const HALF_EXTENT_PX: Record<NavaidSymbol, number> = {
  basic: 5,
  vor: 6,
  vordme: 8,
  dme: 5.5,
  tacan: 9.2,
  vortac: 9.2,
  ndb: 10.5,
};

const mod360 = (deg: number) => ((deg % 360) + 360) % 360;

function navaidSymbol(n: FeatureNavaid): NavaidSymbol {
  if (n.kind === 'N') return 'ndb';
  if (n.navType === 4) return 'basic';
  if (n.isNav === null || n.isTacan === null) return 'basic';
  if (n.isTacan) return n.isNav ? 'vortac' : 'tacan';
  if (n.isNav) {
    if (n.isDme === true) return 'vordme';
    if (n.isDme === false) return 'vor';
    return 'basic';
  }
  return n.isDme === true ? 'dme' : 'basic';
}

function hasRoseSymbol(symbol: NavaidSymbol): boolean {
  return symbol === 'vor' || symbol === 'vordme' || symbol === 'vortac';
}

/** True when the station is drawn as a VOR-type symbol and has a finite magnetic variation, ignoring the density rule. */
export function navaidRoseEligible(n: FeatureNavaid): boolean {
  return hasRoseSymbol(navaidSymbol(n)) && Number.isFinite(n.magvar);
}

function classLetter(n: FeatureNavaid): NavaidGlyph['classLetter'] {
  if (n.kind !== 'V') return null;
  if (n.navType === 3) return 'H';
  if (n.navType === 2) return 'L';
  if (n.navType === 1) return 'T';
  return null;
}

/** roseAllowed is false when more than ROSE_LIMIT rose-eligible stations are in view. */
export function navaidGlyph(n: FeatureNavaid, roseAllowed = true): NavaidGlyph {
  const symbol = navaidSymbol(n);
  const rose = roseAllowed && navaidRoseEligible(n);
  return {
    symbol,
    rose,
    roseRotationDeg: rose ? mod360(-(n.magvar as number)) : null,
    classLetter: classLetter(n),
    halfExtentPx: HALF_EXTENT_PX[symbol],
  };
}

/** MHz with 2 decimals for VHF stations, kHz with 0 or 1 decimal for NDBs, null when there is no frequency. */
export function navaidFrequencyLabel(n: FeatureNavaid): string | null {
  const hz = n.frequencyHz;
  if (hz === null || !(hz > 0)) return null;
  if (n.kind === 'V') return (Math.round(hz / 10000) / 100).toFixed(2);
  const khz = Math.round(hz / 100) / 10;
  return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}
