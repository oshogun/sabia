import express, { type Response } from 'express';
import { effectiveNavdataSource, getActiveNavDb, isNavdataBusy, NavdataBusyError } from '../navdata/connection';
import {
  FEATURE_KINDS, FEATURES_DEFAULT_LIMIT, FEATURES_MAX_LIMIT, parseBbox, parseRequestBody, queryFeatures,
  readAirportDetail, readStatus, submitRequest, type FeatureKind,
} from '../navdata/query';
import type { SidecarStateStore } from '../navdata/sidecarState';
import { navdataSourceState } from '../navdata/source';

function busy(res: Response, err: NavdataBusyError): void {
  res.set('Retry-After', String(err.retryAfterSeconds));
  res.status(503).json({ ok: false, code: 'NAVDATA_BUSY', message: err.message });
}

/** Runs a handler body, mapping a mid-swap replica to 503 and anything else to 500. */
function guarded(res: Response, what: string, body: () => void): void {
  try {
    body();
  } catch (err) {
    if (err instanceof NavdataBusyError) {
      busy(res, err);
      return;
    }
    console.error(`navdata: ${what} failed: ${(err as Error).message}`);
    res.status(500).json({ error: `${what} failed` });
  }
}

function parseKinds(raw: unknown): FeatureKind[] | null {
  if (raw === undefined) return [...FEATURE_KINDS];
  if (typeof raw !== 'string') return null;
  const kinds = raw.split(',').map(k => k.trim()).filter(k => k !== '');
  if (kinds.length === 0 || !kinds.every(k => (FEATURE_KINDS as readonly string[]).includes(k))) return null;
  return kinds as FeatureKind[];
}

/**
 * The browser-facing navdata queries. Mounted behind the session middleware
 * (and requireSameOrigin, which already covers the one POST); none of these
 * accept the ingest token. A missing replica is an empty answer, not an error.
 */
export function createNavdataRouter(sidecarState: SidecarStateStore, onDemandChanged: () => void = () => {}): express.Router {
  const router = express.Router();

  router.get('/navdata/features', (req, res) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) {
      res.status(400).json({ error: 'bbox must be w,s,e,n in degrees' });
      return;
    }
    const zoomRaw = typeof req.query.zoom === 'string' ? req.query.zoom : '';
    const zoom = Number(zoomRaw);
    if (zoomRaw.trim() === '' || !Number.isInteger(zoom) || zoom < 0 || zoom > 20) {
      res.status(400).json({ error: 'zoom must be an integer from 0 to 20' });
      return;
    }
    const kinds = parseKinds(req.query.kinds);
    if (!kinds) {
      res.status(400).json({ error: `kinds must be a comma list of ${FEATURE_KINDS.join(', ')}` });
      return;
    }
    let limit = FEATURES_DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const l = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
      if (!Number.isInteger(l) || l < 1) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      limit = Math.min(l, FEATURES_MAX_LIMIT);
    }
    guarded(res, 'Features query', () => {
      res.json(queryFeatures(getActiveNavDb(), { bbox, zoom, kinds, limit }));
    });
  });

  // Never an error, even mid-swap: the client polls this to decide whether to
  // show the navdata toggles at all.
  router.get('/navdata/status', (_req, res) => {
    const sidecar = sidecarState.read();
    const { selected, effective } = navdataSourceState();
    const src = { source: effective, selectedSource: selected };
    if (isNavdataBusy()) {
      res.json(readStatus(null, sidecar, null, src));
      return;
    }
    try {
      res.json(readStatus(getActiveNavDb(), sidecar, sidecarState.lastRowsAt(), src));
    } catch (err) {
      console.error(`navdata: status failed: ${(err as Error).message}`);
      res.json(readStatus(null, sidecar, null, src));
    }
  });

  router.get('/navdata/airports/:ident', (req, res) => {
    guarded(res, 'Airport detail', () => {
      const detail = readAirportDetail(getActiveNavDb(), req.params.ident);
      if (!detail) {
        res.status(404).json({ error: 'Airport not in navdata index' });
        return;
      }
      res.json(detail);
    });
  });

  router.post('/navdata/request', (req, res) => {
    const parsed = parseRequestBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    guarded(res, 'Navdata request', () => {
      const result = submitRequest(getActiveNavDb(), parsed, { completeDataset: effectiveNavdataSource() === 'lnm' });
      if (result.state === 'queued') onDemandChanged();
      res.json(result);
    });
  });

  return router;
}
