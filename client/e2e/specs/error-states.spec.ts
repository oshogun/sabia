import { test, expect } from '@playwright/test';

/**
 * FlightDetail and TripDetail's loading/error handling, against the real
 * scratch server: a nonexistent id (the server's real 404), an aborted
 * request (network failure) and an artificially slowed response (to catch
 * the loading indicator before the real data arrives).
 */

test.describe('not-found ids', () => {
  test('a nonexistent flight id shows the failed-to-load state, not a blank page', async ({ page }) => {
    await page.goto('/flight/999999');
    const main = page.getByRole('main');
    await expect(main.getByText('Could not load flight')).toBeVisible();
    await expect(main.getByText('Not found')).toBeVisible();
  });

  test('a nonexistent trip id shows the failed-to-load state, not a blank page', async ({ page }) => {
    await page.goto('/trip/999999');
    const main = page.getByRole('main');
    await expect(main.getByText('Could not load trip')).toBeVisible();
    await expect(main.getByText('Not found')).toBeVisible();
  });
});

test.describe('loading state', () => {
  test('FlightDetail shows "Loading flight…" while the request is in flight, then replaces it with the flight', async ({ page }) => {
    // Slows the real response so the loading state is observable instead of
    // resolving before the first paint — the API itself is untouched.
    await page.route('**/api/flights/1', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    await page.goto('/flight/1');
    const main = page.getByRole('main');
    await expect(main.getByText('Loading flight…')).toBeVisible();
    await expect(main.getByRole('heading', { name: /Flight #1/ })).toBeVisible();
    await expect(main.getByText('Loading flight…')).toHaveCount(0);
  });

  test('TripDetail shows "Loading trip…" while the request is in flight, then replaces it with the trip', async ({ page }) => {
    await page.route('**/api/trips/1', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    await page.goto('/trip/1');
    const main = page.getByRole('main');
    await expect(main.getByText('Loading trip…')).toBeVisible();
    await expect(main.getByRole('heading', { name: 'E2E Baltic Hop' })).toBeVisible();
    await expect(main.getByText('Loading trip…')).toHaveCount(0);
  });
});

test.describe('unreachable API', () => {
  test('FlightDetail surfaces a load error when the request never reaches the server', async ({ page }) => {
    await page.route('**/api/flights/1', (route) => route.abort('connectionfailed'));

    await page.goto('/flight/1');
    const main = page.getByRole('main');
    await expect(main.getByText('Could not load flight')).toBeVisible();
  });

  test('AllFlights surfaces an inline error and still renders the page when the flights fetch fails', async ({ page }) => {
    await page.route('**/api/flights', (route) => route.abort('connectionfailed'));

    await page.goto('/flights');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'All flights' })).toBeVisible();
    // apiFetch's error message for an aborted request, rendered inline — the
    // page itself (heading, "New Trip" button) still renders around it.
    await expect(main.getByText('Failed to fetch')).toBeVisible();
    await expect(main.getByRole('button', { name: 'New Trip' })).toBeVisible();
    // Flights were never loaded, so the table has no "no results" message to
    // show — that would misleadingly imply a search came up empty.
    await expect(main.getByText(/No flights match/)).toHaveCount(0);
  });
});
