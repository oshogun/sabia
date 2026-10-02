import express from 'express';
import session from 'express-session';
import { MulterError } from 'multer';
import path from 'path';
import { randomBytes } from 'crypto';
import type { FlightManager } from './flightManager';
import { createIngestRouter } from './ingest';
import { NAVDATA_BATCH_MAX_BYTES } from './navdata/store';
import { SidecarStateStore } from './navdata/sidecarState';
import { TrafficStore } from './trafficStore';
import { createAssetsMiddleware } from './staticAssets';
import { getConfig } from './config';
import { getOrCreateAppSecret, setAcarsInsertListener } from './db';
import { EventHub } from './eventHub';
import { createEventsRouter } from './routes/events';
import { SqliteSessionStore } from './auth/sessionStore';
import { requireAuth, requireSameOrigin, SESSION_COOKIE_NAME } from './auth/middleware';
import { createIngestTokenScopeGate } from './auth/ingestScope';
import { createAuthRouter } from './auth/routes';
import {
  MAX_FLIGHT_PLAN_BYTES, MAX_LNMPLN_BYTES, MAX_LNMPLN_FILES, SNAPSHOT_MAX_BYTES,
} from './routes/uploads';
import { createNavdataSyncRouter } from './routes/navdataSync';
import { createNavdataRouter } from './routes/navdata';
import { createNavdataImportRouter } from './routes/navdataImport';
import { createRouteGeometryRouter } from './routes/navdataRouteGeometry';
import { createFlightsRouter } from './routes/flights';
import { createTripsRouter } from './routes/trips';
import { createSettingsRouter } from './routes/settings';
import { createPlannedLegsRouter } from './routes/plannedLegs';
import { createExportsRouter } from './routes/exports';
import { createAcarsRouter } from './routes/acars';
import { createSayIntentionsRouter } from './routes/sayIntentions';
import { createGroundSessionsRouter } from './routes/groundSessions';
import { createMcpRouter } from './mcp/router';

