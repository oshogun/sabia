import express from 'express';
import { getPlannedLegById } from '../db/plannedLegs';
import { getActiveNavDb, NavdataBusyError } from '../navdata/connection';
import { buildRouteGeometry } from '../navdata/routeGeometry';

/**
 * GET /api/planned-legs/:legId/route-geometry. Browser-session route, mounted
 * by the server behind the session middleware. A missing replica is a 200
 * with every chain empty, never an error.
 */
export function createRouteGeometryRouter(): express.Router {
  const router = express.Router();

  router.get('/planned-legs/:legId/route-geometry', (req, res) => {
    const legId = Number(req.params.legId);
    if (!Number.isInteger(legId) || legId <= 0) {
      res.status(400).json({ error: 'Invalid planned leg id' });
      return;
    }
    const leg = getPlannedLegById(legId);
    if (!leg) {
      res.status(404).json({ error: 'Planned leg not found' });
      return;
    }
    try {
      // No await between getActiveNavDb() and the last query on the handle.
      res.json(buildRouteGeometry(leg, getActiveNavDb()));
    } catch (err) {
      if (err instanceof NavdataBusyError) {
        res.set('Retry-After', String(err.retryAfterSeconds));
        res.status(503).json({ ok: false, code: 'NAVDATA_BUSY', message: err.message });
        return;
      }
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
