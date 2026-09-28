import type { Request, RequestHandler } from 'express';
import type { IngestConfig } from '../config';
import { checkIngestCredential } from './ingestAuth';

export type IngestScopeResult = 'valid' | 'invalid' | 'absent';

/**
 * The explicit, named set of routes an x-ingest-token may reach without a
 * session cookie. A method+path pair not in this list never gets marked, no
 * matter how correct the token is — that is what keeps the token from being
 * a skeleton key for the rest of /api. One path segment per `:param`, exact
 * path only: no trailing slash, no query-string leniency needed since
 * req.path already excludes it, no wildcard prefix.
 */
export const INGEST_SCOPED_ROUTES: readonly { method: 'GET' | 'POST' | 'DELETE'; pattern: RegExp; name: string }[] = [
  { method: 'GET', pattern: /^\/api\/status$/, name: 'status' },
  { method: 'GET', pattern: /^\/api\/acars\/canned-messages$/, name: 'acars-canned-messages' },
  { method: 'GET', pattern: /^\/api\/flights\/[^/]+\/acars-messages$/, name: 'flight-acars-read' },
  { method: 'POST', pattern: /^\/api\/flights\/[^/]+\/acars-messages$/, name: 'flight-acars-post' },
  { method: 'POST', pattern: /^\/api\/flights\/[^/]+\/acars-messages\/wx$/, name: 'flight-acars-wx' },
  { method: 'GET', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages$/, name: 'planned-leg-acars-read' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages$/, name: 'planned-leg-acars-post' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages\/wx$/, name: 'planned-leg-acars-wx' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages\/loadsheet$/, name: 'planned-leg-acars-loadsheet' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages\/clearance$/, name: 'planned-leg-acars-clearance' },
  { method: 'GET', pattern: /^\/api\/ground-sessions\/current$/, name: 'ground-session-current' },
  { method: 'GET', pattern: /^\/api\/settings\/simbrief$/, name: 'settings-simbrief-read' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/simbrief$/, name: 'planned-leg-simbrief-import' },
  { method: 'GET', pattern: /^\/api\/settings\/sayintentions$/, name: 'settings-sayintentions-read' },
  { method: 'GET', pattern: /^\/api\/flights\/[^/]+\/sayintentions\/link$/, name: 'flight-sayintentions-link-read' },
  { method: 'POST', pattern: /^\/api\/flights\/[^/]+\/sayintentions\/link$/, name: 'flight-sayintentions-link' },
  { method: 'DELETE', pattern: /^\/api\/flights\/[^/]+\/sayintentions\/link$/, name: 'flight-sayintentions-unlink' },
  { method: 'POST', pattern: /^\/api\/flights\/[^/]+\/sayintentions\/import$/, name: 'flight-sayintentions-import' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/[^/]+\/sayintentions\/clearance$/, name: 'planned-leg-sayintentions-push' },
  { method: 'GET', pattern: /^\/api\/events$/, name: 'events' },
];

export function isIngestScopedRoute(method: string, path: string): boolean {
  return INGEST_SCOPED_ROUTES.some(route => route.method === method && route.pattern.test(path));
}

// Module-private so nothing outside this file can set or forge it — a
// symbol key cannot be reached by a request body, a query string, a header,
// or a careless Object.assign(req, body) elsewhere in the stack. Readable
// only through ingestScopeOf(req).
const INGEST_SCOPE = Symbol('ingestScope');

interface MarkedRequest extends Request {
  [INGEST_SCOPE]?: IngestScopeResult;
}

/** undefined means the request was never in scope for the token check at
 *  all — off-list route, no configured token, or a valid session already
 *  took precedence. That is exactly today's behaviour. */
export function ingestScopeOf(req: Request): IngestScopeResult | undefined {
  return (req as MarkedRequest)[INGEST_SCOPE];
}

/**
 * Classifies a request against the ingest-token scope and marks it; never
 * sends a response itself. Verifies against the live token store on every
 * request (via checkIngestCredential), not a digest computed once at
 * construction, so a token created or revoked on the Settings page is
 * reflected on the very next request.
 */
export function createIngestTokenScopeGate(ingest: IngestConfig): RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) { next(); return; }
    // A valid session always wins and is never marked — this is also what
    // keeps the CSRF check at full strength for a browser.
    if (req.session && req.session.user) { next(); return; }
    // Off-list: the header is not even read, so the token is useless
    // everywhere else.
    if (!isIngestScopedRoute(req.method, req.path)) { next(); return; }

    const header = req.get('x-ingest-token');
    const decision = checkIngestCredential(ingest, header);
    // The unauthenticated opt-out: the scope is off entirely, not widened to
    // "anyone" — same as the old "no digest configured" early exit.
    if (decision === 'open') { next(); return; }
    const result: IngestScopeResult = !header ? 'absent' : decision;
    (req as MarkedRequest)[INGEST_SCOPE] = result;
    next();
  };
}
