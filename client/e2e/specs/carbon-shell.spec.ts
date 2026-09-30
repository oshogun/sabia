import fs from 'node:fs';
import { test, expect } from '@playwright/test';

/**
 * Shell-level guarantees that no single page spec covers on its own: the
 * SideNav's identity across a write, breadcrumb navigation staying in-app,
 * the shared modal's focus trap, the header's live-status wording, a PDF
 * export round trip, and the session-expiry bounce to /login. Fixture rows
 * are from src/testSeed.ts (trip 1 "E2E Baltic Hop", flight 1 EFHK -> EETN).
 */

test.describe('SideNav identity', () => {
  test('a trip submenu opened by hand stays open across a rename', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Home' })).toBeVisible();

    const tripMenuButton = page.getByRole('button', { name: 'E2E Baltic Hop', exact: true });
    await tripMenuButton.click();
    const overviewLink = page.getByRole('link', { name: 'Trip overview' });
    await expect(overviewLink).toBeVisible();
    await expect(tripMenuButton).toHaveAttribute('aria-expanded', 'true');

    await overviewLink.click();
    await expect(page.getByRole('main').getByRole('heading', { name: 'E2E Baltic Hop', level: 1 })).toBeVisible();

    try {
      await page.getByRole('button', { name: 'Edit trip details' }).click();
      await expect(page.getByRole('heading', { name: 'Edit trip' })).toBeVisible();
      const nameField = page.getByLabel('Trip name');
      await nameField.fill('E2E Baltic Hop Renamed');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('heading', { name: 'Edit trip' })).toBeHidden();
      await expect(page.getByRole('main').getByRole('heading', { name: 'E2E Baltic Hop Renamed', level: 1 })).toBeVisible();

      // The rename is the write; subscribeMutations debounces 150ms before
      // useNavTree refetches. The renamed SideNavMenu must still be the same
      // open submenu, not a freshly-mounted, freshly-collapsed one.
      const renamedMenuButton = page.getByRole('button', { name: 'E2E Baltic Hop Renamed', exact: true });
      await expect(renamedMenuButton).toBeVisible();
      await expect(renamedMenuButton).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('link', { name: 'Trip overview' })).toBeVisible();
    } finally {
      // Leave the fixture as found for whatever runs after this test.
      await page.request.patch('/api/trips/1', {
        data: { name: 'E2E Baltic Hop' },
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });
});

test.describe('breadcrumb navigation', () => {
  test('following a breadcrumb link is an in-app route change, not a reload', async ({ page }) => {
    await page.goto('/trip/1');
    await expect(page.getByRole('main').getByRole('heading', { name: 'E2E Baltic Hop', level: 1 })).toBeVisible();

    // A sentinel that only a full page reload would clear.
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__e2e_sentinel__ = 'still-here'; });

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await breadcrumb.getByRole('link', { name: 'All Flights' }).click();

    await expect(page).toHaveURL(/\/flights$/);
    const sentinel = await page.evaluate(() => (window as unknown as Record<string, unknown>).__e2e_sentinel__);
    expect(sentinel).toBe('still-here');
  });
});

test.describe('modal focus trap', () => {
  test('Tab stays inside ConfirmModal; Escape returns focus to the launcher', async ({ page }) => {
    await page.goto('/trip/1');
    const launcher = page.getByRole('button', { name: 'Delete Trip' });
    await launcher.click();

    const heading = page.getByRole('heading', { name: 'Delete trip' });
    await expect(heading).toBeVisible();

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focusInModal = await page.evaluate(
      () => document.activeElement?.closest('.cds--modal-container') != null,
    );
    expect(focusInModal).toBe(true);

    await page.keyboard.press('Escape');
    await expect(heading).toBeHidden();
    await expect(launcher).toBeFocused();
  });
});

