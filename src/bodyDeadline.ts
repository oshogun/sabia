// ── Per-request body deadline ────────────────────────────────────────────────
//
// index.ts creates the server with requestTimeout 0, because Node's single
// server-wide request timeout would also bound the one request that legitimately
// takes an hour: the Little Navmap database upload. Without it, every request
// would get no limit on how long its body may take. This module puts the limit
// back per request: a request whose body has not fully arrived after
// BODY_DEADLINE_MS loses its connection, and the upload route extends its own
// request, after authentication, to an hour.

import type { IncomingMessage, ServerResponse } from 'http';

/** The deadline every request gets: Node's own default request timeout. */
export const BODY_DEADLINE_MS = 300_000;

const timers = new WeakMap<IncomingMessage, NodeJS.Timeout>();

function startTimer(req: IncomingMessage, ms: number): void {
  const timer = setTimeout(() => {
    // The deadline only applies to a request whose body is still arriving.
    if (!req.complete) req.socket.destroy();
  }, ms);
  // A pending deadline must not keep the process alive at shutdown.
  timer.unref();
  timers.set(req, timer);
}

function clearTimer(req: IncomingMessage): void {
  const timer = timers.get(req);
  if (timer) clearTimeout(timer);
  timers.delete(req);
}

/** Registered with server.prependListener('request', ...), so it runs before any Express middleware. */
export function armBodyDeadline(req: IncomingMessage, res: ServerResponse): void {
  startTimer(req, BODY_DEADLINE_MS);
  req.once('end', () => clearTimer(req));
  res.once('close', () => clearTimer(req));
}

/** Restarts the request's deadline with `ms` from now. Does nothing for a request that was never armed (an app built without index.ts, as in tests) or whose deadline has already been cleared. */
export function extendBodyDeadline(req: IncomingMessage, ms: number): void {
  if (!timers.has(req)) return;
  clearTimer(req);
  startTimer(req, ms);
}
