import fs from 'fs';
import puppeteer, { Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { getConfig } from './config';

const READY_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;
const BROWSER_IDLE_SHUTDOWN_MS = 5 * 60_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

// Renders are serialised: each Chromium page holds a full map + tiles, and
// several at once is a real memory spike on a small box.
let queue: Promise<unknown> = Promise.resolve();

/** The session cookie forwarded into the headless render. */
export interface RenderOptions {
  sessionCookie?: { name: string; value: string };
}

export function baseUrl(): string {
  // Overridable so dev can point at the Vite server (:5173) instead of the
  // Express server, which only ever serves the last built client/dist. The
  // override keeps its precedence; only the derived default changed, and only
  // to follow the scheme the server is actually listening on.
  const scheme = () => (getConfig().tls.enabled ? 'https' : 'http');
  return process.env.EXPORT_BASE_URL ?? `${scheme()}://127.0.0.1:${process.env.PORT ?? '3000'}`;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    console.log('[PDF] Launching headless browser...');
    browserPromise = puppeteer.launch({
      // The loopback render targets this server's own HTTPS listener, whose
      // certificate is typically self-signed and issued for the LAN name
      // rather than 127.0.0.1. Both would abort the navigation otherwise, and
      // the browser only ever loads our own pages — the same rationale as
      // --no-sandbox below.
      acceptInsecureCerts: true,
      // Puppeteer's own SIGINT/SIGTERM handlers kill Chrome and call
      // process.exit(130) at once, which would skip the server's shutdown
      // handler (database close, browser close). Its process 'exit' listener
      // still kills Chrome on any exit. SIGHUP keeps the default; the server
      // does not handle it.
      handleSIGINT: false,
      handleSIGTERM: false,
      // Ubuntu 24.04's AppArmor policy blocks unprivileged user namespaces,
      // which breaks Chromium's sandbox. We only ever load our own localhost
      // pages, so disabling it is acceptable here.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
      ],
    }).then(browser => {
      // If Chromium dies, drop the handle so the next export relaunches
      // instead of failing forever against a dead connection.
      browser.on('disconnected', () => {
        if (browserPromise) {
          console.warn('[PDF] Browser disconnected — will relaunch on next export');
          browserPromise = null;
        }
      });
      return browser;
    });
  }
  return browserPromise;
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void closeBrowser(); }, BROWSER_IDLE_SHUTDOWN_MS);
  // Don't hold the process open just for the idle timer
  idleTimer.unref?.();
}

/**
 * Closes the headless browser. With `limitMs`, a close that has not finished
 * in that time is abandoned and the Chromium process is killed instead, so a
 * caller that is about to exit is not held up by a browser that will not quit.
 */
export async function closeBrowser(limitMs?: number): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!pending) return;
  try {
    const browser = await pending;
    if (limitMs === undefined) {
      await browser.close();
    } else {
      let limitTimer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>(resolve => {
        limitTimer = setTimeout(() => resolve('timeout'), limitMs);
      });
      const closed = browser.close().then(() => 'closed' as const);
      try {
        const outcome = await Promise.race([closed, timedOut]);
        if (outcome === 'timeout') {
          console.warn(`[PDF] Browser did not close within ${limitMs} ms — killing it`);
          browser.process()?.kill('SIGKILL');
          // A late rejection of the abandoned close() is expected; ignore it.
          closed.catch(() => {});
          return;
        }
      } finally {
        clearTimeout(limitTimer);
      }
    }
    console.log('[PDF] Headless browser closed');
  } catch {
    // Already gone — nothing to clean up
  }
}

async function renderOnce(path: string, opts: RenderOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // A4 at 96dpi. Combined with the fixed-width .print-root (see print.css),
    // this makes the on-screen layout identical to the layout inside the paper
    // content box. That matters: page.pdf() re-lays out the document at paper
    // width, and if the maps changed size Leaflet would request a fresh set of
    // tiles *after* we saw __EXPORT_READY__ — producing half-blank maps that
    // page.pdf() does not wait for.
    await page.setViewport({ width: 794, height: 1123 });
    await page.emulateMediaType('print');
    // Identify ourselves per the OSM tile usage policy
    await page.setUserAgent('msfslogger-pdf-export/1.0 (+https://github.com/oshogun/msfslogger)');

    const base = baseUrl();

    // The print page fetches its data from /api, which is behind the auth gate
    // — without the caller's own session cookie every export would fail with
    // "Authentication required". It goes in through the cookie jar and never
    // as a blanket extra request header: this scopes it to our own host, so it
    // is not attached to the OSM tile requests the print maps make.
    if (opts.sessionCookie) {
      const u = new URL(base);
      await page.setCookie({
        name: opts.sessionCookie.name,
        value: opts.sessionCookie.value,
        domain: u.hostname,
        path: '/',
        httpOnly: true,
        secure: u.protocol === 'https:',
        sameSite: 'Lax',
      });
    }

    const url = `${base}${path}`;
    console.log(`[PDF] Rendering ${url}`);
    // Not networkidle: the print pages fetch map tiles lazily and would never
    // look idle, so we wait on an explicit flag the page sets once its maps
    // have settled.
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    try {
      await page.waitForFunction(
        'window.__EXPORT_READY__ === true || typeof window.__EXPORT_ERROR__ === "string"',
        { timeout: READY_TIMEOUT_MS, polling: 200 }
      );
    } catch {
      // Deliberately non-fatal: a map missing a few tiles is a far better
      // outcome than failing the whole export on a slow tile server.
      console.warn('[PDF] Readiness timeout — capturing current state anyway');
    }

    // String form: this runs in the browser, but the server tsconfig has no DOM lib
    const pageError = await page.evaluate('window.__EXPORT_ERROR__ ?? null') as string | null;
    if (pageError) throw new Error(pageError);

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,   // honour @page in print.css
    });

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => { /* page may already be gone */ });
    touchIdleTimer();
  }
}

/** Renders a print route to PDF. Calls are serialised across the process. */
export function renderPdf(path: string, opts?: RenderOptions): Promise<Buffer> {
  const result = queue.then(() => renderOnce(path, opts));
  // Keep the chain alive even if this render rejects
  queue = result.catch(() => undefined);
  return result;
}

/**
 * Appends existing PDF files (attached flight plans) after the generated pages.
 * Unreadable or corrupt attachments are skipped rather than failing the export.
 */
export async function appendPdfs(base: Buffer, attachmentPaths: string[]): Promise<Buffer> {
  const usable = attachmentPaths.filter(p => fs.existsSync(p));
  if (usable.length === 0) return base;

  const doc = await PDFDocument.load(base);

  for (const p of usable) {
    try {
      // ignoreEncryption: flight plans exported from SimBrief/Navigraph are
      // frequently flagged as encrypted-with-empty-password, which makes a
      // plain load() throw even though the content is readable.
      const attachment = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
      const pages = await doc.copyPages(attachment, attachment.getPageIndices());
      pages.forEach(page => doc.addPage(page));
    } catch (err) {
      // One bad attachment must degrade to "plan omitted", never fail the export
      console.warn(`[PDF] Skipping unreadable attachment ${p}:`, err instanceof Error ? err.message : err);
    }
  }

  doc.setProducer('msfslogger');
  doc.setCreationDate(new Date());

  return Buffer.from(await doc.save());
}
