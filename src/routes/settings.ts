import express, { Request, Response, Router } from 'express';
import { getSetting, setSetting, getAuthUser, setAuthUser, sessionDestroyAllExcept } from '../db';
import {
  createIngestToken, listIngestTokens, countActiveIngestTokens, revokeIngestToken,
  INGEST_TOKEN_LABEL_MAX_LENGTH, MAX_ACTIVE_INGEST_TOKENS,
} from '../db/ingestTokens';
import {
  createMcpToken, listMcpTokens, countActiveMcpTokens, revokeMcpToken,
  MCP_TOKEN_LABEL_MAX_LENGTH, MAX_ACTIVE_MCP_TOKENS,
} from '../db/mcpTokens';
import type { IngestConfig, McpConfig } from '../config';
import { ingestAuthMode } from '../auth/ingestAuth';
import { mcpAuthMode } from '../auth/mcpAuth';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../auth/password';
import { LoginThrottle } from '../auth/middleware';
import { SIMBRIEF_USER_ID_SETTING, validateSimbriefUserId } from '../simbrief';
import { SAYINTENTIONS_API_KEY_SETTING, validateSayIntentionsApiKey, maskApiKey } from '../sayIntentions';
import type {
  IngestTokenListResponse, IngestTokenCreateResponse,
  McpTokenListResponse, McpTokenCreateResponse,
  ChangePasswordRequest, ChangePasswordResponse,
} from '../types';

const ID_PATTERN = /^[1-9][0-9]{0,15}$/;

function ingestTokenListBody(ingest: IngestConfig): IngestTokenListResponse {
  const tokens = listIngestTokens();
  return {
    tokens,
    mode: ingestAuthMode(ingest, tokens.length),
    env_token_set: ingest.token !== null,
    unauthenticated_opt_out_set: ingest.allowUnauthenticated,
  };
}

function mcpTokenListBody(mcp: McpConfig): McpTokenListResponse {
  const tokens = listMcpTokens();
  return {
    tokens,
    mode: mcpAuthMode(mcp, tokens.length),
    env_token_set: mcp.token !== null,
  };
}

/** typeof label === 'string' and its trimmed length is 1..max; the trimmed
 *  value is what gets stored. */
function validateLabel(label: unknown, max: number): { ok: true; label: string } | { ok: false } {
  if (typeof label !== 'string') return { ok: false };
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > max) return { ok: false };
  return { ok: true, label: trimmed };
}

/**
 * /api/settings — mounted at '/api' by src/server.ts, so requireAuth gates both
 * routes and requireSameOrigin already CSRF-defends the write.
 *
 * Mounted at '/api' rather than '/api/settings' on purpose: the app-level error
 * handler keys off req.path.startsWith('/api/settings/') to turn a malformed
 * JSON body into INVALID_BODY, and a narrower mount would be bypassed entirely
 * by express.json() rejecting the body before routing.
 */
