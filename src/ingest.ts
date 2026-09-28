import express, { Router, Request, Response } from 'express';
import type { IngestConfig } from './config';
import type { FlightManager } from './flightManager';
import type { SimFrame, TrafficObject } from './types';
import { TrafficStore, roundCoord, roundAlt, normHeading, applyRetentionCap } from './trafficStore';
import { checkIngestCredential } from './auth/ingestAuth';

const STALE_TIMEOUT_MS = 10_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

// Server rejects a batch with more than this many objects. The agent
// truncates to the same number before posting, so reaching this case in
// normal operation means something is wrong.
const MAX_BATCH_OBJECTS = 200;

// Same name, same parsing rule as the agent's: disabled iff the trimmed,
// lowercased value is exactly one of these; unset, empty, or anything else
// means enabled.
const TRAFFIC_DISABLED_VALUES = ['0', 'false', 'off', 'no'];
function parseTrafficEnabled(value: string | undefined): boolean {
  return !TRAFFIC_DISABLED_VALUES.includes(String(value ?? '').trim().toLowerCase());
}

function isValidFrame(body: unknown): body is SimFrame {
  if (typeof body !== 'object' || body === null) return false;
  const f = body as Record<string, unknown>;
  return (
    typeof f.lat === 'number' &&
    typeof f.lon === 'number' &&
    typeof f.altitudeFt === 'number' &&
    typeof f.airspeedKnots === 'number' &&
    typeof f.groundSpeedKnots === 'number' &&
    typeof f.headingDeg === 'number' &&
    typeof f.verticalSpeedFpm === 'number' &&
    typeof f.onGround === 'boolean' &&
    typeof f.simRunning === 'number' &&
    typeof f.aircraft === 'string' &&
    (f.parkingBrake === undefined || typeof f.parkingBrake === 'boolean') &&
    (f.engineCount === undefined || (typeof f.engineCount === 'number' && Number.isFinite(f.engineCount))) &&
    (f.enginesRunning === undefined || (typeof f.enginesRunning === 'number' && Number.isFinite(f.enginesRunning)))
  );
}

/**
 * One element of a traffic batch, treated as Record<string, unknown>.
 * Number.isFinite rejects NaN, +/-Infinity, null, undefined, strings and
 * missing keys in one predicate. onGround is the only optional field.
 */
function isValidTrafficElement(o: unknown): o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null) return false;
  const t = o as Record<string, unknown>;
  return (
    Number.isInteger(t.id) && (t.id as number) >= 0 &&
    Number.isFinite(t.lat as number) && (t.lat as number) >= -90 && (t.lat as number) <= 90 &&
    Number.isFinite(t.lon as number) && (t.lon as number) >= -180 && (t.lon as number) <= 180 &&
    Number.isFinite(t.altitudeFt as number) &&
    Number.isFinite(t.headingDeg as number) &&
    (t.onGround === undefined || typeof t.onGround === 'boolean')
  );
}

/** Builds the stored shape from a validated element. A fresh object is
 *  constructed rather than spread, so unknown extra keys (e.g. a stray
 *  "title") are dropped, not carried through. */
function normalizeTrafficElement(o: Record<string, unknown>): TrafficObject {
  return {
    id: o.id as number,
    lat: roundCoord(o.lat as number),
    lon: roundCoord(o.lon as number),
    altitudeFt: roundAlt(o.altitudeFt as number),
    headingDeg: normHeading(o.headingDeg as number),
    onGround: o.onGround === true,
  };
}

export type TrafficBatchResult =
  | { ok: true; objects: TrafficObject[] }
  | { ok: false; error: string };

/**
 * The body-shape and per-element checks plus normalisation and
 * de-duplication, as one pure function so src/inspect-traffic.ts can drive it
 * without HTTP. Does NOT apply the retention cap (applyRetentionCap in
 * src/trafficStore.ts) — that step needs flightManager.appState.lastFrame,
 * which only the caller has — and does not touch the store: a rejected batch
 * must leave both completely unchanged.
 */
export function buildTrafficObjects(body: unknown): TrafficBatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Traffic batch must be a JSON object' };
  }
  const { objects } = body as { objects?: unknown };
  if (!Array.isArray(objects)) {
    return { ok: false, error: 'Traffic batch requires an objects array' };
  }
  if (objects.length > MAX_BATCH_OBJECTS) {
    return { ok: false, error: `Traffic batch exceeds ${MAX_BATCH_OBJECTS} objects` };
  }
  for (let i = 0; i < objects.length; i++) {
    if (!isValidTrafficElement(objects[i])) {
      return { ok: false, error: `Invalid traffic object at index ${i}` };
    }
  }

  // De-duplicate by id through a Map: first-occurrence order, last-occurrence
  // value — re-setting an existing Map key updates its value without moving
  // its position, which is exactly this rule.
  const byId = new Map<number, TrafficObject>();
  for (const raw of objects as Record<string, unknown>[]) {
    const normalized = normalizeTrafficElement(raw);
    byId.set(normalized.id, normalized);
  }
  return { ok: true, objects: [...byId.values()] };
}