export function createServer(flightManager: FlightManager): express.Express {
  const app = express();
  const config = getConfig();

  // Middleware order is behaviour, and this order is frozen. Anything
  // registered after app.use('/api', requireAuth) below is gated by default,
  // including routes added later.
  // A navdata batch is several MiB, well past the global limit. Path-scoped and
  // registered first so it parses that one path before the global parser sees
  // it (which then skips an already-parsed body); every other path keeps the
  // global limit.
  app.use('/api/navdata/rows', express.json({ limit: NAVDATA_BATCH_MAX_BYTES }));
  app.use(express.json({ limit: config.jsonBodyLimit }));
  // One more public static handler ahead of the one below it, nothing else
  // moves: hashed assets get compression and a long cache lifetime before
  // falling through to the plain express.static that also serves index.html.
  app.use('/assets', createAssetsMiddleware(path.join(process.cwd(), 'client', 'dist')));
  app.use(express.static(path.join(process.cwd(), 'client', 'dist')));

  // One instance per server (not a module-level singleton), so a scratch
  // server starts empty. Never persisted, never written to flights.db.
  const trafficStore = new TrafficStore();

  // The in-process event hub for GET /api/events, and every closure that
  // requests a publish on it. Declared here — before the ingest and MCP
  // routers below, both of which take one of these as a callback — with no
  // side effect until something actually calls one.
  const hub = new EventHub();
  function buildStatusBody(): object {
    const { flightState, currentFlightId, connected, lastFrame, paused, pauseFlags } = flightManager.appState;
    // Only while FLYING, and only when the flight is actually linked — every
    // other case must leave the response byte-identical to before this key
    // existed, so it is spread in rather than ever sent as a literal null.
    const plannedLeg = flightState === 'FLYING' && lastFrame
      ? flightManager.getPlannedLegStatus(lastFrame.lat, lastFrame.lon)
      : null;
    // Present iff flightState === 'GROUND' — never null, so an unchanged
    // AppState serialises byte-identically to before this key existed. Same
    // conditional-spread idiom as plannedLeg.
    const groundSession = flightState === 'GROUND'
      ? flightManager.getGroundSessionStatus()
      : null;
    // Present iff non-empty — never null, never [], absent instead, so an
    // unchanged AppState serialises byte-identically to before this key
    // existed. Same conditional-spread idiom as plannedLeg.
    const traffic = trafficStore.read();
    return {
      connected,
      flightState,
      currentFlightId,
      paused,
      pauseFlags,
      simRunning: lastFrame?.simRunning ?? 0,
      onGround: lastFrame?.onGround ?? true,
      aircraft: lastFrame?.aircraft ?? null,
      frame: lastFrame ? {
        lat:              lastFrame.lat,
        lon:              lastFrame.lon,
        altitudeFt:       lastFrame.altitudeFt,
        airspeedKnots:    lastFrame.airspeedKnots,
        groundSpeedKnots: lastFrame.groundSpeedKnots,
        headingDeg:       lastFrame.headingDeg,
        verticalSpeedFpm: lastFrame.verticalSpeedFpm,
        onGround:         lastFrame.onGround,
      } : null,
      ...(plannedLeg ? { plannedLeg } : {}),
      ...(groundSession ? { groundSession } : {}),
      ...(traffic.length ? { traffic } : {}),
    };
  }

  const requestStatus = () => hub.publishDeferred('status', '', buildStatusBody);
  const requestFlightState = () => hub.publishDeferred('flight-state', '', () => flightManager.getFlightStatePayload());
  const requestDemand = () => hub.publishDeferred('navdata-demand', '', () => ({}));
  const notifyFlightsChanged = () => { hub.publishDeferred('flights-changed', '', () => ({})); requestFlightState(); };
  const notifyPlanChanged = () => { notifyFlightsChanged(); requestDemand(); };

  flightManager.setScopeChangeListener(() => { requestFlightState(); requestStatus(); requestDemand(); });
  // Module-level (src/db/acarsMessages.ts): every writer already routes
  // through insertAcarsMessage/insertAcarsMessageOnce, so this is the one
  // place that turns a created row into a coalesced 'acars' publish, keyed by
  // the scope it hints at. A second createServer() in one process (tests)
  // replaces the previous listener — the last server wins.
  setAcarsInsertListener(hint => hub.publishDeferred('acars', `${hint.flightId}:${hint.plannedLegId}`, () => hint));

  // Deliberately above the session middleware: the agent never sends a cookie,
  // and an ingest request must never allocate or touch the session store.
  // Authenticated by INGEST_TOKEN instead.
  app.use('/api/ingest', createIngestRouter(flightManager, trafficStore, config.ingest, requestStatus));

  // The MCDU sidecar's navdata sync. Same reasoning as the ingest router: no
  // cookie, INGEST_TOKEN instead, above the session middleware. It answers only
  // its own four routes; other /api/navdata paths fall through to the session
  // stack below.
  const sidecarState = new SidecarStateStore();
  app.use('/api/navdata', createNavdataSyncRouter(config.ingest, sidecarState, Date.now, requestDemand));

  // A protocol endpoint, not a REST resource, deliberately outside /api: it
  // authenticates with its own MCP bearer gate rather than requireAuth, and
  // mounting it here — above express-session, like the ingest router — means
  // an MCP request never allocates or touches a session row. Always mounted:
  // with no MCP credential configured anywhere (env or Settings page), the
  // gate itself passes every request straight through untouched, so the
  // observable behaviour is identical to never having mounted it at all.
  app.use('/mcp', createMcpRouter(config.mcp, flightManager, notifyPlanChanged));

  // SESSION_SECRET when the operator set one, otherwise a random 32-byte secret
  // created on first run and stored in app_secret. There is no hard-coded
  // fallback anywhere: the server either finds a secret or makes one.
  const sessionSecret = config.sessionSecretFromEnv
    ?? getOrCreateAppSecret('session_secret', () => randomBytes(32).toString('base64'));

  // `trust proxy` is deliberately NOT set: X-Forwarded-For stays ignored, so a
  // spoofed header cannot poison the login throttle's key, and req.protocol
  // reflects the real connection.
  app.use(session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    store: new SqliteSessionStore(config.sessionMaxAgeMs),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Tied to TLS, never hard-coded: a browser will not send a Secure cookie
      // over plaintext HTTP, and a non-Secure one would cross the network in
      // the clear on a TLS deployment.
      secure: config.tls.enabled,
      path: '/',
      maxAge: config.sessionMaxAgeMs,
    },
  }));

  // Classifier, not a gate: marks a request that matches the ingest-token
  // route allowlist. Mounted after session() because it must see
  // req.session.user, and before requireSameOrigin, which reads the mark.
  app.use(createIngestTokenScopeGate(config.ingest));

  // CSRF defence in depth behind SameSite=Lax; skips GET/HEAD/OPTIONS, non-/api
  // paths and /api/ingest/*.
  app.use(requireSameOrigin);

  // Public by name — it cannot require a session to create one.
  app.use('/api/auth', createAuthRouter());

  // The gate. One mount, not per-handler decoration, so every /api route below
  // — and any unmatched /api path — is 401 without a session.
  app.use('/api', requireAuth);

  app.get('/api/status', (_req, res) => {
    res.json(buildStatusBody());
  });

  // Directly after /api/status, behind requireAuth like every route below it.
  app.use('/api', createEventsRouter(hub, {
    status: buildStatusBody,
    flightState: () => flightManager.getFlightStatePayload(),
  }));

  // ── Flights ────────────────────────────────────────────────────────────────
  // Mounted where the first of these routes used to sit. The whole /api/flights
  // block travels together, including the flight-plan attachment routes that
  // used to be registered further down: nothing under /api/flights can ever be
  // matched by a /api/trips path, so only the order *inside* the router
  // matters — and that is preserved: GET /flights/search and GET /flights/stats
  // are still registered ahead of GET /flights/:id.

  app.use('/api', createFlightsRouter(flightManager, notifyFlightsChanged));

  // ── Trips ──────────────────────────────────────────────────────────────────
  // Same reasoning: the trip routes, /api/active-trip and the trip atlas are one
  // router, mounted in the position the first of them occupied.

  app.use('/api', createTripsRouter(flightManager, notifyPlanChanged));

  // ── Settings ───────────────────────────────────────────────────────────────
  // Mounted here, in the position the routes used to occupy, because
  // registration order is what express matches on.

  app.use('/api', createSettingsRouter(config.ingest, config.mcp, requestDemand));

  // ── Planned legs ───────────────────────────────────────────────────────────
  // Mounted after ── Trips ── and before ── PDF and KML export ──, in the
  // position the block occupied: every literal /api route must be registered
  // before the SPA catch-all below, or the catch-all swallows it.

  app.use('/api', createPlannedLegsRouter(flightManager, notifyPlanChanged));

  // ── Navdata queries and route geometry ─────────────────────────────────────
  // Behind the session gate: the ingest token is never accepted here. The
  // status route shares the sidecar state store the sync router writes to.
  // /planned-legs/:legId/route-geometry has three segments, so none of the
  // planned-legs handlers above can capture it.

  app.use('/api', createNavdataRouter(sidecarState, requestDemand));
  app.use('/api', createRouteGeometryRouter());

  // The Little Navmap import: upload, server-side path, progress and cancel.
  // Session only, like every route here; the ingest token is never accepted.
  // Its multer errors are answered inside the route, not by the handler below.
  app.use('/api', createNavdataImportRouter());

  // ── PDF and KML export ────────────────────────────────────────────────────
  // Mounted before the SPA catch-all so these routes are not swallowed by it.

  app.use('/api', createExportsRouter());

  // ── ACARS ──────────────────────────────────────────────────────────────────
  // Mounted before the SPA catch-all, like every other /api router. Nothing
  // already registered can capture /api/flights/:id/acars-messages: the flights
  // router's /flights/:id handlers match a two-segment path, this is three.

  app.use('/api', createAcarsRouter());

  // ── SayIntentions pull ──────────────────────────────────────────────────────
  // Mounted before the SPA catch-all, like every other /api router. Nothing
  // already registered can capture /api/flights/:id/sayintentions/*: the
  // flights router's handlers are two or three segments, this is four.

  app.use('/api', createSayIntentionsRouter());

  // ── Ground sessions ────────────────────────────────────────────────────────
  // Mounted before the SPA catch-all, like every other /api router. Nothing
  // already registered can capture /api/ground-sessions or its /current path.

  app.use('/api', createGroundSessionsRouter(flightManager, notifyFlightsChanged));

  // Catch-all: let React Router handle client-side routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'client', 'dist', 'index.html'));
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof MulterError && err.field === 'navdataSnapshot') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          ok: false, code: 'NAVDATA_TOO_LARGE',
          message: `Snapshot exceeds ${SNAPSHOT_MAX_BYTES / (1024 * 1024)} MiB`,
        });
        return;
      }
      res.status(400).json({ ok: false, code: 'NAVDATA_BAD_BATCH', message: err.message });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large' &&
        req.path === '/api/navdata/rows') {
      res.status(413).json({ ok: false, code: 'NAVDATA_TOO_LARGE', message: `Batch exceeds ${NAVDATA_BATCH_MAX_BYTES.replace(/mb$/i, ' MiB')}` });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err &&
        (req.path === '/api/navdata/rows' || req.path === '/api/navdata/state')) {
      res.status(400).json({ ok: false, code: 'NAVDATA_BAD_BATCH', message: 'Request body is not valid JSON' });
      return;
    }
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        // err.field distinguishes which multer instance hit its limit: the
        // shared PDF message would be wrong (and misleadingly large) for an
        // oversized .lnmpln.
        const message = err.field === 'lnmpln'
          ? `File too large (max ${MAX_LNMPLN_BYTES / 1024}KB)`
          : `File too large (max ${MAX_FLIGHT_PLAN_BYTES / (1024 * 1024)}MB)`;
        res.status(400).json({ error: message });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ error: `Too many files (max ${MAX_LNMPLN_FILES})` });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    // express.json() rejects a malformed body before any route runs, so the
    // settings and ACARS routes cannot answer it themselves. Scoped to their
    // two paths so every other route keeps the default handling it has always
    // had.
    if (err instanceof SyntaxError && 'body' in err &&
        (req.path.startsWith('/api/settings/') ||
         req.path.endsWith('/acars-messages') ||
         req.path.endsWith('/acars-messages/wx') ||
         req.path === '/api/ground-sessions' ||
         req.path === '/api/ground-sessions/current' ||
         req.path === '/api/navdata/lnm-import/path')) {
      res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
      return;
    }
    // A malformed JSON body never reaches the MCP transport — express.json()
    // throws first — so this is the only place that can answer it, and it
    // answers with a JSON-RPC parse error rather than the plain {error} shape
    // above, per JSON-RPC 2.0.
    if (err instanceof SyntaxError && 'body' in err && req.path === '/mcp') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
    next(err);
  });

  return app;
}
