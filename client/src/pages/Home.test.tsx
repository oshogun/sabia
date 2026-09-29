import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes, deferred } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { flightFixture } from '../test/fixtures';
import { MockEventSource } from '../test/mockEventSource';
import { LiveEventsProvider, useLiveEvent, LIVE_HANDLER_DEBOUNCE_MS } from '../shell/LiveEventsProvider';
import { Home } from './Home';

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];
const BASE_ROUTES: Record<string, ResponseTuple> = {
  '/api/auth/session': SESSION_ROUTE,
  '/api/flights': [200, [flightFixture]],
  '/api/trips': [200, []],
  '/api/ground-sessions/current': [200, { session: null }],
  '/api/planned-legs': [200, []],
};

function fetchCallCount(): number {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe('Home', () => {
  it('shows a loading state before the flights request resolves, then the real stats', async () => {
    const flights = deferred<ResponseTuple>();
    mockFetchRoutes({ ...BASE_ROUTES, '/api/flights': flights.handler });

    renderWithProviders(<Home />);

    // Nothing has resolved yet: neither the empty state nor the stats have
    // rendered, only the loading skeleton.
    expect(screen.queryByText('No flights recorded yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Total flights')).not.toBeInTheDocument();

    flights.resolve([200, [flightFixture]]);

    await waitFor(() => expect(screen.getByText('Total flights')).toBeInTheDocument());
    expect(screen.queryByText('No flights recorded yet.')).not.toBeInTheDocument();
  });

  it('renders the empty state once the flights request resolves with none', async () => {
    mockFetchRoutes({ ...BASE_ROUTES, '/api/flights': [200, []] });

    renderWithProviders(<Home />);

    await waitFor(() => expect(screen.getByText('No flights recorded yet.')).toBeInTheDocument());
    expect(screen.queryByText('Total flights')).not.toBeInTheDocument();
  });

  it('renders the flights-fetch error inline instead of the flight list', async () => {
    mockFetchRoutes({ ...BASE_ROUTES, '/api/flights': [500, { error: 'Database is locked' }] });

    renderWithProviders(<Home />);

    await waitFor(() => expect(screen.getByText('Database is locked')).toBeInTheDocument());
  });

  describe('driven by the shared live event stream', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      MockEventSource.reset();
      vi.stubGlobal('EventSource', MockEventSource);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens exactly one EventSource for a full render', async () => {
      mockFetchRoutes(BASE_ROUTES);

      renderWithProviders(<LiveEventsProvider><Home /></LiveEventsProvider>);
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('renders the live-panel aircraft name as an h2, keeping the page outline unbroken', async () => {
      const flyingStatus = {
        connected: true, flightState: 'FLYING', currentFlightId: 1, aircraft: 'Boeing 737-800',
        frame: {
          lat: 10, lon: 20, altitudeFt: 5000, airspeedKnots: 250, groundSpeedKnots: 260,
          headingDeg: 90, verticalSpeedFpm: 0, onGround: false,
        },
        paused: false, pauseFlags: 0,
      };
      mockFetchRoutes({ ...BASE_ROUTES, '/api/status': [200, flyingStatus] });

      renderWithProviders(<LiveEventsProvider><Home /></LiveEventsProvider>);
      await act(() => vi.advanceTimersByTimeAsync(0));

      const es = MockEventSource.latest();
      act(() => { es.open(); es.emit('status', flyingStatus); });

      expect(screen.getByRole('heading', { level: 2, name: 'Boeing 737-800' })).toBeInTheDocument();
    });

    it('refetches once for a flights-changed and a flight-state event from one write', async () => {
      mockFetchRoutes(BASE_ROUTES);

      renderWithProviders(<LiveEventsProvider><Home /></LiveEventsProvider>);
      await act(() => vi.advanceTimersByTimeAsync(0));

      const es = MockEventSource.latest();
      // Drain the reconnect-refetch the initial open already queued, so the
      // count below isolates the pair emitted next.
      act(() => { es.open(); });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));

      const before = fetchCallCount();
      act(() => {
        es.emit('flights-changed', { flightId: 1 });
        es.emit('flight-state', { flightState: 'GROUND', currentFlightId: 1, plannedLegId: null });
      });

      // Still inside the debounce window: no refetch yet.
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS - 1));
      expect(fetchCallCount()).toBe(before);

      await act(() => vi.advanceTimersByTimeAsync(1));
      // One Home refetch (listFlights + listTrips) plus GroundSection's own
      // registration on the same pair of topics (getCurrentGroundSession) —
      // three calls total, not six: each registration debounces on its own,
      // but only once per burst.
      expect(fetchCallCount() - before).toBe(3);
    });
  });

  describe('useLiveEvent batching (via the shared provider)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      MockEventSource.reset();
      vi.stubGlobal('EventSource', MockEventSource);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveEventsProvider>{children}</LiveEventsProvider>
    );

    it('delivers a pure open as {reconnected: true, events: []}, then a burst as one call in arrival order', async () => {
      const handler = vi.fn();
      renderHook(() => useLiveEvent(['flights-changed', 'acars'], handler), { wrapper });
      const es = MockEventSource.latest();

      act(() => { es.open(); });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({ reconnected: true, events: [] });

      handler.mockClear();
      act(() => {
        es.emit('flights-changed', { a: 1 });
        es.emit('acars', { b: 2 });
      });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({
        reconnected: false,
        events: [
          { topic: 'flights-changed', data: { a: 1 } },
          { topic: 'acars', data: { b: 2 } },
        ],
      });
    });

    it('reads the current handler from the ref at fire time', async () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderHook(({ handler }) => useLiveEvent(['acars'], handler), {
        initialProps: { handler: first },
        wrapper,
      });
      const es = MockEventSource.latest();
      act(() => { es.open(); });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));
      first.mockClear();

      act(() => { es.emit('acars', { messageId: 1 }); });
      rerender({ handler: second });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
