import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes, deferred } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { flightFixture } from '../test/fixtures';
import { FlightDetail } from './FlightDetail';
import type { FlightPoint } from '../types';

// The GPS Track map draws on a canvas, which jsdom cannot host; the replay
// panel under test uses SVG and runs for real. Mocking FlightMap out (rather
// than letting it render its Leaflet overlay children) is what keeps those
// children — which need a real map instance — from ever mounting.
vi.mock('../components/maps', async () => {
  const actual = await vi.importActual<typeof import('../components/maps')>('../components/maps');
  return {
    ...actual,
    FlightMap: () => <div data-testid="flight-map" />,
  };
});

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];
const ROUTE_OPTS = { path: '/flight/:id', route: '/flight/1' };

describe('FlightDetail', () => {
  it('shows "Loading flight…" before the flight resolves, then the flight', async () => {
    const flight = deferred<ResponseTuple>();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights/1': flight.handler,
    });

    renderWithProviders(<FlightDetail />, ROUTE_OPTS);

    expect(screen.getByText('Loading flight…')).toBeInTheDocument();

    flight.resolve([200, flightFixture]);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Flight #1.*Airbus A320neo/ })).toBeInTheDocument()
    );
    expect(screen.queryByText('Loading flight…')).not.toBeInTheDocument();
  });

  it('renders the load error when the flight fetch fails (e.g. a 404 for an unknown id)', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights/1': [404, { error: 'Not found' }],
    });

    renderWithProviders(<FlightDetail />, ROUTE_OPTS);

    await waitFor(() => expect(screen.getByText('Could not load flight')).toBeInTheDocument());
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.queryByText('Loading flight…')).not.toBeInTheDocument();
  });

  describe('replay entry', () => {
    const points: FlightPoint[] = [0, 1, 2].map(i => ({
      id: i,
      flight_id: 1,
      ts: new Date(Date.UTC(2026, 2, 1, 8, 0, i * 5)).toISOString(),
      lat: 60 + i * 0.01,
      lon: 24 + i * 0.01,
      altitude_ft: 1000 * i,
      airspeed_kts: 100,
      ground_speed_kts: 110,
      heading_deg: 90,
      vertical_speed_fpm: 0,
      on_ground: 0,
    }));

    function load(pts: FlightPoint[], end_time: string | null = flightFixture.end_time) {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights/1': [200, { ...flightFixture, end_time, points: pts, point_count: pts.length }],
      });
      renderWithProviders(<FlightDetail />, ROUTE_OPTS);
    }

    it('offers no Replay tab for a flight with fewer than two points', async () => {
      load([points[0]]);
      await screen.findByRole('heading', { name: /Flight #1/ });
      expect(screen.queryByRole('tab', { name: 'Replay' })).not.toBeInTheDocument();
    });

    it('offers no Replay tab for a flight still in progress', async () => {
      load(points, null);
      await screen.findByRole('heading', { name: /Flight #1/ });
      expect(screen.queryByRole('tab', { name: 'Replay' })).not.toBeInTheDocument();
    });

    it('mounts the panel only on the Replay tab, and unmounts it when Track is selected again', async () => {
      load(points);
      const replayTab = await screen.findByRole('tab', { name: 'Replay' });
      expect(screen.queryByRole('region', { name: 'Flight replay' })).not.toBeInTheDocument();

      fireEvent.click(replayTab);
      expect(screen.getByRole('region', { name: 'Flight replay' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Replay speed' })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: 'Replay position' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Track' }));
      expect(screen.queryByRole('region', { name: 'Flight replay' })).not.toBeInTheDocument();
    });
  });

  describe('Notes tile', () => {
    it('shows an "Add notes" action for a flight with no notes', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights/1': [200, flightFixture],
      });
      renderWithProviders(<FlightDetail />, ROUTE_OPTS);

      await screen.findByRole('heading', { name: /Flight #1/ });
      expect(screen.getByText('No notes for this flight.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add notes for flight #1' })).toBeInTheDocument();
    });

    it('adding notes sends a PATCH with only { notes } and shows the new text without a reload', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights/1': {
          GET: [200, flightFixture],
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...flightFixture, notes: 'Smooth landing' }];
          },
        },
      });
      renderWithProviders(<FlightDetail />, ROUTE_OPTS);
      await screen.findByRole('heading', { name: /Flight #1/ });

      await user.click(screen.getByRole('button', { name: 'Add notes for flight #1' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: 'Smooth landing' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('Smooth landing')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: 'Smooth landing' });
    });

    it('editing existing notes sends the new value', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights/1': {
          GET: [200, { ...flightFixture, notes: 'Bumpy approach' }],
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...flightFixture, notes: 'Bumpy approach, corrected' }];
          },
        },
      });
      renderWithProviders(<FlightDetail />, ROUTE_OPTS);
      await screen.findByRole('heading', { name: /Flight #1/ });

      await user.click(screen.getByRole('button', { name: 'Edit notes for flight #1' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: 'Bumpy approach, corrected' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('Bumpy approach, corrected')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: 'Bumpy approach, corrected' });
    });

    it('clearing notes back to a blank draft returns to the empty state', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/flights/1': {
          GET: [200, { ...flightFixture, notes: 'Bumpy approach' }],
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...flightFixture, notes: null }];
          },
        },
      });
      renderWithProviders(<FlightDetail />, ROUTE_OPTS);
      await screen.findByRole('heading', { name: /Flight #1/ });

      await user.click(screen.getByRole('button', { name: 'Edit notes for flight #1' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: '   ' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('No notes for this flight.')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: null });
    });
  });

  it('renames the bottom-row Edit button and still opens the modal with its Notes field', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/flights/1': [200, flightFixture],
    });
    renderWithProviders(<FlightDetail />, ROUTE_OPTS);
    await screen.findByRole('heading', { name: /Flight #1/ });

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    // EditFlightModal is always mounted (Carbon's Modal toggles a CSS class rather
    // than mounting/unmounting), so the dialog must be found closed before the click
    // and open after it, not just present in the DOM either way.
    expect(screen.queryAllByRole('dialog').some(d => d.parentElement?.classList.contains('is-visible'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Edit flight details' }));

    const dialog = screen.getAllByRole('dialog').find(d => d.parentElement?.classList.contains('is-visible'));
    if (!dialog) throw new Error('no open dialog found');
    expect(within(dialog).getByRole('heading', { name: 'Edit flight' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Notes')).toBeInTheDocument();
  });
});
