import session from 'express-session';
import type { SessionData } from 'express-session';
import { sessionGet, sessionSet, sessionDestroy, sessionTouch } from '../db';

/**
 * How far a session's stored expiry may trail the one its cookie carries before
 * a touch writes it. `rolling: true` moves the expiry forward on every request;
 * saving it every time would make each authenticated request write to
 * flights.db on the main thread, and that write waits for the filesystem
 * journal whenever something else keeps the disk busy (a navdata import does
 * for minutes), so every request would stall with it. Saving at most once an
 * hour means a session can end up to an hour before its cookie says, never
 * later: an expiry that moves earlier than the stored one (a clock set back, a
 * shorter max age) is saved at once, whatever the amount.
 */
export const TOUCH_SAVE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * express-session Store backed by the auth_session table via the src/db.ts
 * accessors. No MemoryStore (leaks memory, logs the operator out on every
 * restart) and no second native sqlite driver — a thin layer over the
 * accessors this project already has.
 *
 * `length` and `clear` are intentionally not implemented — express-session
 * never calls them.
 */
export class SqliteSessionStore extends session.Store {
  private readonly maxAgeMs: number;
  /**
   * The expires_at of each session as this process last read or wrote it, so a
   * touch can tell without a query whether the stored expiry is due a save.
   */
  private readonly storedExpiry = new Map<string, number>();

  constructor(maxAgeMs: number) {
    super();
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * A missing row, an expired row, and a JSON.parse failure are all reported
   * as "no session" (cb(null, null)), never as an error — one corrupt or
   * stale row must not wedge every request. An expired row is also deleted
   * here.
   */
  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    try {
      const row = sessionGet(sid);
      if (!row) {
        this.storedExpiry.delete(sid);
        callback(null, null);
        return;
      }
      if (row.expires_at <= Date.now()) {
        sessionDestroy(sid);
        this.storedExpiry.delete(sid);
        callback(null, null);
        return;
      }
      let parsed: SessionData;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        this.storedExpiry.delete(sid);
        callback(null, null);
        return;
      }
      this.storedExpiry.set(sid, row.expires_at);
      callback(null, parsed);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, sessionData: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = this.expiryFor(sessionData);
      sessionSet(sid, JSON.stringify(sessionData), expiresAt);
      this.forgetExpired();
      this.storedExpiry.set(sid, expiresAt);
      if (callback) callback();
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      sessionDestroy(sid);
      this.storedExpiry.delete(sid);
      if (callback) callback();
    } catch (err) {
      if (callback) callback(err);
    }
  }

  /**
   * What makes `rolling: true` extend the stored expiry, not just the cookie:
   * the new expiry is saved once it is at least TOUCH_SAVE_INTERVAL_MS past the
   * stored one, or at once when it is earlier than the stored one, so the
   * stored expiry is never later than the cookie's. Otherwise nothing is
   * written. Only the expiry of a row that still exists is changed: a touch
   * never recreates a session that a logout or a password change deleted while
   * this request was running.
   */
  touch(sid: string, sessionData: SessionData, callback?: (err?: unknown) => void): void {
    try {
      const expiresAt = this.expiryFor(sessionData);
      const stored = this.storedExpiry.get(sid);
      if (stored === undefined || expiresAt < stored || expiresAt - stored >= TOUCH_SAVE_INTERVAL_MS) {
        if (sessionTouch(sid, expiresAt) > 0) this.storedExpiry.set(sid, expiresAt);
        else this.storedExpiry.delete(sid);
      }
      if (callback) callback();
    } catch (err) {
      if (callback) callback(err);
    }
  }

  /**
   * Drops the remembered expiry of sessions that have already expired. A
   * session removed by the expiry sweep or by a password change may never be
   * read again, so without this its entry would stay for the life of the
   * process. Called on set(), which runs on a login or a password change, not
   * on every request.
   */
  private forgetExpired(): void {
    const now = Date.now();
    for (const [sid, expiresAt] of this.storedExpiry) {
      if (expiresAt <= now) this.storedExpiry.delete(sid);
    }
  }

  /**
   * Derived from session.cookie.expires when present; an absent or Invalid
   * Date (NaN) falls back to now + maxAgeMs, so a malformed cookie object can
   * never write NaN into the INTEGER NOT NULL expires_at column.
   */
  private expiryFor(sessionData: SessionData): number {
    const expires = sessionData.cookie?.expires;
    if (expires) {
      const t = new Date(expires).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return Date.now() + this.maxAgeMs;
  }
}
