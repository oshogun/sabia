// ── Little Navmap units and encodings ────────────────────────────────────────
//
// The atools columns are in feet, nautical miles and a handful of frequency
// units; the replica holds metres, hertz and the west-positive magnetic
// variation the simulator replica uses. Every conversion the converters share
// lives here, so a rule is written once. A helper given a null (a nullable
// source column) answers null.

import type { LnmFlavour } from './types';

export const FT_M = 0.3048;
export const NM_M = 1852;

export function ftToM(ft: number): number;
export function ftToM(ft: number | null | undefined): number | null;
export function ftToM(ft: number | null | undefined): number | null {
  return ft == null ? null : ft * FT_M;
}

export function nmToM(nm: number): number;
export function nmToM(nm: number | null | undefined): number | null;
export function nmToM(nm: number | null | undefined): number | null {
  return nm == null ? null : nm * NM_M;
}

/** Degrees into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * atools stores the variation east positive; the replica stores the simulator's
 * raw value, west positive, in [0, 360). An east variation of 13.5 becomes 346.5.
 */
export function magvarToReplica(east: number): number;
export function magvarToReplica(east: number | null | undefined): number | null;
export function magvarToReplica(east: number | null | undefined): number | null {
  return east == null ? null : norm360(-east);
}

/**
 * The replica holds hertz. MSFS stores com frequencies in hertz already.
 * Navigraph stores kHz truncated to 10 kHz, which turns the 25 kHz channels
 * .x25 and .x75 into .x20 and .x70; those are restored by adding 5 kHz, in the
 * VHF band and in the military UHF band alike. HF and the sub-1,000 values
 * (mostly NDB-borne ATIS) are plain kHz.
 */
export function comFrequencyHz(frequency: number, flavour: LnmFlavour): number {
  if (flavour === 'MSFS') return frequency;
  const channel = frequency % 100;
  return frequency >= 118000 && (channel === 20 || channel === 70) ? (frequency + 5) * 1000 : frequency * 1000;
}

/** vor.frequency is kHz. */
export function vorFrequencyHz(khz: number): number;
export function vorFrequencyHz(khz: number | null | undefined): number | null;
export function vorFrequencyHz(khz: number | null | undefined): number | null {
  return khz == null ? null : Math.round(khz * 1000);
}

/** ils.frequency is kHz. */
export function ilsFrequencyHz(khz: number): number;
export function ilsFrequencyHz(khz: number | null | undefined): number | null;
export function ilsFrequencyHz(khz: number | null | undefined): number | null {
  return khz == null ? null : Math.round(khz * 1000);
}

/** ndb.frequency is kHz x 100, so 37500 is 375 kHz. */
export function ndbFrequencyHz(hundredthsKhz: number): number;
export function ndbFrequencyHz(hundredthsKhz: number | null | undefined): number | null;
export function ndbFrequencyHz(hundredthsKhz: number | null | undefined): number | null {
  return hundredthsKhz == null ? null : Math.round(hundredthsKhz * 10);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The replica holds a final-approach vertical angle as 360 minus the path angle
 * (3.0 degrees descent is 357), NULL when absent.
 *   MSFS:      -100 x v          (-3.57 becomes 357)
 *   NAVIGRAPH: 360 + v for v < 0 (-3.0 becomes 357); a non-negative value is no path angle
 * A null or zero source, or a result that is not a positive angle, is NULL.
 */
export function verticalAngleToReplica(v: number | null | undefined, flavour: LnmFlavour): number | null {
  if (v == null || v === 0) return null;
  const replica = flavour === 'MSFS' ? -100 * v : v < 0 ? 360 + v : null;
  return replica != null && Number.isFinite(replica) && replica > 0 ? round2(replica) : null;
}

/** '08T' is runway 08 named by its true bearing; the trailing T is dropped from a two-digit name only. */
export function stripTrueSuffix(name: string): string {
  return /^\d{2}T$/.test(name) ? name.slice(0, 2) : name;
}
