// ── Sidecar liveness, held in memory ──────────────────────────────────────────
//
// The sidecar posts a state report on every transition and once per heartbeat.
// It is a liveness ping, not a fact about the logbook: one instance per server
// (not a module-level singleton) so a scratch server starts empty, and never
// persisted — a restart loses at most one heartbeat of "sidecar known live",
// which the next ping restores.
//
// Staleness is judged on the arrival time, never on the sentAt the report
// carries: that clock belongs to another machine.

import type { Rev, SidecarState, SidecarStateReport, SnapshotId } from './wire';

/** A report older than three heartbeats is no evidence of anything. */
export const NAVDATA_STATE_VALIDITY_MS = 900_000;

const SIDECAR_STATES: ReadonlySet<string> = new Set<SidecarState>([
  'nav.off',
  'nav.unavailable',
  'nav.bulk',
  'nav.ready',
  'nav.error',
]);

export interface SidecarStateRecord {
  state: SidecarState;
  reason: string | null;
  snapshotId: SnapshotId | null;
  rev: Rev | null;
  /** The sidecar's clock. Reported, never compared. */
  sentAt: number;
  /** This server's clock, and the only basis for staleness. */
  receivedAt: number;
}

export function isSidecarState(value: unknown): value is SidecarState {
  return typeof value === 'string' && SIDECAR_STATES.has(value);
}

/** Null when the body is not a state report this server understands. */
export function parseSidecarStateReport(body: unknown): SidecarStateReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || !isSidecarState(b.state)) return null;
  const reason = b.reason == null ? null : String(b.reason);
  const snapshotId = typeof b.snapshotId === 'string' ? b.snapshotId : null;
  const rev = typeof b.rev === 'number' && Number.isInteger(b.rev) ? b.rev : null;
  const sentAt = typeof b.sentAt === 'number' && Number.isFinite(b.sentAt) ? b.sentAt : 0;
  return { v: 1, state: b.state, reason, snapshotId, rev, sentAt };
}

export class SidecarStateStore {
  private last: SidecarStateRecord | null = null;
  private rowsAt: number | null = null;

  /** Records the newest report. Later reports always win, whatever their sentAt. */
  report(body: SidecarStateReport, receivedAt: number = Date.now()): SidecarStateRecord {
    this.last = {
      state: body.state,
      reason: body.reason ?? null,
      snapshotId: body.snapshotId ?? null,
      rev: body.rev ?? null,
      sentAt: body.sentAt,
      receivedAt,
    };
    return this.last;
  }

  /** The newest report, or null when there is none or it has gone stale. */
  read(now: number = Date.now()): SidecarStateRecord | null {
    if (!this.last) return null;
    return now - this.last.receivedAt > NAVDATA_STATE_VALIDITY_MS ? null : this.last;
  }

  /** When rows last landed in the replica, for this process's uptime only. */
  markRowsApplied(at: number = Date.now()): void {
    this.rowsAt = at;
  }

  lastRowsAt(): number | null {
    return this.rowsAt;
  }

  clear(): void {
    this.last = null;
    this.rowsAt = null;
  }
}
