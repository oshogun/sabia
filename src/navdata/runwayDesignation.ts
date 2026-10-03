// Runway designation text ("27L", "NE") from the simulator's
// number/designator pair. This module imports nothing, so the
// Little Navmap import worker can use it without loading query.ts and the
// database modules query.ts imports.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DESIGNATOR = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

/** "27L" from the SDK's number/designator pair; '' when there is no usable number. */
export function runwayDesignation(number: number | null, designator: number | null): string {
  if (number == null || !Number.isInteger(number)) return '';
  if (number >= 37 && number <= 44) return COMPASS[number - 37];
  if (number < 1 || number > 36) return '';
  const suffix = designator != null && designator >= 0 && designator < DESIGNATOR.length ? DESIGNATOR[designator] : '';
  return String(number).padStart(2, '0') + suffix;
}
