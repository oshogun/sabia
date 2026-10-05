// tests/pdfExport.shutdown.test.ts
//
// closeBrowser with a time limit, against a mocked puppeteer. A browser is
// launched through the exported renderPdf; the mocked page fails the render
// right away, which is enough to leave the launched browser in place.

import { afterEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('puppeteer', () => ({ default: { launch } }));

import { closeBrowser, renderPdf } from '../src/pdfExport';

// Set so baseUrl() does not read the application config, which is not loaded here.
process.env.EXPORT_BASE_URL = 'http://127.0.0.1:1';

function makeBrowser(close: () => Promise<void>) {
  const kill = vi.fn();
  const page = {
    setDefaultNavigationTimeout: vi.fn(),
    setViewport: vi.fn(),
    emulateMediaType: vi.fn(),
    setUserAgent: vi.fn(),
    setCookie: vi.fn(),
    goto: vi.fn().mockRejectedValue(new Error('stop here')),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    on: vi.fn(),
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn(close),
    process: vi.fn(() => ({ kill })),
  };
  return { browser, kill };
}

async function launchMocked(close: () => Promise<void>) {
  const made = makeBrowser(close);
  launch.mockResolvedValue(made.browser);
  await expect(renderPdf('/x')).rejects.toThrow('stop here');
  return made;
}

afterEach(async () => {
  vi.useRealTimers();
  launch.mockReset();
  await closeBrowser(1);
});

describe('browser launch options', () => {
  it('leaves SIGINT and SIGTERM to the server and SIGHUP at its default', async () => {
    await launchMocked(() => Promise.resolve());
    const opts = launch.mock.calls[0][0];
    expect(opts.handleSIGINT).toBe(false);
    expect(opts.handleSIGTERM).toBe(false);
    expect(opts.handleSIGHUP).not.toBe(false);
  });
});

describe('closeBrowser with a time limit', () => {
  it('closes a browser that quits normally and does not kill it', async () => {
    const { browser, kill } = await launchMocked(() => Promise.resolve());
    await expect(closeBrowser(1500)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills the Chromium process when close() does not finish in time', async () => {
    const { browser, kill } = await launchMocked(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    const done = closeBrowser(1500);
    await vi.advanceTimersByTimeAsync(1499);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves at once when no browser was launched', async () => {
    vi.useFakeTimers();
    await expect(closeBrowser(1500)).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
