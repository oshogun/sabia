import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { plannedLegListItemFixture } from '../test/fixtures';
import type { PlannedLegListItem, Trip } from '../types';
import { Prefiles } from './Prefiles';

// jsdom has no layout engine, so Carbon's Dropdown can't scroll a highlighted
// option into view when one is selected via keyboard/click; stub it out so
// that doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];
const UNSET_SIMBRIEF: ResponseTuple = [200, { simbrief_user_id: null }];
const SET_SIMBRIEF: ResponseTuple = [200, { simbrief_user_id: 'e2e-simbrief-id' }];
const NO_TRIPS: ResponseTuple = [200, []];

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
const TRIP_ONE: Trip = { ...TRIP_SEVEN, id: 1, name: 'E2E Baltic Hop' };

const MOVABLE_LEG: PlannedLegListItem = plannedLegListItemFixture;
const FLOWN_LEG: PlannedLegListItem = { ...plannedLegListItemFixture, id: 2, status: 'flown' };
const LINKED_LEG: PlannedLegListItem = { ...plannedLegListItemFixture, id: 3, linked_flight_id: 99 };
const LOOSE_LEG: PlannedLegListItem = { ...plannedLegListItemFixture, id: 4, trip_id: null, trip_name: null };

function fetchMock() {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('Prefiles', () => {
  it('renders the empty state when no planned legs exist', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/planned-legs': [200, []],
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/trips': NO_TRIPS,
    });

    renderWithProviders(<Prefiles />);

    expect(screen.getByRole('heading', { name: 'Prefiles' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No planned legs yet.')).toBeInTheDocument());
  });

  it('renders the load-error banner when the planned-legs fetch fails', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/planned-legs': [500, { error: 'Database is locked' }],
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/trips': NO_TRIPS,
    });

    renderWithProviders(<Prefiles />);

    await waitFor(() => expect(screen.getByText('Failed to load planned legs')).toBeInTheDocument());
    expect(screen.getByText('Database is locked')).toBeInTheDocument();
  });

  it('lists a planned leg under its trip, once the fetch resolves', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/planned-legs': [200, [plannedLegListItemFixture]],
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/trips': NO_TRIPS,
    });

    renderWithProviders(<Prefiles />);

    await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: plannedLegListItemFixture.trip_name! })).toBeInTheDocument();
  });

  describe('SimBrief import action', () => {
    it('is disabled and links to Settings when no SimBrief pilot ID is saved', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/planned-legs': [200, []],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
        '/api/trips': NO_TRIPS,
      });

      renderWithProviders(<Prefiles />);

      const importButton = await screen.findByRole('button', { name: 'Import from SimBrief' });
      await waitFor(() => expect(importButton).toBeDisabled());
      expect(screen.getByRole('link', { name: 'Set it in Settings' })).toHaveAttribute('href', '/settings');
    });

    it('imports a leg and shows the success banner once a SimBrief pilot ID is saved', async () => {
      const user = userEvent.setup();
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/planned-legs': [200, []],
        '/api/settings/simbrief': SET_SIMBRIEF,
        '/api/trips': NO_TRIPS,
        '/api/planned-legs/simbrief': [200, {
          result: { status: 'imported', label: 'EETN → ESSA', warnings: [] },
        }],
      });

      renderWithProviders(<Prefiles />);

      const importButton = await screen.findByRole('button', { name: 'Import from SimBrief' });
      await waitFor(() => expect(importButton).toBeEnabled());
      await user.click(importButton);

      await waitFor(() => expect(screen.getByText('Imported EETN → ESSA as a new planned leg.')).toBeInTheDocument());
    });
  });

  describe('import target picker', () => {
    it('imports into no trip by default (unchanged from today)', async () => {
      const user = userEvent.setup();
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': { GET: [200, []], POST: [201, { imported: [], results: [] }] },
        '/api/settings/simbrief': SET_SIMBRIEF,
        '/api/planned-legs/simbrief': [200, { result: { status: 'imported', label: 'X', warnings: [] } }],
      });

      renderWithProviders(<Prefiles />);
      await screen.findByRole('heading', { name: 'Prefiles' });

      const file = new File(['x'], 'plan.lnmpln', { type: 'text/plain' });
      await user.upload(screen.getByLabelText('Choose .lnmpln files'), file);
      await waitFor(() => expect(fetchMock().mock.calls.some(
        ([url, init]) => url === '/api/planned-legs' && (init as RequestInit | undefined)?.method === 'POST',
      )).toBe(true));

      const importButton = await screen.findByRole('button', { name: 'Import from SimBrief' });
      await user.click(importButton);
      await waitFor(() => expect(fetchMock().mock.calls.some(([url]) => url === '/api/planned-legs/simbrief')).toBe(true));
    });

    it('imports into the chosen trip once one is selected', async () => {
      const user = userEvent.setup();
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': [200, []],
        '/api/trips/7/planned-legs': [201, { imported: [], results: [] }],
        '/api/settings/simbrief': SET_SIMBRIEF,
        '/api/trips/7/planned-legs/simbrief': [200, { result: { status: 'imported', label: 'Y', warnings: [] } }],
      });

      renderWithProviders(<Prefiles />);
      await screen.findByRole('heading', { name: 'Prefiles' });

      fireEvent.click(screen.getByRole('combobox', { name: 'Import into' }));
      fireEvent.click(await screen.findByText('Trip Seven'));

      const file = new File(['x'], 'plan.lnmpln', { type: 'text/plain' });
      await user.upload(screen.getByLabelText('Choose .lnmpln files'), file);
      await waitFor(() => expect(fetchMock().mock.calls.some(([url]) => url === '/api/trips/7/planned-legs')).toBe(true));

      const importButton = await screen.findByRole('button', { name: 'Import from SimBrief' });
      await user.click(importButton);
      await waitFor(() => expect(fetchMock().mock.calls.some(([url]) => url === '/api/trips/7/planned-legs/simbrief')).toBe(true));
    });
  });

  describe('move to trip', () => {
    it('shows "Move to trip" only for a movable (unlinked, planned/skipped) leg', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': NO_TRIPS,
        '/api/planned-legs': [200, [MOVABLE_LEG, FLOWN_LEG, LINKED_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      expect(screen.getAllByRole('button', { name: 'Move to trip' })).toHaveLength(1);
    });

    it('excludes the leg\'s own trip from the picker, offering "No trip" since it has one', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_ONE, TRIP_SEVEN]],
        '/api/planned-legs': [200, [MOVABLE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      const optionTexts = within(select).getAllByRole('option').map(o => o.textContent);
      expect(optionTexts).toEqual(['Choose a trip…', 'No trip', 'Trip Seven']);
    });

    it('offers no "No trip" choice for a leg that already has none', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': [200, [LOOSE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      const optionTexts = within(select).getAllByRole('option').map(o => o.textContent);
      expect(optionTexts).toEqual(['Choose a trip…', 'Trip Seven']);
    });

    it('confirms a move: PUTs {tripId} and reloads the legs list', async () => {
      const user = userEvent.setup();
      let putBody: unknown;
      let putMethod: string | undefined;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': [200, [MOVABLE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
        '/api/planned-legs/1/trip': (init) => {
          putMethod = init?.method;
          putBody = JSON.parse((init?.body as string) ?? '{}');
          return [200, { ...MOVABLE_LEG, trip_id: 7 }];
        },
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      fireEvent.change(select, { target: { value: '7' } });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(putBody).toEqual({ tripId: 7 }));
      expect(putMethod).toBe('PUT');
      await waitFor(() => expect(fetchMock().mock.calls.filter(
        ([url, init]) => url === '/api/planned-legs' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
      ).length).toBe(2));
    });

    it('moves a leg to "No trip" (tripId: null)', async () => {
      const user = userEvent.setup();
      let putBody: unknown;
      let putMethod: string | undefined;
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': [200, [MOVABLE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
        '/api/planned-legs/1/trip': (init) => {
          putMethod = init?.method;
          putBody = JSON.parse((init?.body as string) ?? '{}');
          return [200, { ...MOVABLE_LEG, trip_id: null }];
        },
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      fireEvent.change(select, { target: { value: 'loose' } });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(putBody).toEqual({ tripId: null }));
      expect(putMethod).toBe('PUT');
    });

    it('shows "Could not load trips" in the picker when the shared trips fetch fails', async () => {
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [500, { error: 'Database is locked' }],
        '/api/planned-legs': [200, [LOOSE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));

      await waitFor(() => expect(screen.getByText('Could not load trips')).toBeInTheDocument());
      expect(screen.getByText('Database is locked')).toBeInTheDocument();
    });

    it('renders a rejected (409) move inline instead of throwing', async () => {
      const user = userEvent.setup();
      mockFetchRoutes({
        '/api/auth/session': SESSION_ROUTE,
        '/api/trips': [200, [TRIP_SEVEN]],
        '/api/planned-legs': [200, [MOVABLE_LEG]],
        '/api/settings/simbrief': UNSET_SIMBRIEF,
        '/api/planned-legs/1/trip': [409, {
          error: 'Planned leg 1 cannot be moved: linked to flight 4. Unlink the flight first.',
          code: 'LINKED_FLIGHT',
        }],
      });

      renderWithProviders(<Prefiles />);
      await waitFor(() => expect(screen.getByTestId('legs-table')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Move to trip' }));
      const select = await screen.findByLabelText('Move to');
      fireEvent.change(select, { target: { value: '7' } });
      await user.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => expect(screen.getByText('Could not move')).toBeInTheDocument());
      expect(screen.getByText(/linked to flight 4/)).toBeInTheDocument();
    });
  });
});
