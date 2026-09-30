import { test, expect } from '@playwright/test';

/**
 * Exercises Home, AllFlights, FlightDetail and TripDetail against the exact
 * fixture rows the scratch server was seeded with (src/testSeed.ts):
 *
 *   trip 1  "E2E Baltic Hop"
 *   flight 1  Airbus A320neo  EFHK -> EETN  (3 points, in the trip)
 *   flight 2  Cessna 172      EETN -> EEPU  (2 points, ungrouped)
 *   planned leg 1  EETN -> ESSA  (trip-linked, unflown)
 *   planned leg 2  ESSA -> EFHK  (loose, unflown — not shown on trip 1's page)
 *
 * Every assertion below names a specific fixture value, not just "a row
 * exists" — a regression that swapped flight 1 and flight 2's data, or
 * dropped the trip link, fails one of these.
 */

test.describe('Home', () => {
  test('renders the seeded stats, recent flights and ground/leg picker fixtures', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Home' })).toBeVisible();

    // Guarded on both sides against an extra digit (a tile's label and value
    // run together with no separator, e.g. "Total flights12", which a plain
    // substring check for "2" would wrongly pass) so each number is matched
    // whole, not as part of a longer one.
    await expect(main.getByTestId('stat-total-flights')).toContainText(/(?<!\d)2(?!\d)/);
    await expect(main.getByTestId('stat-total-trips')).toContainText(/(?<!\d)1(?!\d)/);
    await expect(main.getByTestId('stat-total-duration')).toContainText(/(?<!\d)2h 17m$/);
    await expect(main.getByTestId('stat-total-distance')).toContainText(/(?<!\d)248\.5(?!\d)/);

    // Sorted by start_time descending: the Cessna (2026-03-02) before the
    // Airbus (2026-03-01). The recent-flights list is a Carbon structured
    // list, whose rows carry role=row same as a table's.
    const recentRows = main.getByRole('row');
    await expect(recentRows).toHaveCount(3); // header row + 2 flights
    await expect(recentRows.nth(1)).toContainText('Cessna 172');
    await expect(recentRows.nth(1)).toContainText('EETN → EEPU');
    await expect(recentRows.nth(2)).toContainText('Airbus A320neo');
    await expect(recentRows.nth(2)).toContainText('EFHK → EETN');

    // No ground_sessions row was seeded.
    await expect(main.getByText('Not on the ground.')).toBeVisible();

    // The manual-entry planned-leg picker offers both unflown legs, labelled
    // by their owning trip (or its absence).
    const legPicker = main.locator('#ground-manual-leg');
    await expect(legPicker.locator('option', { hasText: 'E2E Baltic Hop · EETN → ESSA' })).toHaveCount(1);
    await expect(legPicker.locator('option', { hasText: 'No trip · ESSA → EFHK' })).toHaveCount(1);
  });
});

test.describe('AllFlights', () => {
  test('groups flight 1 under its trip and lists flight 2 as ungrouped', async ({ page }) => {
    await page.goto('/flights');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'All flights' })).toBeVisible();

    await expect(main.getByText('E2E Baltic Hop')).toBeVisible();
    await expect(main.getByText('1 leg')).toBeVisible();
    await expect(main.getByText('Ungrouped Flights')).toBeVisible();

    const table = main.getByRole('table', { name: 'Flight log' });
    // 7 rows within reach of the outer table locator: its own header row, the
    // trip's expand row, the trip's expanded-content row, the nested legs
    // table's header row, flight 1's leg row, the "Ungrouped Flights" label
    // row, and flight 2's row.
    await expect(table.getByRole('row')).toHaveCount(7);
    await expect(table.getByRole('cell', { name: /Airbus A320neo/ })).toBeVisible();
    await expect(table.getByRole('cell', { name: /EFHK → EETN/ })).toBeVisible();
    await expect(table.getByRole('cell', { name: /Cessna 172/ })).toBeVisible();
    await expect(table.getByRole('cell', { name: /EETN → EEPU/ })).toBeVisible();
  });
});

test.describe('FlightDetail', () => {
  test('flight 1 renders the Airbus, its EFHK -> EETN route and a 3-point track', async ({ page }) => {
    await page.goto('/flight/1');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: /Flight #1.*Airbus A320neo/ })).toBeVisible();

    await expect(main.getByTestId('stat-departure')).toContainText(/(?<=Departure)EFHK/);
    await expect(main.getByText('Helsinki-Vantaa')).toBeVisible();
    await expect(main.getByTestId('stat-arrival')).toContainText(/(?<=Arrival)EETN/);
    await expect(main.getByText('Tallinn Lennart Meri')).toBeVisible();
    await expect(main.getByTestId('stat-points')).toContainText(/(?<!\d)3(?!\d)/);
    await expect(main.getByTestId('stat-distance')).toContainText(/(?<!\d)152\.4(?!\d)/);

    const map = main.getByTestId('flight-map');
    await expect(map.locator('.leaflet-container')).toBeVisible();
    await expect(map.locator('.leaflet-marker-icon')).toHaveCount(2);
  });

  test('flight 2 renders the Cessna and its EETN -> EEPU route, distinctly from flight 1', async ({ page }) => {
    await page.goto('/flight/2');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: /Flight #2.*Cessna 172/ })).toBeVisible();

    await expect(main.getByTestId('stat-departure')).toContainText(/(?<=Departure)EETN/);
    await expect(main.getByTestId('stat-arrival')).toContainText(/(?<=Arrival)EEPU/);
    await expect(main.getByTestId('stat-points')).toContainText(/(?<!\d)2(?!\d)/);
    await expect(main.getByTestId('stat-distance')).toContainText(/(?<!\d)96\.1(?!\d)/);
  });
});

test.describe('TripDetail', () => {
  test('trip 1 shows its name, the flown Airbus leg, the unflown EETN -> ESSA ghost leg and an empty SimBrief panel', async ({ page }) => {
    await page.goto('/trip/1');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeVisible();

    const legsTable = main.getByRole('table', { name: 'Trip legs' });
    await expect(legsTable.getByRole('cell', { name: /Airbus A320neo/ })).toBeVisible();
    await expect(legsTable.getByRole('cell', { name: /EFHK → EETN/ })).toBeVisible();

    // The unflown, trip-linked planned leg renders as a dimmed "ghost" row.
    const ghostRow = legsTable.getByRole('row', { name: /EETN → ESSA/ });
    await expect(ghostRow).toHaveCount(1);
    await expect(ghostRow).toContainText('Planned');

    // Leg 2 (ESSA -> EFHK) is loose — it must not appear on trip 1's page.
    await expect(main.getByText('ESSA → EFHK')).toHaveCount(0);

    // No app_setting row for SimBrief was seeded.
    await expect(main.getByText('No SimBrief pilot ID saved.')).toBeVisible();
  });
});
