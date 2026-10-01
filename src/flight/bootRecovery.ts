import type { OpenFlightRow } from '../db';
import { getOpenFlight } from '../db';

export type { OpenFlightRow } from '../db';

/**
 * Looks for a flight left open by a previous run and hands it to `resume`.
 * One try/catch covers the lookup and the resume together, so a failing
 * database read, a failing track read or a failing point write while adopting
 * the flight are all warned about and swallowed: the caller carries on as if
 * there were nothing to resume.
 *
 * Returns true only when an open row was found and `resume` returned normally.
 * It keeps no state; asking once per process is the caller's job.
 */
export function tryResumeOpenFlight(resume: (row: OpenFlightRow) => void): boolean {
  try {
    const open = getOpenFlight();
    if (open) {
      resume(open);
      return true;
    }
  } catch (err) {
    console.warn('[FlightManager] Open-flight check failed; starting fresh if a takeoff follows:', err);
  }
  return false;
}