export function createSettingsRouter(ingest: IngestConfig, mcp: McpConfig): Router {
  const router = express.Router();
  // A separate instance from the login throttle in src/auth/routes.ts: a
  // stolen session cookie must not get an un-throttled oracle against the
  // operator's password, and its failures must not lock the operator out of
  // the login page itself.
  const passwordThrottle = new LoginThrottle();
  const ipOf = (req: Request): string => req.socket.remoteAddress ?? 'unknown';

  router.get('/settings/simbrief', (_req, res) => {
    // Always 200: an unset setting is a value (null), not a 404, so the client
    // never branches on a status to render an empty text box.
    res.json({ simbrief_user_id: getSetting(SIMBRIEF_USER_ID_SETTING) });
  });

  router.put('/settings/simbrief', (req, res) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }

    const result = validateSimbriefUserId((body as Record<string, unknown>).simbrief_user_id);
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: result.code });
      return;
    }

    try {
      setSetting(SIMBRIEF_USER_ID_SETTING, result.userId);
      // Echo what was stored, post-trim, so the client renders what was saved
      // rather than what it typed.
      res.json({ simbrief_user_id: result.userId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/settings/sayintentions', (_req, res) => {
    // Always 200, and — unlike /settings/simbrief — never the key itself: a
    // SayIntentions API key is a credential, not a public identifier, so this
    // route reports only whether one is stored and a masked form of it.
    const key = getSetting(SAYINTENTIONS_API_KEY_SETTING);
    res.json({ sayintentions_api_key_set: key !== null, sayintentions_api_key_masked: maskApiKey(key) });
  });

  router.put('/settings/sayintentions', (req, res) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }

    const result = validateSayIntentionsApiKey((body as Record<string, unknown>).sayintentions_api_key);
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: result.code });
      return;
    }

    try {
      setSetting(SAYINTENTIONS_API_KEY_SETTING, result.apiKey);
      res.json({ sayintentions_api_key_set: result.apiKey !== null, sayintentions_api_key_masked: maskApiKey(result.apiKey) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Ingest tokens ────────────────────────────────────────────────────────

  router.get('/settings/ingest-tokens', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(ingestTokenListBody(ingest));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/settings/ingest-tokens', (req, res) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }
    const validated = validateLabel((body as Record<string, unknown>).label, INGEST_TOKEN_LABEL_MAX_LENGTH);
    if (!validated.ok) {
      res.status(400).json({ error: `label must be a string of 1-${INGEST_TOKEN_LABEL_MAX_LENGTH} characters`, code: 'INVALID_LABEL' });
      return;
    }
    if (countActiveIngestTokens() >= MAX_ACTIVE_INGEST_TOKENS) {
      res.status(409).json({ error: `At most ${MAX_ACTIVE_INGEST_TOKENS} active ingest tokens; revoke one first`, code: 'TOO_MANY_TOKENS' });
      return;
    }
    try {
      const created = createIngestToken(validated.label);
      console.log(`[Settings] Ingest token created: ${created.summary.public_id} "${created.summary.label}"`);
      const responseBody: IngestTokenCreateResponse = { ...ingestTokenListBody(ingest), created: created.summary, secret: created.secret };
      res.set('Cache-Control', 'no-store');
      res.status(201).json(responseBody);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete('/settings/ingest-tokens/:id', (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
      return;
    }
    try {
      const id = Number(req.params.id);
      const publicId = listIngestTokens().find(t => t.id === id)?.public_id;
      const revoked = revokeIngestToken(id);
      if (!revoked) {
        res.status(404).json({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      if (publicId) {
        console.log(`[Settings] Ingest token revoked: ${publicId}`);
      }
      res.json(ingestTokenListBody(ingest));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── MCP tokens ───────────────────────────────────────────────────────────

  router.get('/settings/mcp-tokens', (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(mcpTokenListBody(mcp));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/settings/mcp-tokens', (req, res) => {
    const body = req.body as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }
    const validated = validateLabel((body as Record<string, unknown>).label, MCP_TOKEN_LABEL_MAX_LENGTH);
    if (!validated.ok) {
      res.status(400).json({ error: `label must be a string of 1-${MCP_TOKEN_LABEL_MAX_LENGTH} characters`, code: 'INVALID_LABEL' });
      return;
    }
    if (countActiveMcpTokens() >= MAX_ACTIVE_MCP_TOKENS) {
      res.status(409).json({ error: `At most ${MAX_ACTIVE_MCP_TOKENS} active MCP tokens; revoke one first`, code: 'TOO_MANY_TOKENS' });
      return;
    }
    try {
      const created = createMcpToken(validated.label);
      console.log(`[Settings] MCP token created: ${created.summary.public_id} "${created.summary.label}"`);
      const responseBody: McpTokenCreateResponse = { ...mcpTokenListBody(mcp), created: created.summary, secret: created.secret };
      res.set('Cache-Control', 'no-store');
      res.status(201).json(responseBody);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete('/settings/mcp-tokens/:id', (req, res) => {
    if (!ID_PATTERN.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
      return;
    }
    try {
      const id = Number(req.params.id);
      const publicId = listMcpTokens().find(t => t.id === id)?.public_id;
      const revoked = revokeMcpToken(id);
      if (!revoked) {
        res.status(404).json({ error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
        return;
      }
      if (publicId) {
        console.log(`[Settings] MCP token revoked: ${publicId}`);
      }
      res.json(mcpTokenListBody(mcp));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Password ─────────────────────────────────────────────────────────────

  router.post('/settings/password', (req: Request, res: Response) => {
    const body = req.body as Partial<ChangePasswordRequest> | null;
    if (typeof body !== 'object' || body === null || Array.isArray(body) ||
        typeof body.current_password !== 'string' || typeof body.new_password !== 'string') {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }
    const { current_password: currentPassword, new_password: newPassword } = body;

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, code: 'PASSWORD_TOO_SHORT' });
      return;
    }
    if (newPassword.length > PASSWORD_MAX_LENGTH) {
      res.status(400).json({ error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`, code: 'PASSWORD_TOO_LONG' });
      return;
    }
    if (newPassword.trim().length === 0) {
      res.status(400).json({ error: 'Password must not be blank.', code: 'PASSWORD_BLANK' });
      return;
    }

    const ip = ipOf(req);
    const wait = passwordThrottle.check(ip, Date.now());
    if (wait !== null) {
      res.set('Retry-After', String(wait));
      res.status(429).json({ error: `Too many attempts. Try again in ${wait} seconds.`, code: 'TOO_MANY_ATTEMPTS', retryAfterSec: wait });
      return;
    }

    const row = getAuthUser();
    const fail = (): void => {
      passwordThrottle.recordFailure(ip, Date.now());
      console.log(`[Auth] Password change FAILED (wrong current password) from ${ip}`);
      res.status(403).json({ error: 'Current password is incorrect', code: 'WRONG_CURRENT_PASSWORD' });
    };

    if (row === null) {
      verifyPassword(currentPassword, DUMMY_PASSWORD_HASH);
      fail();
      return;
    }
    if (!verifyPassword(currentPassword, row.password_hash)) {
      fail();
      return;
    }
    if (newPassword === currentPassword) {
      res.status(400).json({ error: 'New password must differ from the current one', code: 'PASSWORD_UNCHANGED' });
      return;
    }

    setAuthUser(row.username, hashPassword(newPassword));
    const otherSessionsRevoked = sessionDestroyAllExcept(req.sessionID);

    // Regenerate BEFORE setting req.session.user: the same session-fixation
    // reasoning as login (src/auth/routes.ts).
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) {
        res.status(500).json({ error: String(regenerateErr) });
        return;
      }
      req.session.user = { username: row.username };
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: String(saveErr) });
          return;
        }
        passwordThrottle.recordSuccess(ip);
        console.log(`[Auth] Password changed from ${ip}; ${otherSessionsRevoked} other session(s) logged out`);
        const responseBody: ChangePasswordResponse = { ok: true, other_sessions_revoked: otherSessionsRevoked };
        res.status(200).json(responseBody);
      });
    });
  });

  return router;
}
