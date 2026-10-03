import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import { checkIngestCredential } from '../auth/ingestAuth';
import type { IngestConfig } from '../config';
import { effectiveNavdataSource, getNavDb, isNavdataBusy, NavdataBusyError } from '../navdata/connection';
import { buildDemand, DemandSkipError, NAVDATA_DEMAND_CAP, parseDemandSkip } from '../navdata/demand';
import { importNavdataSnapshot } from '../navdata/snapshot';
import { parseSidecarStateReport, type SidecarStateStore } from '../navdata/sidecarState';
import { applyIncrementalBatch, NavdataStoreError } from '../navdata/store';
import type { IncrementalBatch, NavdataErrorCode } from '../navdata/wire';
import { uploadNavdataSnapshot } from './uploads';

/** Window inside which an identical consecutive rejection is counted, not logged. */
export const REJECTION_LOG_WINDOW_MS = 60_000;

const LOGGED_MESSAGE_MAX = 240;

/**
 * A JSON parser's own message can quote the text it choked on, which is row
 * content; keep the location and drop the quote, and bound the length.
 */
function loggableMessage(message: string): string {
  const cut = message.replace(/(is not JSON:).*$/s, '$1 (parser detail omitted)');
  return cut.length > LOGGED_MESSAGE_MAX ? `${cut.slice(0, LOGGED_MESSAGE_MAX)}...` : cut;
}

export type RejectionLogger = (route: string, status: number, code: string, message: string) => void;

/**
 * Logs one warn line per rejected sync request: route, status, code and the
 * message, which names structure (table, column, index, limit) and never a row
 * value. A retrying sidecar repeats the same refusal on backoff, so an
 * identical consecutive rejection inside the window is only counted; the next
 * line emitted for it carries the count. A different rejection logs at once.
 */
export function createRejectionLogger(
  now: () => number = Date.now,
  warn: (line: string) => void = line => console.warn(line),
): RejectionLogger {
  let lastKey: string | null = null;
  let lastLoggedAt = 0;
  let suppressed = 0;
  return (route, status, code, rawMessage) => {
    const message = loggableMessage(rawMessage);
    const key = `${route}\n${status}\n${code}\n${message}`;
    const t = now();
    if (key === lastKey && t - lastLoggedAt < REJECTION_LOG_WINDOW_MS) {
      suppressed++;
      return;
    }
    const repeats = key === lastKey && suppressed > 0 ? ` (repeated ${suppressed} times)` : '';
    lastKey = key;
    lastLoggedAt = t;
    suppressed = 0;
    warn(`navdata: ${route} rejected ${status} ${code}: ${message}${repeats}`);
  };
}

function busy(res: Response, retryAfterSeconds: number, message: string, log: RejectionLogger, route: string): void {
  log(route, 503, 'NAVDATA_BUSY', message);
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(503).json({ ok: false, code: 'NAVDATA_BUSY' satisfies NavdataErrorCode, message });
}

function storeError(res: Response, err: NavdataStoreError, log: RejectionLogger, route: string): void {
  log(route, err.status, err.code, err.message);
  res.status(err.status).json({
    ok: false,
    code: err.code,
    message: err.message,
    ...('serverSnapshotId' in err ? { serverSnapshotId: err.serverSnapshotId } : {}),
    ...(err.serverRev !== undefined ? { serverRev: err.serverRev } : {}),
    ...(err.serverSchemaVersion !== undefined ? { serverSchemaVersion: err.serverSchemaVersion } : {}),
  });
}

/**
 * The sidecar's sync endpoints: authenticated by INGEST_TOKEN, mounted above
 * the session middleware so a request never touches the session store. The
 * router answers only its four routes; every other /api/navdata path falls
 * through to the session stack, so the token check is per-route and there is
 * deliberately no router-level middleware here.
 */
