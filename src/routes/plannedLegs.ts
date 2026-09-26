import express, { Router } from 'express';
import { createHash } from 'crypto';
import { getFlightById } from '../db/flights';
import { getTripById } from '../db/trips';
import {
  createPlannedLeg, getPlannedLegsForTrip, getPlannedLegById, findPlannedLegBySource, getAllPlannedLegs,
  deletePlannedLeg, reorderPlannedLegs, setPlannedLegStatus, setPlannedLegHandOutcome, movePlannedLeg,
  linkFlightToPlannedLeg, unlinkFlightFromPlannedLeg,
  PlannedLegAlreadyLinkedError, PlannedLegHasLinkedFlightError, PlannedLegHandCloseConflictError, PlannedLegMoveError,
  type PlannedLegMoveRefusal,
} from '../db/plannedLegs';
import { getSetting } from '../db/settings';
import { decideHandClose } from '../plannedLegClose';
import { parseLnmpln, LnmplnParseError, chainOrderForBatch, type ParsedFlightPlan } from '../lnmpln';
import {
  SIMBRIEF_USER_ID_SETTING, parseSimbriefPlan, SimbriefParseError,
  type ParsedSimbriefPlan,
} from '../simbrief';
import { fetchSimbriefPlan, SimbriefFetchError, type SimbriefErrorCode } from '../simbriefClient';
import { uploadLnmpln, MAX_LNMPLN_FILES } from './uploads';
import { insertAcarsMessageOnce } from '../db/acarsMessages';
import { DISPATCH_RELEASE_LABEL, buildDispatchPayload, buildDispatchReleaseBody, dispatchDedupKey } from '../acars';
import { importSimbriefLooseLeg } from '../simbriefImport';
import type { FlightManager } from '../flightManager';
import type { PlannedLegWithChildren } from '../types';

/**
 * Content sniffing for an uploaded .lnmpln: after BOM stripping and
 * trimStart(), the bytes must begin with '<'. The extension is not trusted and
 * not required. Mirrors the parser's own BOM handling so a file that passes
 * here is never rejected by the parser for the same reason.
 */
function looksLikeXml(buf: Buffer): boolean {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.trimStart().startsWith('<');
}

/**
 * How a failed SimBrief request is reported. 502/504 rather than 500 because
 * the failure is upstream, and the distinction is what makes the log usable
 * when the operator reports "the import is broken".
 */
const SIMBRIEF_FAILURE_STATUS: Record<SimbriefErrorCode, number> = {
  UNKNOWN_USER: 400,
  NO_PLAN: 404,
  TIMEOUT: 504,
  NETWORK: 502,
  BAD_STATUS: 502,
  BAD_BODY: 502,
};

/**
 * The planned-leg routes — the .lnmpln and SimBrief imports, the per-trip list
 * and reorder, the per-leg reads and edits, and the flight <-> planned-leg link
 * — mounted at '/api' by src/server.ts, behind requireAuth and
 * requireSameOrigin, and before the SPA catch-all.
 *
 * The multer error path runs through the app-level error handler in
 * src/server.ts rather than one here: uploadLnmpln's MulterError unwinds out of
 * this router, and the handler keys off err.field to tell an oversized .lnmpln
 * from an oversized PDF.
 *
 * flightManager is a parameter for the same reason as in ./flights: one
 * instance per process, handed in rather than reached for.
 */
