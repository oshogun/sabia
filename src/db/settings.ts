import { getDb } from './connection';

// ── Auth: operator account, sessions, app secrets ─────────────────────────────
//
// The only database access the auth stack performs. Three tables, none of which
// references or is referenced by anything else in the schema.

/** The single operator row. `id` is pinned to 1 by a CHECK constraint. */
export interface AuthUserRow {
  id: 1;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

/** null when the deployment has no operator account yet. */
export function getAuthUser(): AuthUserRow | null {
  const row = getDb().prepare('SELECT id, username, password_hash, created_at, updated_at FROM auth_user WHERE id = 1')
    .get() as AuthUserRow | undefined;
  return row ?? null;
}

/**
 * Inserts or updates row id=1. Used only by the set-password CLI
 * (src/setPassword.ts). created_at survives a password change; updated_at
 * does not.
 */
export function setAuthUser(username: string, passwordHash: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO auth_user (id, username, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username      = excluded.username,
      password_hash = excluded.password_hash,
      updated_at    = excluded.updated_at
  `).run(username, passwordHash, now, now);
}

export function getAppSecret(name: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_secret WHERE name = ?').get(name) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Returns the stored secret, generating and storing one on first call. The
 * read and the insert share one transaction, so two callers in the same process
 * cannot produce two secrets.
 */
export function getOrCreateAppSecret(name: string, generate: () => string): string {
  return getDb().transaction((): string => {
    const row = getDb().prepare('SELECT value FROM app_secret WHERE name = ?').get(name) as { value: string } | undefined;
    if (row) return row.value;
    const value = generate();
    getDb().prepare('INSERT INTO app_secret (name, value, created_at) VALUES (?, ?, ?)')
      .run(name, value, new Date().toISOString());
    return value;
  })();
}

/** Returns null when the setting has never been set, or was cleared. */
export function getSetting(name: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_setting WHERE name = ?').get(name) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Upserts a setting. A null or empty value deletes the row, so "unset" has
 * exactly one representation and getSetting() stays total and single-valued.
 */
export function setSetting(name: string, value: string | null): void {
  if (value === null || value === '') {
    getDb().prepare('DELETE FROM app_setting WHERE name = ?').run(name);
    return;
  }
  getDb().prepare(`
    INSERT INTO app_setting (name, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at
  `).run(name, value, new Date().toISOString());
}

/** expires_at is epoch milliseconds; expiry itself is the store's business. */
export function sessionGet(sid: string): { data: string; expires_at: number } | null {
  const row = getDb().prepare('SELECT data, expires_at FROM auth_session WHERE sid = ?')
    .get(sid) as { data: string; expires_at: number } | undefined;
  return row ?? null;
}

export function sessionSet(sid: string, data: string, expiresAt: number): void {
  getDb().prepare(`
    INSERT INTO auth_session (sid, data, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET
      data       = excluded.data,
      expires_at = excluded.expires_at
  `).run(sid, data, expiresAt);
}

/**
 * Sets an existing session's expires_at to `expiresAt`, later or earlier than
 * the stored value. Never inserts: a session deleted by a logout or a password
 * change stays deleted, whatever a request still in flight for it does. Returns
 * the number of rows changed, 0 or 1.
 */
export function sessionTouch(sid: string, expiresAt: number): number {
  return getDb().prepare('UPDATE auth_session SET expires_at = ? WHERE sid = ?').run(expiresAt, sid).changes;
}

export function sessionDestroy(sid: string): void {
  getDb().prepare('DELETE FROM auth_session WHERE sid = ?').run(sid);
}

/** Deletes every row with expires_at <= now. Returns the number deleted. */
export function sessionSweep(now: number): number {
  return getDb().prepare('DELETE FROM auth_session WHERE expires_at <= ?').run(now).changes;
}

/** Deletes every session except `keepSid`. Returns the number deleted. Used by
 *  a password change to log out every other session in one step. */
export function sessionDestroyAllExcept(keepSid: string): number {
  return getDb().prepare('DELETE FROM auth_session WHERE sid != ?').run(keepSid).changes;
}