export function createNavdataSyncRouter(
  ingestConfig: IngestConfig,
  sidecarState: SidecarStateStore,
  now: () => number = Date.now,
  onDemandChanged: () => void = () => {},
): express.Router {
  const router = express.Router();
  let importing = false;
  const log = createRejectionLogger(now);

  const requireToken = (req: Request, res: Response, next: NextFunction): void => {
    if (checkIngestCredential(ingestConfig, req.get('x-ingest-token')) !== 'invalid') {
      next();
      return;
    }
    log(req.path, 401, 'UNAUTHORIZED', 'Invalid or missing ingest token');
    res.status(401).json({ error: 'Invalid or missing ingest token' });
  };

  // A batch applied to the outgoing replica while a snapshot is importing would
  // be lost when the swap lands, after the sidecar may already have counted it
  // as delivered. So the whole import, from the first byte of the upload to the
  // end of the swap, holds the replica against batches and other snapshots.
  const beginImport = (_req: Request, res: Response, next: NextFunction): void => {
    if (isNavdataBusy() || importing) {
      busy(res, 2, 'navdata replica is being replaced', log, '/snapshot');
      return;
    }
    importing = true;
    // The upload can fail before the handler runs (size limit, bad multipart);
    // the handler owns the release once it has started.
    res.once('close', () => {
      if (!res.locals.importHandlerStarted) importing = false;
    });
    next();
  };

  router.post(
    '/snapshot',
    requireToken,
    beginImport,
    uploadNavdataSnapshot.single('navdataSnapshot'),
    async (req, res) => {
      res.locals.importHandlerStarted = true;
      const file = req.file;
      try {
        if (!file) {
          log('/snapshot', 400, 'NAVDATA_BAD_BATCH', 'No navdataSnapshot file in the upload');
          res.status(400).json({ ok: false, code: 'NAVDATA_BAD_BATCH', message: 'No navdataSnapshot file in the upload' });
          return;
        }
        const result = await importNavdataSnapshot(file.path);
        onDemandChanged();
        res.json(result);
      } catch (err) {
        if (err instanceof NavdataStoreError) {
          storeError(res, err, log, '/snapshot');
        } else if (err instanceof NavdataBusyError) {
          busy(res, err.retryAfterSeconds, err.message, log, '/snapshot');
        } else {
          console.error(`navdata: snapshot import failed: ${(err as Error).message}`);
          res.status(500).json({ error: 'Snapshot import failed' });
        }
      } finally {
        importing = false;
        if (file) fs.rm(file.path, { force: true }, () => undefined);
      }
    },
  );

  router.post('/rows', requireToken, (req, res) => {
    if (isNavdataBusy() || importing) {
      busy(res, 2, 'navdata replica is being replaced', log, '/rows');
      return;
    }
    try {
      const ack = applyIncrementalBatch(getNavDb(), req.body as IncrementalBatch);
      sidecarState.markRowsApplied();
      onDemandChanged();
      res.json(ack);
    } catch (err) {
      if (err instanceof NavdataStoreError) {
        storeError(res, err, log, '/rows');
      } else if (err instanceof NavdataBusyError) {
        busy(res, err.retryAfterSeconds, err.message, log, '/rows');
      } else {
        console.error(`navdata: batch failed: ${(err as Error).message}`);
        res.status(500).json({ error: 'Batch failed' });
      }
    }
  });

  router.get('/demand', requireToken, (req, res) => {
    if (isNavdataBusy()) {
      busy(res, 2, 'navdata replica is being replaced', log, '/demand');
      return;
    }
    try {
      const skip = parseDemandSkip(req.query);
      // The Little Navmap dataset is complete, so there is nothing to harvest:
      // answer an empty want list and leave the queued requests alone (they are
      // neither pruned nor deleted) for when the simulator replica is shown again.
      if (effectiveNavdataSource() === 'lnm') {
        res.json({ v: 1, airports: [], waypoints: [], cap: NAVDATA_DEMAND_CAP, more: false, generatedAt: Date.now() });
        return;
      }
      res.json(buildDemand(new Date(), skip));
    } catch (err) {
      if (err instanceof DemandSkipError) {
        log('/demand', 400, 'NAVDATA_BAD_BATCH', err.message);
        res.status(400).json({ ok: false, code: 'NAVDATA_BAD_BATCH' satisfies NavdataErrorCode, message: err.message });
        return;
      }
      if (err instanceof NavdataBusyError) {
        busy(res, err.retryAfterSeconds, err.message, log, '/demand');
        return;
      }
      console.error(`navdata: demand failed: ${(err as Error).message}`);
      res.status(500).json({ error: 'Demand failed' });
    }
  });

  // Fire-and-forget: the sidecar never retries, so nothing here may throw.
  router.post('/state', requireToken, (req, res) => {
    try {
      const report = parseSidecarStateReport(req.body);
      if (!report) {
        log('/state', 400, 'NAVDATA_BAD_BATCH', 'Not a sidecar state report');
        res.status(400).json({ ok: false, code: 'NAVDATA_BAD_BATCH', message: 'Not a sidecar state report' });
        return;
      }
      sidecarState.report(report);
      res.status(204).end();
    } catch (err) {
      console.error(`navdata: state report failed: ${(err as Error).message}`);
      res.status(204).end();
    }
  });

  return router;
}