export function createPlannedLegsRouter(flightManager: FlightManager, onChanged: () => void = () => {}): Router {
  const router = express.Router();

  router.post('/trips/:id/planned-legs', uploadLnmpln.array('lnmpln', MAX_LNMPLN_FILES), (req, res) => {
    const tripId = parseInt(req.params.id, 10);
    if (isNaN(tripId)) { res.status(400).json({ error: 'Invalid trip id' }); return; }
    if (!getTripById(tripId)) { res.status(404).json({ error: 'Trip not found' }); return; }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'No files uploaded' }); return; }

    const allowDuplicates = (req.body as Record<string, unknown> | undefined)?.allow_duplicates === '1';

    interface FileOutcome {
      filename: string;
      status: 'imported' | 'duplicate' | 'rejected';
      planned_leg_id?: number;
      warnings?: { code: string; message: string }[];
      error?: string;
    }

    const results: FileOutcome[] = [];
    // Only successfully-parsed, non-duplicate files participate in chain-sort
    // and get inserted; in upload order until chainOrderForBatch reorders them.
    const toInsert: { filename: string; sha256: string; plan: ParsedFlightPlan; resultIndex: number }[] = [];
    // F-1: findPlannedLegBySource only sees rows already committed, and every
    // insert in this handler happens after this whole scan loop — so without
    // this, the same file twice in one request sailed past the DB check both
    // times and came out as two legs. Tracks the resultIndex of the first
    // (non-duplicate) occurrence of each hash so a repeat within the batch is
    // caught before it ever reaches toInsert.
    const seenInBatch = new Map<string, number>();
    // resultIndex (duplicate) -> resultIndex (the in-batch original) so the
    // duplicate's planned_leg_id can be backfilled once the original is
    // actually inserted below, the same as the cross-request case reports one.
    const duplicateOfInBatch = new Map<number, number>();

    for (const file of files) {
      const filename = file.originalname;

      if (!looksLikeXml(file.buffer)) {
        results.push({ filename, status: 'rejected', error: "NOT_XML: file does not begin with '<'" });
        continue;
      }

      let plan: ParsedFlightPlan;
      try {
        plan = parseLnmpln(file.buffer);
      } catch (err) {
        if (err instanceof LnmplnParseError) {
          results.push({ filename, status: 'rejected', error: `${err.code}: ${err.message}` });
          continue;
        }
        res.status(500).json({ error: String(err) });
        return;
      }

      const sha256 = createHash('sha256').update(file.buffer).digest('hex');

      if (!allowDuplicates) {
        const existing = findPlannedLegBySource(tripId, sha256);
        if (existing) {
          results.push({
            filename, status: 'duplicate', planned_leg_id: existing.id,
            error: `Already imported into this trip as leg ${existing.seq}`,
          });
          continue;
        }

        const dupOf = seenInBatch.get(sha256);
        if (dupOf !== undefined) {
          results.push({
            filename, status: 'duplicate',
            error: `Duplicate of "${results[dupOf].filename}" earlier in this upload`,
          });
          duplicateOfInBatch.set(results.length - 1, dupOf);
          continue;
        }
      }

      // F-2: a warning means the parser tolerated something worth a human's
      // attention — log it at import time, since nothing downstream of a
      // successful import currently does.
      for (const w of plan.warnings) {
        console.warn(`[LNMPLN] ${filename}: ${w.code}: ${w.message}`);
      }

      results.push({ filename, status: 'imported', warnings: plan.warnings });
      seenInBatch.set(sha256, results.length - 1);
      toInsert.push({ filename, sha256, plan, resultIndex: results.length - 1 });
    }

    const order = chainOrderForBatch(toInsert.map((t) => t.plan));

    const imported: PlannedLegWithChildren[] = [];
    try {
      for (const idx of order.order) {
        const entry = toInsert[idx];
        const legId = createPlannedLeg({
          tripId, plan: entry.plan, sourceFilename: entry.filename, sourceSha256: entry.sha256,
        });
        results[entry.resultIndex].planned_leg_id = legId;
        imported.push(getPlannedLegById(legId)!);
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }

    for (const [dupIdx, origIdx] of duplicateOfInBatch) {
      results[dupIdx].planned_leg_id = results[origIdx].planned_leg_id;
    }

    if (imported.length === 0) {
      // F-3: chainOrderForBatch([]) reports SINGLE_LEG, which is meaningless
      // for a batch that inserted nothing — omit it rather than log a chain
      // verdict for zero legs. The client only branches on batch.ordering,
      // and only when it's present, so this is safe on that side too.
      res.status(400).json({ imported, results });
      return;
    }
    const batch = { ordering: (order.resolved ? 'chain' : 'upload') as 'chain' | 'upload', reason: order.reason };
    onChanged();
    res.status(201).json({ imported, batch, results });
  });

  // A copy of the trip-nested route above with the trip lookup removed: same
  // upload middleware and field name, same XML sniff, parse, sha256, in-batch
  // duplicate tracking, chain sort, insert loop and response shape — a loose
  // prefile belongs to no trip, so there is no :id to validate or 404 on.
  router.post('/planned-legs', uploadLnmpln.array('lnmpln', MAX_LNMPLN_FILES), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'No files uploaded' }); return; }

    const allowDuplicates = (req.body as Record<string, unknown> | undefined)?.allow_duplicates === '1';

    interface FileOutcome {
      filename: string;
      status: 'imported' | 'duplicate' | 'rejected';
      planned_leg_id?: number;
      warnings?: { code: string; message: string }[];
      error?: string;
    }

    const results: FileOutcome[] = [];
    const toInsert: { filename: string; sha256: string; plan: ParsedFlightPlan; resultIndex: number }[] = [];
    const seenInBatch = new Map<string, number>();
    const duplicateOfInBatch = new Map<number, number>();

    for (const file of files) {
      const filename = file.originalname;

      if (!looksLikeXml(file.buffer)) {
        results.push({ filename, status: 'rejected', error: "NOT_XML: file does not begin with '<'" });
        continue;
      }

      let plan: ParsedFlightPlan;
      try {
        plan = parseLnmpln(file.buffer);
      } catch (err) {
        if (err instanceof LnmplnParseError) {
          results.push({ filename, status: 'rejected', error: `${err.code}: ${err.message}` });
          continue;
        }
        res.status(500).json({ error: String(err) });
        return;
      }

      const sha256 = createHash('sha256').update(file.buffer).digest('hex');

      if (!allowDuplicates) {
        const existing = findPlannedLegBySource(null, sha256);
        if (existing) {
          results.push({
            filename, status: 'duplicate', planned_leg_id: existing.id,
            error: `Already imported without a trip as leg ${existing.seq}`,
          });
          continue;
        }

        const dupOf = seenInBatch.get(sha256);
        if (dupOf !== undefined) {
          results.push({
            filename, status: 'duplicate',
            error: `Duplicate of "${results[dupOf].filename}" earlier in this upload`,
          });
          duplicateOfInBatch.set(results.length - 1, dupOf);
          continue;
        }
      }

      for (const w of plan.warnings) {
        console.warn(`[LNMPLN] ${filename}: ${w.code}: ${w.message}`);
      }

      results.push({ filename, status: 'imported', warnings: plan.warnings });
      seenInBatch.set(sha256, results.length - 1);
      toInsert.push({ filename, sha256, plan, resultIndex: results.length - 1 });
    }

    const order = chainOrderForBatch(toInsert.map((t) => t.plan));

    const imported: PlannedLegWithChildren[] = [];
    try {
      for (const idx of order.order) {
        const entry = toInsert[idx];
        const legId = createPlannedLeg({
          tripId: null, plan: entry.plan, sourceFilename: entry.filename, sourceSha256: entry.sha256,
        });
        results[entry.resultIndex].planned_leg_id = legId;
        imported.push(getPlannedLegById(legId)!);
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }

    for (const [dupIdx, origIdx] of duplicateOfInBatch) {
      results[dupIdx].planned_leg_id = results[origIdx].planned_leg_id;
    }

    if (imported.length === 0) {
      res.status(400).json({ imported, results });
      return;
    }
    const batch = { ordering: (order.resolved ? 'chain' : 'upload') as 'chain' | 'upload', reason: order.reason };
    onChanged();
    res.status(201).json({ imported, batch, results });
  });

  // A sibling of the .lnmpln import above, not an extension of it: one request
  // to SimBrief is one plan, so this route takes a JSON body and answers with a
  // single `result` object rather than a `results` array a caller might assume
  // can be empty. The extra path segment means it never collides with the route
  // above, and it is registered here — like every literal route in this router,
  // which is mounted ahead of the SPA catch-all rather than after it.
  //
  // The step order is the contract, not an implementation detail: the trip
  // lookup, the settings read, the network call, the parse and the duplicate
  // check all happen before createPlannedLeg, which is the first and only
  // write and is itself a transaction. Every failure below therefore returns
  // with the trip's existing planned legs untouched, byte for byte. Do not
  // move `createPlannedLeg` earlier, and do not add a second write to
  // `planned_legs`. The ACARS dispatch release written after it is the one
  // permitted extra write: it targets a different table, it runs only after
  // the leg is committed, and its own try/catch keeps a message failure from
  // changing this route's response.
  router.post('/trips/:id/planned-legs/simbrief', async (req, res) => {
    const tripId = parseInt(req.params.id, 10);
    if (isNaN(tripId)) { res.status(400).json({ error: 'Invalid trip id', code: 'INVALID_TRIP' }); return; }
    if (!getTripById(tripId)) { res.status(404).json({ error: 'Trip not found', code: 'NOT_FOUND' }); return; }

    // A JSON boolean, unlike the .lnmpln route's `=== '1'` — that string check
    // is a multipart form-field artifact and stays where it is.
    const allowDuplicates = (req.body as Record<string, unknown> | undefined)?.allow_duplicates === true;

    // The pilot ID is never taken from the request: it is the operator's saved
    // setting, so an authenticated page cannot use this route to pull an
    // arbitrary third party's flight plan.
    const userId = getSetting(SIMBRIEF_USER_ID_SETTING);
    if (userId === null) {
      console.error(`[SIMBRIEF] import failed: NO_USER_ID (trip ${tripId})`);
      res.status(400).json({
        error: 'No SimBrief User ID is saved. Enter your SimBrief Pilot ID above and save it, then try again.',
        code: 'NO_USER_ID',
      });
      return;
    }

    let plan: ParsedSimbriefPlan;
    try {
      plan = parseSimbriefPlan(await fetchSimbriefPlan(userId));
    } catch (err) {
      if (err instanceof SimbriefFetchError) {
        console.error(`[SIMBRIEF] import failed: ${err.message}`);
        res.status(SIMBRIEF_FAILURE_STATUS[err.code]).json({ error: err.userMessage, code: err.code });
        return;
      }
      if (err instanceof SimbriefParseError) {
        // The request succeeded and SimBrief said Success; the payload just had
        // no usable route in it. Still upstream's doing, so 502 and not 500.
        console.error(`[SIMBRIEF] import failed: BAD_BODY (${err.code}: ${err.message})`);
        res.status(502).json({ error: 'SimBrief returned a plan with no usable route.', code: 'BAD_BODY' });
        return;
      }
      console.error(`[SIMBRIEF] import failed: INTERNAL (${String(err)})`);
      res.status(500).json({ error: String(err) });
      return;
    }

    const label = `${plan.departure.ident} → ${plan.destination.ident}${plan.ofp.flightNumber ? ` (${plan.ofp.flightNumber})` : ''}`;
    const ofpId = plan.ofp.requestId ?? 'unknown';
    // NOT the hash of the response body, which the .lnmpln path uses on file
    // bytes: two requests for the same unchanged OFP come back differing in
    // SimBrief's own server-timing field, so a body hash would never match and
    // every re-import would land as a new leg. These three fields identify the
    // OFP itself and are stable across requests, while a newly generated OFP
    // changes them.
    const sha256 = createHash('sha256')
      .update(`simbrief\n${plan.ofp.requestId ?? ''}\n${plan.ofp.sequenceId ?? ''}\n${plan.ofp.timeGenerated ?? ''}`)
      .digest('hex');

    if (!allowDuplicates) {
      const existing = findPlannedLegBySource(tripId, sha256);
      if (existing) {
        // 200, not 4xx: nothing failed and nothing changed.
        console.log(`[SIMBRIEF] import duplicate: trip ${tripId} leg ${existing.id} ${plan.departure.ident}->${plan.destination.ident} ofp ${ofpId}`);
        onChanged();
        res.json({
          imported: [],
          result: {
            status: 'duplicate', planned_leg_id: existing.id, label, warnings: [],
            error: `This SimBrief plan is already imported into this trip as leg ${existing.seq}. Generate a new OFP on simbrief.com, or re-import to add it again.`,
          },
        });
        return;
      }
    }

    try {
      const legId = createPlannedLeg({
        tripId, plan, sourceFilename: `simbrief-${ofpId}.json`, sourceSha256: sha256,
      });
      console.log(
        `[SIMBRIEF] import ok: trip ${tripId} leg ${legId} ${plan.departure.ident}->${plan.destination.ident} ` +
        `${plan.waypoints.length} wpts ${plan.approxDistanceNm.toFixed(1)}nm ofp ${ofpId}`,
      );

      // Files the dispatch release into the new leg's ACARS thread. Its own
      // try/catch, and deliberately so: the leg is already committed by the
      // time this runs, so a failure here must not turn a successful import
      // into an error response — the user's leg exists either way, and a
      // missing message is recoverable while a 500 on a committed insert is
      // not. The key is the leg id, so running this twice for one leg is a
      // no-op rather than a second release.
      try {
        const issuedAt = new Date().toISOString();
        const payload = buildDispatchPayload(plan);
        insertAcarsMessageOnce({
          planned_leg_id: legId,
          direction: 'uplink',
          category: 'dispatch',
          label: DISPATCH_RELEASE_LABEL,
          body: buildDispatchReleaseBody(payload, issuedAt),
          payload_json: JSON.stringify(payload),
          dedup_key: dispatchDedupKey(legId),
          sent_at: issuedAt,
        });
      } catch (err) {
        console.error(`[SIMBRIEF] dispatch release not filed: leg ${legId} ofp ${ofpId} (${String(err)})`);
      }

      onChanged();
      res.status(201).json({
        imported: [getPlannedLegById(legId)!],
        result: { status: 'imported', planned_leg_id: legId, label, warnings: plan.warnings },
      });
    } catch (err) {
      console.error(`[SIMBRIEF] import failed: DB_ERROR (trip ${tripId}, ofp ${ofpId}, ${String(err)})`);
      res.status(500).json({ error: String(err), code: 'DB_ERROR' });
    }
  });

  // A thin adapter over src/simbriefImport.ts's importSimbriefLooseLeg(),
  // which holds the actual settings-read / fetch / parse / duplicate-check /
  // create / dispatch-release sequence — shared with the import_simbrief_leg
  // MCP tool so that sequence, its dedup hash and its dedup key exist in
  // exactly one place.
  router.post('/planned-legs/simbrief', async (req, res) => {
    const allowDuplicates = (req.body as Record<string, unknown> | undefined)?.allow_duplicates === true;
    const outcome = await importSimbriefLooseLeg({ allowDuplicates });
    if (outcome.kind !== 'error') onChanged();
    res.status(outcome.status).json(outcome.body);
  });

  router.get('/trips/:id/planned-legs', (req, res) => {
    const tripId = parseInt(req.params.id, 10);
    if (isNaN(tripId)) { res.status(400).json({ error: 'Invalid trip id' }); return; }
    if (!getTripById(tripId)) { res.status(404).json({ error: 'Trip not found' }); return; }
    try {
      res.json(getPlannedLegsForTrip(tripId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Unified listing for the Prefiles page and for every picker that would
  // otherwise fan out over GET /trips/:id/planned-legs per trip. No query
  // parameters — filtering is the client's job. Empty array when there are no
  // legs at all, never 404.
  router.get('/planned-legs', (req, res) => {
    try {
      res.json(getAllPlannedLegs());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch('/trips/:id/planned-legs/order', (req, res) => {
    const tripId = parseInt(req.params.id, 10);
    if (isNaN(tripId)) { res.status(400).json({ error: 'Invalid trip id' }); return; }
    if (!getTripById(tripId)) { res.status(404).json({ error: 'Trip not found' }); return; }

    const { legIds } = req.body as { legIds?: unknown };
    if (!Array.isArray(legIds) || !legIds.every((x) => Number.isInteger(x))) {
      res.status(400).json({ error: 'legIds must be an array of integers' }); return;
    }

    const existingIds = getPlannedLegsForTrip(tripId).map((l) => l.id).sort((a, b) => a - b);
    const providedIds = [...(legIds as number[])].sort((a, b) => a - b);
    const sameMultiset = existingIds.length === providedIds.length
      && existingIds.every((id, i) => id === providedIds[i]);
    if (!sameMultiset) {
      res.status(400).json({ error: 'legIds must list every planned leg of this trip exactly once' });
      return;
    }

    reorderPlannedLegs(tripId, legIds as number[]);
    onChanged();
    res.json(getPlannedLegsForTrip(tripId));
  });

  router.get('/planned-legs/:legId', (req, res) => {
    const legId = parseInt(req.params.legId, 10);
    if (isNaN(legId)) { res.status(400).json({ error: 'Invalid id' }); return; }
    const leg = getPlannedLegById(legId);
    if (!leg) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(leg);
  });

  router.delete('/planned-legs/:legId', (req, res) => {
    const legId = parseInt(req.params.legId, 10);
    if (isNaN(legId)) { res.status(400).json({ error: 'Invalid id' }); return; }
    const deleted = deletePlannedLeg(legId);
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return; }
    const inProgressFlightId = flightManager.appState.currentFlightId;
    if (inProgressFlightId !== null) {
      try {
        flightManager.refreshPlannedLegForFlight(inProgressFlightId);
      } catch (err) {
        console.warn('[Routes] leg cache refresh after delete failed:', err);
      }
    }
    onChanged();
    res.json({ deleted: true });
  });

  router.patch('/planned-legs/:legId', (req, res) => {
    const legId = parseInt(req.params.legId, 10);
    if (isNaN(legId)) { res.status(400).json({ error: 'Invalid id' }); return; }

    // 'flown' and 'diverted' are set by the system only — by landing within
    // ARRIVAL_RADIUS_NM of the planned destination — so a client asking for
    // either is a 400, not a state a PATCH can request.
    const { status } = req.body as { status?: unknown };
    if (status !== 'planned' && status !== 'skipped') {
      res.status(400).json({ error: "status must be 'planned' or 'skipped'" }); return;
    }

    if (!getPlannedLegById(legId)) { res.status(404).json({ error: 'Not found' }); return; }

    try {
      setPlannedLegStatus(legId, status);
      onChanged();
      res.json(getPlannedLegById(legId));
    } catch (err) {
      if (err instanceof PlannedLegHasLinkedFlightError) {
        res.status(409).json({ error: err.message }); return;
      }
      res.status(500).json({ error: String(err) });
    }
  });

  // Status a thrown PlannedLegMoveError maps to. Kept next to the route since
  // nothing else needs the mapping — src/db/plannedLegs.ts only needs the code.
  const MOVE_REFUSAL_STATUS: Record<PlannedLegMoveRefusal, number> = {
    TRIP_NOT_FOUND: 404,
    SAME_POOL: 400,
    LINKED_FLIGHT: 409,
    NOT_MOVABLE_STATUS: 409,
    DUPLICATE_IN_TARGET: 409,
  };

  // Moves a leg into a different trip, or out to the loose pool (tripId
  // null) — a sibling of PATCH /planned-legs/:legId, not an extension of it:
  // that route only ever writes `status`, and this one only ever writes
  // trip_id/seq, deliberately kept as two separate endpoints.
  router.put('/planned-legs/:legId/trip', (req, res) => {
    const legId = parseInt(req.params.legId, 10);
    if (isNaN(legId)) { res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' }); return; }

    const { tripId } = req.body as { tripId?: unknown };
    if (tripId !== null && !Number.isInteger(tripId)) {
      res.status(400).json({ error: 'tripId must be an integer or null', code: 'INVALID_TRIP_ID' }); return;
    }

    if (!getPlannedLegById(legId)) { res.status(404).json({ error: 'Planned leg not found', code: 'LEG_NOT_FOUND' }); return; }
    if (tripId !== null && !getTripById(tripId as number)) {
      res.status(404).json({ error: 'Trip not found', code: 'TRIP_NOT_FOUND' }); return;
    }

    try {
      const moved = movePlannedLeg(legId, tripId as number | null);
      if (!moved) { res.status(404).json({ error: 'Planned leg not found', code: 'LEG_NOT_FOUND' }); return; }

      // The move already committed by this point — everything below is
      // cache upkeep, not part of the request's success/failure, so a
      // throwing getter or refresh here must still answer 200 and still fire
      // onChanged(), the same as DELETE /planned-legs/:legId's own refresh.
      const inProgressFlightId = flightManager.appState.currentFlightId;
      if (inProgressFlightId !== null) {
        try {
          flightManager.refreshPlannedLegForFlight(inProgressFlightId);
        } catch (refreshErr) {
          console.warn('[Routes] leg cache refresh after move failed:', refreshErr);
        }
      }
      try {
        if (flightManager.getGroundSessionStatus()?.plannedLegId === legId) {
          flightManager.refreshGroundSession();
        }
      } catch (refreshErr) {
        console.warn('[Routes] leg cache refresh after move failed:', refreshErr);
      }
    } catch (err) {
      if (err instanceof PlannedLegMoveError) {
        res.status(MOVE_REFUSAL_STATUS[err.code]).json({ error: err.message, code: err.code }); return;
      }
      res.status(500).json({ error: String(err) }); return;
    }

    onChanged();
    res.json(getPlannedLegById(legId));
  });

  // ── Flight ↔ planned-leg link ─────────────────────────────────────────────
  // Deliberately NOT restricted to the active trip: any unflown planned leg of
  // ANY trip can be linked by hand, since this is the escape hatch for a bad
  // (or missing) auto-match and must not be constrained by the mechanism it
  // exists to correct.

  router.put('/flights/:id/planned-leg', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    if (!getFlightById(id)) { res.status(404).json({ error: 'Flight not found' }); return; }

    const { plannedLegId } = req.body as { plannedLegId?: unknown };
    if (plannedLegId !== null && !Number.isInteger(plannedLegId)) {
      res.status(400).json({ error: 'plannedLegId must be an integer or null' }); return;
    }
    if (plannedLegId !== null && !getPlannedLegById(plannedLegId as number)) {
      res.status(404).json({ error: 'Planned leg not found' }); return;
    }

    try {
      if (plannedLegId === null) {
        // Idempotent, symmetric with PUT /api/active-trip: unlinking a flight
        // that has no link is a no-op, not a 404 — there is nothing wrong
        // with the request, the flight is already in the state it asked for.
        unlinkFlightFromPlannedLeg(id);
      } else {
        linkFlightToPlannedLeg(id, plannedLegId as number, 'manual');
      }
      // A manual link/unlink bypasses FlightManager entirely, so its live-status
      // cache would otherwise keep whatever autoLinkPlannedLeg last set for
      // this flight. A no-op unless `id` is the flight in progress.
      flightManager.refreshPlannedLegForFlight(id);
      onChanged();
      res.json(getFlightById(id));
    } catch (err) {
      if (err instanceof PlannedLegAlreadyLinkedError) {
        res.status(409).json({ error: err.message }); return;
      }
      res.status(500).json({ error: String(err) });
    }
  });

  // Close a hand-linked leg by hand — or reopen it. The one transition
  // endFlight()'s touchdown rule can never reach, because the leg was linked
  // after the flight had already landed. Flight-scoped rather than a widened
  // PATCH /api/planned-legs/:legId: three of the four columns the gate reads
  // live on `flights`, and this way that PATCH — including F-1's 409 on every
  // linked leg — is left literally unchanged.
  //
  // This handler is the whole gate: decideHandClose() refuses here everything
  // the client merely hides. Deliberately no flightManager.refreshPlannedLegForFlight()
  // — the gate demands end_time IS NOT NULL, so the flight is never the one in
  // progress and the call could only ever be a no-op.
  router.put('/flights/:id/planned-leg-status', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

    // Checked before the flight 404, matching PATCH /api/planned-legs/:legId: a
    // malformed body is a 400 whether or not the flight exists. 'diverted' and
    // 'skipped' are not settable here in either direction.
    const { status } = req.body as { status?: unknown };
    if (status !== 'flown' && status !== 'planned') {
      res.status(400).json({ error: "status must be 'flown' or 'planned'" }); return;
    }

    const flight = getFlightById(id);
    if (!flight) { res.status(404).json({ error: 'Flight not found' }); return; }

    // planned_leg_id set with the row gone is unreachable (the FK is
    // ON DELETE SET NULL) but is a genuinely missing named resource, so it is a
    // 404 here rather than one of the gate's 409s.
    const leg = flight.planned_leg_id == null ? null : getPlannedLegById(flight.planned_leg_id);
    if (flight.planned_leg_id != null && !leg) {
      res.status(404).json({ error: 'Planned leg not found' }); return;
    }

    const decision = decideHandClose(status, flight, leg);
    if (!decision.allowed) { res.status(409).json({ error: decision.message }); return; }

    try {
      // The writer re-asserts linked/manual/ended inside its transaction, so a
      // concurrent unlink between the decision above and the UPDATE throws
      // rather than writing.
      const updated = setPlannedLegHandOutcome(decision.legId, decision.status, decision.deviationNm);
      if (!updated) { res.status(404).json({ error: 'Planned leg not found' }); return; }

      const saved = getPlannedLegById(decision.legId);

      // The automatic path announces itself (flightManager.ts:465, "leg #7
      // marked diverted"); without this line a leg that reads 'flown' with a
      // deviation and no matching log would be unexplainable after the fact —
      // the one asymmetry between the two ways a leg reaches 'flown'.
      console.log(
        decision.status === 'flown'
          ? `[PlannedLeg] Flight #${id} hand-marked flown ` +
            `${decision.deviationNm === null ? '(arrival position unknown)' : `${decision.deviationNm} nm`} ` +
            `from planned ${saved?.destination_ident ?? '—'} — leg #${decision.legId}`
          : `[PlannedLeg] Flight #${id} hand-reopened — leg #${decision.legId} back to planned`
      );

      onChanged();
      res.json(saved);
    } catch (err) {
      if (err instanceof PlannedLegHandCloseConflictError) {
        res.status(409).json({ error: err.message }); return;
      }
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
