import type { AcarsMessage, CreateAcarsMessage } from '../types';
import type { AcarsHint } from '../eventHub';
import { getDb } from './connection';

// ── ACARS messages ────────────────────────────────────────────────────────────
//
// One table, acars_messages: the datalink thread. A row is scoped by a flight,
// by a planned leg, or by both — the leg scope exists because a clearance or a
// dispatch release arrives before pushback, when no flights row has been
// inserted yet. A row with neither scope is unreachable by every read below and
// is refused here rather than in the schema.
//
// Reads never use SELECT *: the twelve columns are listed in DDL order so a
// column added later cannot silently change a response shape.

const COLUMNS = `
  id, flight_id, planned_leg_id, direction, category, label, body,
  payload_json, correlation_id, dedup_key, sent_at, read_at
`;

// Notified once per newly created row — never for a dedup hit, never for a
// read_at update or a delete. Every writer inserts through this module, so
// this is the only file that needs to know about the event at all.
let acarsInsertListener: ((hint: AcarsHint) => void) | null = null;

export function setAcarsInsertListener(listener: ((hint: AcarsHint) => void) | null): void {
  acarsInsertListener = listener;
}

function notifyAcarsInsert(row: AcarsMessage): void {
  if (!acarsInsertListener) return;
  try {
    acarsInsertListener({ flightId: row.flight_id, plannedLegId: row.planned_leg_id, messageId: row.id });
  } catch (err) {
    console.warn('[db/acarsMessages] insert listener failed:', err);
  }
}

/**
 * Inserts one message and returns the stored row.
 *
 * Defaults: sent_at = now (ISO), and every optional column NULL. Throws when
 * neither flight_id nor planned_leg_id is given.
 *
 * General on purpose: the route layer is only one caller. A server-side writer
 * passes a planned_leg_id, a payload_json and a dedup_key the route never sets.
 */
export function insertAcarsMessage(msg: CreateAcarsMessage): AcarsMessage {
  const flightId = msg.flight_id ?? null;
  const plannedLegId = msg.planned_leg_id ?? null;
  if (flightId === null && plannedLegId === null) {
    throw new Error('An ACARS message needs a flight_id, a planned_leg_id, or both');
  }

  const sentAt = msg.sent_at ?? new Date().toISOString();

  const row = getDb().transaction((): AcarsMessage => {
    const result = getDb().prepare(`
      INSERT INTO acars_messages
        (flight_id, planned_leg_id, direction, category, label, body,
         payload_json, correlation_id, dedup_key, sent_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      flightId, plannedLegId, msg.direction, msg.category, msg.label ?? null, msg.body,
      msg.payload_json ?? null, msg.correlation_id ?? null, msg.dedup_key ?? null, sentAt,
    );

    const inserted = getAcarsMessageById(result.lastInsertRowid as number);
    if (!inserted) throw new Error('ACARS message vanished immediately after insert');
    return inserted;
  })();

  notifyAcarsInsert(row);
  return row;
}

/**
 * Insert-or-return-existing, keyed on dedup_key (required here). created=false
 * means a row with that key was already stored and nothing was written — which
 * is how a re-requested clearance returns the identical clearance, and how a
 * repeated state transition stays exactly one message.
 */
export function insertAcarsMessageOnce(
  msg: CreateAcarsMessage & { dedup_key: string }
): { message: AcarsMessage; created: boolean } {
  const flightId = msg.flight_id ?? null;
  const plannedLegId = msg.planned_leg_id ?? null;
  if (flightId === null && plannedLegId === null) {
    throw new Error('An ACARS message needs a flight_id, a planned_leg_id, or both');
  }
  if (!msg.dedup_key) {
    throw new Error('insertAcarsMessageOnce needs a dedup_key');
  }

  const sentAt = msg.sent_at ?? new Date().toISOString();

  const outcome = getDb().transaction((): { message: AcarsMessage; created: boolean } => {
    // The WHERE on the conflict target is not optional: the unique index is
    // partial, and SQLite requires the target's WHERE to match the index's.
    const result = getDb().prepare(`
      INSERT INTO acars_messages
        (flight_id, planned_leg_id, direction, category, label, body,
         payload_json, correlation_id, dedup_key, sent_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
    `).run(
      flightId, plannedLegId, msg.direction, msg.category, msg.label ?? null, msg.body,
      msg.payload_json ?? null, msg.correlation_id ?? null, msg.dedup_key, sentAt,
    );

    const message = findAcarsMessageByDedupKey(msg.dedup_key);
    if (!message) throw new Error('ACARS message vanished immediately after insert');
    return { message, created: result.changes === 1 };
  })();

  if (outcome.created) notifyAcarsInsert(outcome.message);
  return outcome;
}

/** One row by id, or null. */
export function getAcarsMessageById(id: number): AcarsMessage | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM acars_messages WHERE id = ?`)
    .get(id) as AcarsMessage | undefined;
  return row ?? null;
}

/** One row by dedup_key, or null. A null or empty key returns null unqueried. */
export function findAcarsMessageByDedupKey(dedupKey: string): AcarsMessage | null {
  if (!dedupKey) return null;
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM acars_messages WHERE dedup_key = ?`)
    .get(dedupKey) as AcarsMessage | undefined;
  return row ?? null;
}

/**
 * The flight's thread: its own rows, plus the rows of the planned leg it is
 * linked to, oldest first. Returns [] for a flight that does not exist —
 * existence is the route's 404 to decide, not this function's.
 *
 * The subquery yields NULL for an unlinked flight, and `planned_leg_id = NULL`
 * is never true, so such a flight sees only its own rows.
 */
export function listAcarsMessagesForFlight(flightId: number): AcarsMessage[] {
  return getDb().prepare(`
    SELECT ${COLUMNS}
      FROM acars_messages
     WHERE flight_id = ?
        OR planned_leg_id = (SELECT planned_leg_id FROM flights WHERE id = ?)
     ORDER BY sent_at ASC, id ASC
  `).all(flightId, flightId) as AcarsMessage[];
}

/**
 * Leg-scoped rows only, oldest first — for a pre-flight reader looking at a leg
 * no flight has been created for yet.
 */
export function listAcarsMessagesForPlannedLeg(plannedLegId: number): AcarsMessage[] {
  return getDb().prepare(`
    SELECT ${COLUMNS}
      FROM acars_messages
     WHERE planned_leg_id = ?
     ORDER BY sent_at ASC, id ASC
  `).all(plannedLegId) as AcarsMessage[];
}

// The flight's own planned_leg_id is not read here: getFlightPlannedLegId() in
// ./plannedLegs already answers exactly that question, with the same
// "NULL means no link and also no such flight" semantics, and one copy of a
// one-line SELECT is enough.
