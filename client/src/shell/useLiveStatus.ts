import type { LiveStatusView } from './AppShell';
import { useLiveEvents } from './LiveEventsProvider';
import type { Status } from '../types';

/** Same wording the production header uses, mapped onto Carbon Tag colours. */
export function statusToView(s: Status): LiveStatusView {
  if (!s.connected && s.flightState === 'FLYING') {
    return { type: 'gray', label: `Waiting for sim · ${s.aircraft || 'Unknown'}` };
  }
  if (!s.connected) return { type: 'gray', label: 'Sim not connected' };
  if (s.flightState === 'FLYING') {
    return s.paused
      ? { type: 'magenta', label: `Paused · ${s.aircraft || 'Unknown'}` }
      : { type: 'green', label: `Recording · ${s.aircraft || 'Unknown'}` };
  }
  return { type: 'blue', label: 'Connected · Idle' };
}

/** Live-status view for the header Tag, fed by the shared event stream. */
export function useLiveStatus(): LiveStatusView {
  const { status, serverError } = useLiveEvents();
  if (serverError) return { type: 'red', label: 'Server unreachable' };
  if (!status) return { type: 'gray', label: 'Checking...' };
  return statusToView(status);
}
