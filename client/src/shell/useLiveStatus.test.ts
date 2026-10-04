import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { mockFetchRoutes, deferred } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { MockEventSource } from '../test/mockEventSource';
import { LiveEventsProvider, EVENTS_CLOSED_RETRY_MIN_MS, HIDDEN_CLOSE_DELAY_MS } from './LiveEventsProvider';
import { useLiveStatus, statusToView } from './useLiveStatus';

const IDLE_STATUS_BODY = {
  connected: true, flightState: 'IDLE', currentFlightId: null, aircraft: null, frame: null, paused: false, pauseFlags: 0,
};
const IDLE_STATUS: ResponseTuple = [200, IDLE_STATUS_BODY];

function wrapper({ children }: { children: ReactNode }) {
  return createElement(LiveEventsProvider, null, children);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useLiveStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.reset();
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('shows "Checking..." before the first status arrives, then maps a real one', () => {
    mockFetchRoutes({ '/api/status': IDLE_STATUS });
    const { result } = renderHook(() => useLiveStatus(), { wrapper });
    expect(result.current).toEqual({ type: 'gray', label: 'Checking...' });

    const es = MockEventSource.latest();
    act(() => {
      es.open();
      es.emit('status', IDLE_STATUS_BODY);
    });
    expect(result.current).toEqual({ type: 'blue', label: 'Connected · Idle' });
  });

  it('shows "Server unreachable" once the stream closes, and recovers once it reopens', async () => {
    mockFetchRoutes({ '/api/status': IDLE_STATUS });
    const { result } = renderHook(() => useLiveStatus(), { wrapper });
    const es = MockEventSource.latest();
    act(() => { es.open(); es.emit('status', IDLE_STATUS_BODY); });
    expect(result.current.label).toBe('Connected · Idle');

    act(() => { es.fail({ permanent: true }); });
    expect(result.current).toEqual({ type: 'red', label: 'Server unreachable' });

    // The first CLOSED retry is 5 s: the probe fires then and opens a fresh stream.
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_CLOSED_RETRY_MIN_MS));
    expect(MockEventSource.instances).toHaveLength(2);

    const reopened = MockEventSource.latest();
    act(() => { reopened.open(); reopened.emit('status', IDLE_STATUS_BODY); });
    expect(result.current).toEqual({ type: 'blue', label: 'Connected · Idle' });
  });

  it('backs off 5s, 10s, 20s across three consecutive failed opens, and resets to 5s once one opens', async () => {
    mockFetchRoutes({ '/api/status': IDLE_STATUS });
    renderHook(() => useLiveStatus(), { wrapper });
    let es = MockEventSource.latest();

    act(() => { es.fail({ permanent: true }); });
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_CLOSED_RETRY_MIN_MS - 1));
    expect(MockEventSource.instances).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(MockEventSource.instances).toHaveLength(2); // retried after 5s

    es = MockEventSource.latest();
    act(() => { es.fail({ permanent: true }); });
    await act(() => vi.advanceTimersByTimeAsync(2 * EVENTS_CLOSED_RETRY_MIN_MS - 1));
    expect(MockEventSource.instances).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(MockEventSource.instances).toHaveLength(3); // retried after 10s

    es = MockEventSource.latest();
    act(() => { es.fail({ permanent: true }); });
    await act(() => vi.advanceTimersByTimeAsync(4 * EVENTS_CLOSED_RETRY_MIN_MS - 1));
    expect(MockEventSource.instances).toHaveLength(3);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(MockEventSource.instances).toHaveLength(4); // retried after 20s

    es = MockEventSource.latest();
    act(() => { es.open(); }); // a successful open resets the backoff
    act(() => { es.fail({ permanent: true }); });
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_CLOSED_RETRY_MIN_MS - 1));
    expect(MockEventSource.instances).toHaveLength(4);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(MockEventSource.instances).toHaveLength(5); // back to 5s, not 40s
  });

  describe('statusToView', () => {
    it('returns gray "Waiting for sim" when disconnected and FLYING with aircraft name', () => {
      const status = { connected: false, flightState: 'FLYING', aircraft: 'Cessna 182', paused: false, frame: null, currentFlightId: null, pauseFlags: 0 };
      expect(statusToView(status)).toEqual({ type: 'gray', label: 'Waiting for sim · Cessna 182' });
    });

    it('returns gray "Waiting for sim · Unknown" when disconnected and FLYING with null aircraft', () => {
      const status = { connected: false, flightState: 'FLYING', aircraft: null, paused: false, frame: null, currentFlightId: null, pauseFlags: 0 };
      expect(statusToView(status)).toEqual({ type: 'gray', label: 'Waiting for sim · Unknown' });
    });

    it('returns gray "Sim not connected" when disconnected and IDLE', () => {
      const status = { connected: false, flightState: 'IDLE', aircraft: null, paused: false, frame: null, currentFlightId: null, pauseFlags: 0 };
      expect(statusToView(status)).toEqual({ type: 'gray', label: 'Sim not connected' });
    });

    it('returns green "Recording" when connected and FLYING unpaused', () => {
      const status = { connected: true, flightState: 'FLYING', aircraft: 'Cessna 182', paused: false, frame: null, currentFlightId: null, pauseFlags: 0 };
      expect(statusToView(status)).toEqual({ type: 'green', label: 'Recording · Cessna 182' });
    });

    it('returns magenta "Paused" when connected and FLYING paused', () => {
      const status = { connected: true, flightState: 'FLYING', aircraft: 'Cessna 182', paused: true, frame: null, currentFlightId: null, pauseFlags: 0 };
      expect(statusToView(status)).toEqual({ type: 'magenta', label: 'Paused · Cessna 182' });
    });
  });

  it('never opens a second stream when a hidden-close cuts off a backoff probe that only completes after the tab is visible again', async () => {
    const statusProbe = deferred<ResponseTuple>();
    mockFetchRoutes({ '/api/status': statusProbe.handler });
    renderHook(() => useLiveStatus(), { wrapper });

    const es1 = MockEventSource.latest();
    act(() => { es1.fail({ permanent: true }); }); // schedules the 5s backoff retry

    // The backoff timer fires and starts probing /api/status, but that
    // request is left hanging (statusProbe is not resolved yet).
    await act(() => vi.advanceTimersByTimeAsync(EVENTS_CLOSED_RETRY_MIN_MS));
    expect(MockEventSource.instances).toHaveLength(1); // no new stream from the probe alone

    // The tab goes hidden for long enough to close deliberately while that
    // probe is still in flight.
    act(() => setHidden(true));
    await act(() => vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_DELAY_MS));
    expect(MockEventSource.instances).toHaveLength(1);

    // Coming back visible reconnects immediately: exactly one new stream.
    act(() => setHidden(false));
    expect(MockEventSource.instances).toHaveLength(2);

    // The stale probe from before the hidden-close now finally resolves.
    // It must not open a third stream on top of the visible-reconnect's.
    await act(async () => { statusProbe.resolve(IDLE_STATUS); });
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('arms the hidden-close timer up front when the tab is already hidden at mount', async () => {
    setHidden(true);
    mockFetchRoutes({ '/api/status': IDLE_STATUS });
    renderHook(() => useLiveStatus(), { wrapper });
    const es = MockEventSource.latest();
    act(() => { es.open(); es.emit('status', IDLE_STATUS_BODY); });

    // Nothing (no 'visibilitychange' event) fires after mount — only the
    // already-hidden state at mount time can arm this timer.
    await act(() => vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_DELAY_MS));

    // Closed deliberately, not by a network error.
    expect(es.readyState).toBe(2);
  });
});