test.describe('header live-status label', () => {
  test('shows "Sim not connected" against the agent-less scratch server, and never a stray label', async ({ page }) => {
    const tag = page.locator('[aria-live="polite"]');
    const allowedLabel = /^(Checking\.\.\.|Server unreachable|Sim not connected|Recording · .+|Paused · .+|Connected · Idle)$/;

    await page.goto('/');
    const seen = new Set<string>();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const text = (await tag.innerText()).trim();
      if (text) seen.add(text);
      await page.waitForTimeout(200);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const text of seen) expect(text).toMatch(allowedLabel);
    await expect(tag).toHaveText('Sim not connected');
  });

  test('shows "Connected · Idle" when the live stream opens with a connected, idle sim', async ({ page }) => {
    // The header reads status off the shared SSE stream now, not a poll —
    // route()-ing /api/status would never be consulted. A fake EventSource
    // installed before any page script runs stands in for the real stream:
    // it opens and emits one 'status' message, then goes quiet (never a
    // finite/closed body, which would flip the tag to "Server unreachable").
    const statusBody = {
      connected: true, flightState: 'IDLE', currentFlightId: null, aircraft: null,
      frame: null, paused: false, pauseFlags: 0,
    };
    await page.addInitScript((body: unknown) => {
      class FakeEventSource extends EventTarget {
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
            this.dispatchEvent(new MessageEvent('status', { data: JSON.stringify(body) }));
          }, 0);
        }
        close() {
          this.readyState = 2;
        }
      }
      (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    }, statusBody);

    await page.goto('/');
    await expect(page.locator('[aria-live="polite"]')).toHaveText('Connected · Idle');
  });
});

test.describe('PDF export round trip', () => {
  test('Export PDF on /flight/1 downloads a PDF with the expected filename', async ({ page }) => {
    await page.goto('/flight/1');
    await expect(page.getByRole('main').getByRole('heading', { name: /^Flight #1/ })).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export PDF' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('flight-1-efhk-eetn-2026-03-01.pdf');
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const header = fs.readFileSync(filePath as string).subarray(0, 4).toString('latin1');
    expect(header).toBe('%PDF');
  });
});

test.describe('session expiry', () => {
  test('a session lost mid-page bounces once to /login with no visible error banner', async ({ page }) => {
    // Armed before goto(), so nothing can be missed. Clearing cookies while
    // the stream's reconnect-refetch burst (Home, GroundSection, useNavTree)
    // is still in flight races it: a still-valid cookie can restore the
    // session on arrival via its own rolling Set-Cookie, or it can itself eat
    // the 401 and bounce early — either way the click below lands on a
    // non-deterministic page. ground-sessions/current's second response is
    // guaranteed (the provider fires every handler once on open), so it's a
    // deterministic finish line; every other request still in flight at that
    // point is then waited out by count, not a fixed delay.
    let inFlight = 0, eventsOpened = false, groundHits = 0;
    const isApi = (u: string) => u.includes('/api/') && !u.includes('/api/events');
    page.on('request', req => { if (isApi(req.url())) inFlight++; });
    page.on('requestfinished', req => {
      const url = req.url();
      if (isApi(url)) inFlight--;
      if (url.endsWith('/api/ground-sessions/current')) groundHits++;
    });
    page.on('requestfailed', req => { if (isApi(req.url())) inFlight--; });
    page.on('response', res => { if (res.url().includes('/api/events')) eventsOpened = true; });

    await page.goto('/');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Home' })).toBeVisible();
    await expect.poll(
      () => eventsOpened && groundHits >= 2 && inFlight === 0, { timeout: 5000 }
    ).toBe(true);

    // The server has already dropped the session; the client only finds out
    // on its next gated call. No full reload — a route change is enough to
    // fire useNavTree's fetch and the RequireAuth 401 handler with it.
    await page.context().clearCookies();
    await page.getByRole('link', { name: 'Prefiles' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

    // Settles at /login rather than bouncing back and forth.
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  });
});
