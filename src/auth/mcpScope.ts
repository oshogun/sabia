import type { RequestHandler } from 'express';
import type { McpConfig } from '../config';
import { checkMcpCredential } from './mcpAuth';

export interface McpScopedRoute {
  method: 'GET' | 'POST' | 'PATCH';
  /** Exact path, one segment per :param, anchored. No wildcard prefix. */
  pattern: RegExp;
  /** Stable audit name, referenced by a tool descriptor's `route` field. */
  name: string;
  /** 'read' never writes a row; 'write' does. */
  kind: 'read' | 'write';
}

/**
 * The explicit, named set of routes the 18 MCP tools reach. A hardcoded TS
 * constant, not an env var — exactly how INGEST_SCOPED_ROUTES is implemented
 * despite its ALL-CAPS name. Independent of that list: no shared code, no
 * shared name space, even where a name happens to be spelled the same because
 * it names the same route.
 */
export const MCP_SCOPED_ROUTES: readonly McpScopedRoute[] = [
  { method: 'GET', pattern: /^\/api\/flights$/, name: 'flights-list', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/flights\/search$/, name: 'flights-search', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/flights\/stats$/, name: 'flights-stats', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/flights\/[^/]+$/, name: 'flight-read', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/flights\/[^/]+\/acars-messages$/, name: 'flight-acars-read', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/trips$/, name: 'trips-list', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/trips\/[^/]+$/, name: 'trip-read', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/trips\/[^/]+\/journey$/, name: 'trip-journey', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/trips\/[^/]+\/planned-legs$/, name: 'trip-planned-legs', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/planned-legs$/, name: 'planned-legs-list', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/planned-legs\/[^/]+$/, name: 'planned-leg-read', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/planned-legs\/[^/]+\/acars-messages$/, name: 'planned-leg-acars-read', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/acars\/canned-messages$/, name: 'acars-canned-messages', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/status$/, name: 'status', kind: 'read' },
  { method: 'GET', pattern: /^\/api\/ground-sessions\/current$/, name: 'ground-session-current', kind: 'read' },
  { method: 'PATCH', pattern: /^\/api\/flights\/[^/]+$/, name: 'flight-edit-notes', kind: 'write' },
  { method: 'POST', pattern: /^\/api\/trips$/, name: 'trip-create', kind: 'write' },
  { method: 'POST', pattern: /^\/api\/trips\/[^/]+\/flights$/, name: 'trip-assign-flight', kind: 'write' },
  { method: 'POST', pattern: /^\/api\/planned-legs\/simbrief$/, name: 'planned-leg-simbrief-import', kind: 'write' },
];

export function isMcpScopedRoute(method: string, path: string): boolean {
  return MCP_SCOPED_ROUTES.some(route => route.method === method && route.pattern.test(path));
}

/**
 * The only tools allowed to declare `route: null` — there is no
 * side-effect-free route to point them at. One member today: get_weather has
 * no HTTP route of its own, it calls an external weather source directly.
 */
export const ROUTELESS_TOOLS: readonly string[] = ['get_weather'];

/**
 * Startup assertion: every registered tool's declared route must resolve to a
 * name on MCP_SCOPED_ROUTES, and its declared kind must match that route's
 * kind exactly — in both directions, not just "no read tool on a write
 * route", since a write tool silently landing on a route the allow-list
 * considers read-only would be just as wrong. Throws a plain Error at server
 * construction, before any listener is open, never at request time. Nothing
 * checks a request against this list: tool handlers call in-process functions
 * rather than the /api routes it names, and createMcpTokenGate checks only the
 * bearer token, never the path. This assertion is the only runtime use of the
 * list (isMcpScopedRoute has no caller outside tests).
 */
export function assertToolRoutesAreScoped(
  tools: readonly { name: string; route: string | null; kind: 'read' | 'write' }[],
): void {
  for (const tool of tools) {
    if (tool.route === null) {
      if (!ROUTELESS_TOOLS.includes(tool.name)) {
        throw new Error(`MCP tool "${tool.name}" declares no route and is not in ROUTELESS_TOOLS`);
      }
      continue;
    }
    const route = MCP_SCOPED_ROUTES.find(r => r.name === tool.route);
    if (!route) {
      throw new Error(`MCP tool "${tool.name}" points at unknown route "${tool.route}"`);
    }
    if (route.kind !== tool.kind) {
      throw new Error(
        `MCP tool "${tool.name}" declares kind "${tool.kind}" but route "${tool.route}" is "${route.kind}"`
      );
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

/**
 * Authenticates the /mcp endpoint itself, and nothing else. Mounted only on
 * the /mcp router, above express-session — it never sees an /api request,
 * never reads req.session, and requireAuth/requireSameOrigin are untouched by
 * this run. A session cookie, if one is somehow present on the request, is
 * not read and buys nothing: the bearer token is the only credential this
 * gate ever checks. Verified against the live token store on every request,
 * not a digest computed once at construction — a token created or revoked on
 * the Settings page takes effect on the very next request, with no restart.
 * The router itself is always mounted now (src/server.ts): with no MCP
 * credential configured anywhere, `next('router')` leaves the request
 * exactly as if /mcp had never been mounted, rather than answering here.
 */
export function createMcpTokenGate(mcp: McpConfig): RequestHandler {
  return (req, res, next) => {
    const presented = bearerToken(req.get('authorization'));
    const decision = checkMcpCredential(mcp, presented);
    if (decision === 'disabled') { next('router'); return; }
    if (decision === 'valid') { next(); return; }
    res.status(401).set('WWW-Authenticate', 'Bearer realm="msfslogger-mcp"');
    res.json({ error: 'Invalid or missing MCP token', code: 'INVALID_MCP_TOKEN' });
  };
}
