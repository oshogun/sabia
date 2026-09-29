import { describe, it, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes, deferred } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { plannedLegFixture, tripFixture } from '../test/fixtures';
import type { Trip } from '../types';
import { TripDetail } from './TripDetail';

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];
const SIMBRIEF_ROUTE: ResponseTuple = [200, { simbrief_user_id: null }];
const ROUTE_OPTS = { path: '/trip/:id', route: '/trip/1' };

const TRIP_SEVEN: Trip = {
  id: 7,
  name: 'Trip Seven',
  notes: null,
  flight_count: 0,
  total_duration_sec: null,
  total_distance_nm: null,
  max_altitude_ft: null,
  flights: [],
  is_active: 0,
  planned_leg_count: 0,
  planned_legs: [],
};
const TRIP_WITH_LEG: Trip = { ...tripFixture, planned_legs: [plannedLegFixture] };

describe('TripDetail', () => {
  it('shows "Loading trip…" before the trip resolves, then the trip', async () => {
    const trip = deferred<ResponseTuple>();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/trips/1': trip.handler,
      '/api/settings/simbrief': SIMBRIEF_ROUTE,
    });

    renderWithProviders(<TripDetail />, ROUTE_OPTS);

    expect(screen.getByText('Loading trip…')).toBeInTheDocument();

    trip.resolve([200, tripFixture]);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());
    expect(screen.queryByText('Loading trip…')).not.toBeInTheDocument();
  });

  it('renders the load error when the trip fetch fails (e.g. a 404 for an unknown id)', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/trips/1': [404, { error: 'Not found' }],
      '/api/settings/simbrief': SIMBRIEF_ROUTE,
    });

    renderWithProviders(<TripDetail />, ROUTE_OPTS);

    await waitFor(() => expect(screen.getByText('Could not load trip')).toBeInTheDocument());
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.queryByText('Loading trip…')).not.toBeInTheDocument();
  });

  describe('move to trip', () => {
    it('offers "Move to trip" for the ghost row of an unlinked planned leg', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': [200, TRIP_WITH_LEG],
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
      });

      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      expect(screen.getByRole('button', { name: 'Move to trip' })).toBeInTheDocument();
    });

    it('excludes the current trip from the picker, offering "No trip"', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': [200, TRIP_WITH_LEG],
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
        '/api/trips': [200, [tripFixture, TRIP_SEVEN]],
      });

      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      const optionTexts = within(select).getAllByRole('option').map(o => o.textContent);
      expect(optionTexts).toEqual(['Choose a trip…', 'No trip', 'Trip Seven']);
    });

    it('confirms a move, then reloads the trip so the moved leg leaves the table', async () => {
      const user = userEvent.setup();
      let putBody: unknown;
      let putMethod: string | undefined;
      let tripCallCount = 0;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': () => {
          tripCallCount += 1;
          return [200, tripCallCount === 1 ? TRIP_WITH_LEG : { ...tripFixture, planned_legs: [] }];
        },
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs/1/trip': (init) => {
          putMethod = init?.method;
          putBody = JSON.parse((init?.body as string) ?? '{}');
          return [200, { ...plannedLegFixture, trip_id: 7 }];
        },
      });

      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      fireEvent.change(select, { target: { value: '7' } });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(putBody).toEqual({ tripId: 7 }));
      expect(putMethod).toBe('PUT');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Move to trip' })).not.toBeInTheDocument());
    });

    it('renders a rejected (409) move inline instead of throwing', async () => {
      const user = userEvent.setup();
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': [200, TRIP_WITH_LEG],
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs/1/trip': [409, {
          error: 'Planned leg 1 cannot be moved: linked to flight 4. Unlink the flight first.',
          code: 'LINKED_FLIGHT',
        }],
      });

      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      fireEvent.change(select, { target: { value: '7' } });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(screen.getByText('Could not move')).toBeInTheDocument());
      expect(screen.getByText(/linked to flight 4/)).toBeInTheDocument();
    });
  });

  describe('Notes tile', () => {
    it('shows an "Add notes" action for a trip with no notes', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': [200, tripFixture],
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
      });
      renderWithProviders(<TripDetail />, ROUTE_OPTS);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());
      expect(screen.getByText('No notes for this trip.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add notes for E2E Baltic Hop' })).toBeInTheDocument();
    });

    it('adding notes sends a PATCH with only { notes } and shows the new text without a reload', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      let getCallCount = 0;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': {
          GET: () => {
            getCallCount += 1;
            return [200, getCallCount === 1 ? tripFixture : { ...tripFixture, notes: 'Great trip' }];
          },
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...tripFixture, notes: 'Great trip' }];
          },
        },
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
      });
      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Add notes for E2E Baltic Hop' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: 'Great trip' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('Great trip')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: 'Great trip' });
    });

    it('editing existing notes sends the new value', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      let getCallCount = 0;
      const withNotes = { ...tripFixture, notes: 'Bumpy leg' };
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': {
          GET: () => {
            getCallCount += 1;
            return [200, getCallCount === 1 ? withNotes : { ...withNotes, notes: 'Bumpy leg, corrected' }];
          },
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...withNotes, notes: 'Bumpy leg, corrected' }];
          },
        },
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
      });
      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Edit notes for E2E Baltic Hop' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: 'Bumpy leg, corrected' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('Bumpy leg, corrected')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: 'Bumpy leg, corrected' });
    });

    it('clearing notes back to a blank draft returns to the empty state', async () => {
      const user = userEvent.setup();
      let patchBody: unknown;
      let getCallCount = 0;
      const withNotes = { ...tripFixture, notes: 'Bumpy leg' };
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips/1': {
          GET: () => {
            getCallCount += 1;
            return [200, getCallCount === 1 ? withNotes : { ...tripFixture, notes: null }];
          },
          PATCH: (init) => {
            patchBody = JSON.parse((init?.body as string) ?? '{}');
            return [200, { ...tripFixture, notes: null }];
          },
        },
        '/api/settings/simbrief': SIMBRIEF_ROUTE,
      });
      renderWithProviders(<TripDetail />, ROUTE_OPTS);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Edit notes for E2E Baltic Hop' }));
      const notesTile = within(screen.getByTestId('notes-tile'));
      fireEvent.change(notesTile.getByRole('textbox'), { target: { value: '   ' } });
      await user.click(notesTile.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.getByText('No notes for this trip.')).toBeInTheDocument());
      expect(patchBody).toEqual({ notes: null });
    });
  });

  it('renames the bottom-row Edit button and still opens the modal with its Notes field', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/trips/1': [200, tripFixture],
      '/api/settings/simbrief': SIMBRIEF_ROUTE,
    });
    renderWithProviders(<TripDetail />, ROUTE_OPTS);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    // EditTripModal is always mounted (Carbon's Modal toggles a CSS class rather
    // than mounting/unmounting), so the dialog must be found closed before the click
    // and open after it, not just present in the DOM either way.
    expect(screen.queryAllByRole('dialog').some(d => d.parentElement?.classList.contains('is-visible'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Edit trip details' }));

    const dialog = screen.getAllByRole('dialog').find(d => d.parentElement?.classList.contains('is-visible'));
    if (!dialog) throw new Error('no open dialog found');
    expect(within(dialog).getByRole('heading', { name: 'Edit trip' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Notes')).toBeInTheDocument();
  });
});
