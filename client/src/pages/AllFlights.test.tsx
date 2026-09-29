import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes, deferred } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { flightFixture } from '../test/fixtures';
import { MockEventSource } from '../test/mockEventSource';
import { LiveEventsProvider, LIVE_HANDLER_DEBOUNCE_MS } from '../shell/LiveEventsProvider';
import { AllFlights } from './AllFlights';

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];

function fetchCallCount(): number {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe('AllFlights', () => {
  it('shows a loading skeleton before the flights request resolves, then the real table row', async () => {
    const flights = deferred<ResponseTuple>();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights': flights.handler,
      '/api/trips': [200, []],
    });

    renderWithProviders(<AllFlights />);

    expect(document.querySelector('.cds--data-table-container.cds--skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/Airbus A320neo/)).not.toBeInTheDocument();
    expect(screen.queryByText('No flights recorded yet')).not.toBeInTheDocument();

    flights.resolve([200, [flightFixture]]);

    await waitFor(() => expect(screen.getByRole('cell', { name: /Airbus A320neo/ })).toBeInTheDocument());
    expect(document.querySelector('.cds--data-table-container.cds--skeleton')).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Airbus A320neo/ })).toBeInTheDocument();
  });

  it('shows the empty state once the flights request resolves to none', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights': [200, []],
      '/api/trips': [200, []],
    });

    renderWithProviders(<AllFlights />);

    await waitFor(() => expect(screen.getByText('No flights recorded yet')).toBeInTheDocument());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the flights-fetch error inline instead of the table', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights': [500, { error: 'Database is locked' }],
      '/api/trips': [200, []],
    });

    renderWithProviders(<AllFlights />);

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

    it('refetches once on a flights-changed event, debounced', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights': [200, [flightFixture]],
        '/api/trips': [200, []],
      });

      renderWithProviders(<LiveEventsProvider><AllFlights /></LiveEventsProvider>);
      await act(() => vi.advanceTimersByTimeAsync(0));

      const es = MockEventSource.latest();
      // Drain the reconnect-refetch the initial open already queues.
      act(() => { es.open(); });
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS));

      const before = fetchCallCount();
      act(() => { es.emit('flights-changed', { flightId: 1 }); });

      // Still inside the debounce window: no refetch yet.
      await act(() => vi.advanceTimersByTimeAsync(LIVE_HANDLER_DEBOUNCE_MS - 1));
      expect(fetchCallCount()).toBe(before);

      await act(() => vi.advanceTimersByTimeAsync(1));
      // One refetch is one listFlights() + one listTrips() call.
      expect(fetchCallCount() - before).toBe(2);
    });
  });
});