/**
 * Receives flight data pushed over HTTP by the MCDU client's sidecar
 * (oshogun/sabia_mcdu), which talks to SimConnect locally on the MSFS
 * machine. This is the only supported way to get data in from a remote sim.
 */
export function createIngestRouter(
  flightManager: FlightManager,
  trafficStore: TrafficStore,
  ingestConfig: IngestConfig,
  onStatusChanged: () => void = () => {},
): Router {
  const router = express.Router();

  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) res.vary('Origin');
    if (origin !== 'coui://html_ui') {
      next();
      return;
    }

    res.set('Access-Control-Allow-Origin', 'coui://html_ui');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Token');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  // The env token comes from AppConfig, not process.env: src/config.ts is the
  // only module that reads the environment for security settings. Tokens
  // created on the Settings page live in the database instead, so the check
  // below is re-run on every request rather than computed once here.
  let lastFrameAt = 0;

  // Read once, at construction — same rule as the agent's. Independent of
  // INGEST_TOKEN: setting one does not imply the other.
  const trafficEnabled = parseTrafficEnabled(process.env.TRAFFIC_ENABLED);
  let trafficDisabledLogged = false;

  const checkAuth = (req: Request, res: Response): boolean => {
    if (checkIngestCredential(ingestConfig, req.get('x-ingest-token')) !== 'invalid') return true;
    res.status(401).json({ error: 'Invalid or missing ingest token' });
    return false;
  };

  const markConnected = () => {
    if (!flightManager.appState.connected) {
      console.log('[Ingest] Agent connected');
    }
    flightManager.appState.connected = true;
    lastFrameAt = Date.now();
  };

  const markDisconnected = () => {
    if (flightManager.appState.connected) {
      console.log('[Ingest] Agent disconnected');
      flightManager.appState.connected = false;
      flightManager.onSimDisconnect();
    }
  };

  // The agent only sends an explicit "disconnected" event when it shuts down cleanly.
  // If it dies or the network drops, this catches the silence instead. This is
  // the one status change with no HTTP response of its own to piggyback on, so
  // it calls onStatusChanged() itself — markDisconnected() does not, precisely
  // so the /event 'disconnected' case (whose common post-switch call already
  // covers it) doesn't fire it twice.
  setInterval(() => {
    if (flightManager.appState.connected && Date.now() - lastFrameAt > STALE_TIMEOUT_MS) {
      console.log('[Ingest] No data received recently — marking disconnected');
      markDisconnected();
      onStatusChanged();
    }
  }, STALE_CHECK_INTERVAL_MS);

  router.post('/frame', (req, res) => {
    if (!checkAuth(req, res)) return;
    if (!isValidFrame(req.body)) {
      res.status(400).json({ error: 'Invalid frame payload' });
      return;
    }
    markConnected();
    flightManager.onFrame(req.body);
    onStatusChanged();
    res.status(204).end();
  });

  router.post('/event', (req, res) => {
    if (!checkAuth(req, res)) return;
    const { type, flags } = req.body as { type?: unknown; flags?: unknown };

    switch (type) {
      // Pause_EX1 bitmask from MSFS. Preferred over the legacy paused/unpaused
      // events below because those do NOT fire for Active Pause.
      case 'pause':
        if (typeof flags !== 'number' || !Number.isFinite(flags)) {
          res.status(400).json({ error: 'pause event requires a numeric flags field' });
          return;
        }
        markConnected();
        flightManager.setPaused(flags !== 0, flags);
        break;

      case 'connected':
        markConnected();
        break;
      case 'disconnected':
        markDisconnected();
        break;
      case 'paused':
        flightManager.setPaused(true);
        break;
      case 'unpaused':
        flightManager.setPaused(false);
        break;
      case 'crashed':
        console.log('[Ingest] Crash detected');
        flightManager.onCrash();
        break;
      default:
        res.status(400).json({ error: `Unknown event type: ${String(type)}` });
        return;
    }
    onStatusChanged();
    res.status(204).end();
  });

  // AI traffic: a one-way, memory-only channel beside the flight-data path
  // above. It never calls markConnected()/markDisconnected(), never touches
  // lastFrameAt, and never calls any FlightManager method — agent
  // connectivity is defined by the flight-data pipeline alone. Checked in
  // this exact order: auth, then the kill switch, then validation; the first
  // failure wins and the store is left completely unchanged.
  router.post('/traffic', (req, res) => {
    if (!checkAuth(req, res)) return;

    if (!trafficEnabled) {
      if (!trafficDisabledLogged) {
        console.log('[Ingest] Traffic disabled (TRAFFIC_ENABLED) — discarding batch');
        trafficDisabledLogged = true;
      }
      res.status(204).end();
      return;
    }

    const result = buildTrafficObjects(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    const capped = applyRetentionCap(result.objects, flightManager.appState.lastFrame);
    trafficStore.replace(capped);
    res.status(204).end();
  });

  return router;
}
