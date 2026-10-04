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

// How long FlightManager keeps a FLYING flight open after the simulator's data
// stops, counted from the last frame received. A frame from the same aircraft
// inside this window continues the flight; otherwise the flight is closed at
// that last frame.
export const SIM_SILENCE_HOLD_MS = 180_000;

// How far from the last frame received a returning frame may be and still
// count as the same flight. When the sim was not paused, the distance the last
// ground speed covers in the silence is added to this.
export const SAME_FLIGHT_BASE_NM = 5;

// How long after the last stored point of a flight left open by a previous run
// the first running frame after a server restart may arrive and still continue
// that flight. Longer than the hold because a restart takes longer than a
// dropped connection; a frame from a different aircraft, a later frame or one
// too far away closes the flight at that last stored point instead.
export const RESTART_RESUME_MAX_MS = 600_000;
