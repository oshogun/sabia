// The per-request body deadline: an armed request whose body has not fully
// arrived at the deadline loses its connection, the upload's extension moves
// only its own deadline, and a request nobody armed is left alone. Mock
// request and response objects with fake timers; no socket is opened.

import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armBodyDeadline, BODY_DEADLINE_MS, extendBodyDeadline } from '../src/bodyDeadline';

interface Fake {
  req: IncomingMessage;
  res: ServerResponse;
  reqEvents: EventEmitter;
  resEvents: EventEmitter;
  destroy: ReturnType<typeof vi.fn>;
}

function fake(complete: boolean): Fake {
  const destroy = vi.fn();
  const reqEvents = Object.assign(new EventEmitter(), { complete, socket: { destroy } });
  const resEvents = new EventEmitter();
  return {
    req: reqEvents as unknown as IncomingMessage,
    res: resEvents as unknown as ServerResponse,
    reqEvents, resEvents, destroy,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('body deadline', () => {
  it('destroys the connection of an armed request whose body is incomplete at the deadline', () => {
    const f = fake(false);
    armBodyDeadline(f.req, f.res);
    vi.advanceTimersByTime(BODY_DEADLINE_MS - 1);
    expect(f.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it('is 300 seconds, the default Node applied before it was turned off', () => {
    expect(BODY_DEADLINE_MS).toBe(300_000);
  });

  it('spares a request whose body has already arrived, such as a long-lived GET', () => {
    const f = fake(true);
    armBodyDeadline(f.req, f.res);
    vi.advanceTimersByTime(BODY_DEADLINE_MS * 3);
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it('spares a request whose body ended before the deadline, and one whose response closed', () => {
    const ended = fake(false);
    armBodyDeadline(ended.req, ended.res);
    ended.reqEvents.emit('end');
    const closed = fake(false);
    armBodyDeadline(closed.req, closed.res);
    closed.resEvents.emit('close');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BODY_DEADLINE_MS * 2);
    expect(ended.destroy).not.toHaveBeenCalled();
    expect(closed.destroy).not.toHaveBeenCalled();
  });

  it('does not keep the process alive: its timer is unref()ed', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const f = fake(false);
    armBodyDeadline(f.req, f.res);
    const timer = spy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
  });

  it('arms every request on its own: one request ending leaves another armed', () => {
    const a = fake(false);
    const b = fake(false);
    armBodyDeadline(a.req, a.res);
    armBodyDeadline(b.req, b.res);
    a.reqEvents.emit('end');
    vi.advanceTimersByTime(BODY_DEADLINE_MS);
    expect(a.destroy).not.toHaveBeenCalled();
    expect(b.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('extending the deadline', () => {
  it('spares an extended request until the extended deadline, then destroys it', () => {
    const ordinary = fake(false);
    const extended = fake(false);
    armBodyDeadline(ordinary.req, ordinary.res);
    armBodyDeadline(extended.req, extended.res);
    extendBodyDeadline(extended.req, 3_600_000);
    vi.advanceTimersByTime(BODY_DEADLINE_MS);
    expect(ordinary.destroy).toHaveBeenCalledTimes(1);
    expect(extended.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_600_000 - BODY_DEADLINE_MS - 1);
    expect(extended.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(extended.destroy).toHaveBeenCalledTimes(1);
  });

  it('counts the extension from the call, not from when the request arrived', () => {
    const f = fake(false);
    armBodyDeadline(f.req, f.res);
    vi.advanceTimersByTime(BODY_DEADLINE_MS - 10);
    extendBodyDeadline(f.req, 1000);
    vi.advanceTimersByTime(999);
    expect(f.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a request nothing armed: no timer is created and nothing is destroyed', () => {
    const f = fake(false);
    extendBodyDeadline(f.req, 1000);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(BODY_DEADLINE_MS * 2);
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it('is a no-op once the request has ended or its response has closed', () => {
    const ended = fake(false);
    armBodyDeadline(ended.req, ended.res);
    ended.reqEvents.emit('end');
    extendBodyDeadline(ended.req, 1000);
    const closed = fake(false);
    armBodyDeadline(closed.req, closed.res);
    closed.resEvents.emit('close');
    extendBodyDeadline(closed.req, 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
