// ── Approach type numbers ─────────────────────────────────────────────────────
//
// The simulator stores an approach's type as a small integer. A plan names its
// approach either by the ARINC leading letter or by a type word, and the route
// lookup maps that onto the stored integer to prefer the right procedure. The
// Little Navmap importer types its approaches through the same letter table, so
// one table serves both sides of the lookup.

/** The plan's ARINC leading letter onto the stored integer. An unknown letter means no preference. */
export const ARINC_LETTER_TYPE: Readonly<Record<string, number>> = {
  I: 4, L: 5, B: 11, R: 10, H: 10, P: 1, V: 2, T: 2, D: 8, N: 3, Q: 9, X: 7, S: 6, U: 6,
};

/** The plan's approach_type word onto the stored integer, used when the plan gives no ARINC letter. */
export const PLAN_APPROACH_TYPE_NAME: Readonly<Record<string, number>> = {
  ILS: 4, LOC: 5, LDA: 7, VOR: 2, VORDME: 8, NDB: 3, NDBDME: 9, RNAV: 10, GPS: 1,
  'LOC-BC': 11, LOCALIZER_BACK_COURSE: 11, SDF: 6,
};

/** Little Navmap's approach.type text onto the stored integer; the importer's fallback when the ARINC name gives no letter. */
export const ATOOLS_APPROACH_TYPE: Readonly<Record<string, number>> = {
  GPS: 1, VOR: 2, TCN: 2, NDB: 3, ILS: 4, IGS: 4, LOC: 5, SDF: 6, LDA: 7, VORDME: 8, NDBDME: 9, RNAV: 10,
  LOCB: 11, GNSS: 0,
};

/**
 * The stored integer for an imported approach. The ARINC name's leading letter
 * decides when it is a known letter; otherwise a circling VOR/DME (no runway)
 * is a VOR approach; otherwise Little Navmap's own type; otherwise 0 (unknown).
 * The letter S stays 6 as it has always been in the lookup, so an imported S
 * approach and a plan's S approach agree.
 */
export function approachTypeOf(
  arincName: string | null,
  atoolsType: string | null,
  runwayName: string | null,
): number {
  const letter = (arincName ?? '').charAt(0).toUpperCase();
  if (letter !== '' && Object.hasOwn(ARINC_LETTER_TYPE, letter)) return ARINC_LETTER_TYPE[letter];
  if (atoolsType === 'VORDME' && runwayName == null) return 2;
  if (atoolsType != null && Object.hasOwn(ATOOLS_APPROACH_TYPE, atoolsType)) return ATOOLS_APPROACH_TYPE[atoolsType];
  return 0;
}
