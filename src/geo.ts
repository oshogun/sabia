// ── Shared geo helpers ────────────────────────────────────────────────────────
//
// `haversineNm` also exists privately in src/airports.ts and src/db/flights.ts,
// and `bearingDeg` in src/db/flights.ts. This module's versions are deliberate
// behavioural copies of those — same earth radius, same formula, same operation
// order — so that consolidating the legacy ones onto this module later is a
// pure deletion rather than a numerical change. The flight state machine's own
// copy is already gone: the flight modules import this one.
//
// The remaining copies are NOT migrated as part of the planned-leg feature:
// doing so would put an unrelated edit into the airport lookup and the flight
// queries. What this module guarantees is that no *new* copy gets written:
// src/lnmpln.ts and src/legMatcher.ts must both stay free of ./db and ./airports
// imports, so neither could have borrowed one of the existing copies anyway.

/**
 * Great-circle distance in nautical miles.
 *
 * Antimeridian-safe by construction: the longitude difference only ever enters
 * through sin(dLon / 2)^2, which is periodic, so a leg spanning 179°E → 179°W
 * measures 2° and not 358°. Never subtract raw longitudes to estimate distance.
 */
export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial great-circle bearing in degrees, normalised to 0..360. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const la1 = toRad(lat1);
  const la2 = toRad(lat2);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
