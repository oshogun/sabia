// A gap between points larger than this means recording had stopped, so the
// time is treated as an interruption rather than flight time. Generously above
// the 5 s recording interval so ordinary jitter is never mistaken for an
// interruption.
export const MAX_COUNTED_GAP_MS = 60_000;

// Above GROUND_SPEED_MAX_KTS (a stand roll or a wind-pushed reading should not
// read as a pushback) and below any real pushback or taxi speed. The first
// frame at or above this while GROUND is the off-blocks memo used to
// timestamp OUT.
export const TAXI_OUT_SPEED_KTS = 3;
