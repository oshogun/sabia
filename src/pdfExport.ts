import fs from 'fs';
import os from 'os';
import { basename, dirname, join, resolve } from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { getConfig } from './config';

const READY_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;
const BROWSER_IDLE_SHUTDOWN_MS = 5 * 60_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
// An idle-timer close still in progress, so a shutdown that starts meanwhile
// can wait for it.
let idleClose: Promise<void> | null = null;
// The browser that idle close is closing, so shutdown can kill it if the close
// has not finished by the shutdown limit.
let idleClosingBrowser: Browser | null = null;
// Set by closeBrowser() when the server shuts down. From then on no browser is
// launched, so an export queued behind the one rendering fails at once instead
// of starting a Chromium that only the process exit would stop.
let shuttingDown = false;

// The browser each launch resolved to, once it has. Shutdown uses it to tell a
// running browser from one still launching without waiting on the launch.
const startedBrowsers = new WeakMap<Promise<Browser>, Browser>();

// Each Chromium gets a profile directory created here rather than by
// puppeteer: puppeteer only removes its own directory after an orderly
// close(), so a Chromium killed at shutdown would leave it in the temp
// directory. These are the directories created and not yet removed.
const profileDirs = new Set<string>();
const profileDirOf = new WeakMap<Browser, string>();
// One removal per browser, shared by every path that ends it (idle close,
// shutdown close or kill, an unexpected disconnect).
const profileRemovals = new WeakMap<Browser, Promise<void>>();

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

function shutdownError(): Error {
  return new Error('PDF export unavailable: the server is shutting down');
}

function trackProfileDir(dir: string): void {
  // The 'exit' listener is only attached while a directory exists, so it does
  // not pile up on the process.
  if (profileDirs.size === 0) process.on('exit', removeLeftoverProfileDirs);
  profileDirs.add(dir);
}

// Chromium keeps its singleton socket in a directory of its own,
// os.tmpdir()/org.chromium.Chromium.XXXXXX, and links to it from the profile
// as SingletonSocket. It removes that directory when it exits normally, not
// when it is killed. Returns the directory only if the link points directly
// under the temp directory to a name of that form, so a link anywhere else is
// never followed into a removal.
function chromiumSocketDir(profileDir: string, linkTarget: string): string | null {
  const dir = dirname(resolve(profileDir, linkTarget));
  if (dirname(dir) !== resolve(os.tmpdir())) return null;
  return basename(dir).startsWith('org.chromium.Chromium.') ? dir : null;
}

async function removeChromiumSocketDir(profileDir: string): Promise<void> {
  try {
    const dir = chromiumSocketDir(profileDir, await fs.promises.readlink(join(profileDir, 'SingletonSocket')));
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  } catch { /* no link (Chromium closed normally or never started), or already removed */ }
}

async function removeProfileDir(dir: string): Promise<void> {
  await removeChromiumSocketDir(dir);
  try {
    // The retries cover Chromium helper processes that are still writing into
    // the directory for a moment after the main process was killed.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    // Left in profileDirs, so the 'exit' listener tries again.
    console.warn(`[PDF] Could not remove browser profile ${dir}:`, err instanceof Error ? err.message : err);
    return;
  }
  profileDirs.delete(dir);
  if (profileDirs.size === 0) process.off('exit', removeLeftoverProfileDirs);
}

// Runs when the process exits with a profile directory still present: the
// 3 s backup exit in the shutdown handler, or a launch that finished after
// shutdown gave up on it. Only synchronous work runs in an 'exit' listener.
function removeLeftoverProfileDirs(): void {
  for (const dir of profileDirs) {
    try {
      const socketDir = chromiumSocketDir(dir, fs.readlinkSync(join(dir, 'SingletonSocket')));
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
    } catch { /* no link, or already removed */ }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* the process is exiting; nothing else to try */ }
  }
  profileDirs.clear();
}

function processExited(browser: Browser): Promise<void> {
  const proc = browser.process();
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => proc.once('exit', () => resolve()));
}

/**
 * Removes a browser's profile directory once its Chromium process has exited,
 * so a dying Chromium cannot write into it again. Every caller for the same
 * browser shares the one removal.
 */
function removeBrowserProfile(browser: Browser): Promise<void> {
  let removal = profileRemovals.get(browser);
  if (!removal) {
    const dir = profileDirOf.get(browser);
    removal = dir ? processExited(browser).then(() => removeProfileDir(dir)) : Promise.resolve();
    profileRemovals.set(browser, removal);
  }
  return removal;
}

async function launchBrowser(): Promise<Browser> {
  const profileDir = await fs.promises.mkdtemp(join(os.tmpdir(), 'msfslogger-pdf-profile-'));
  trackProfileDir(profileDir);
  // Shutdown may have started while the directory was being created.
  if (shuttingDown) {
    await removeProfileDir(profileDir);
    throw shutdownError();
  }
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      userDataDir: profileDir,
      // The loopback render targets this server's own HTTPS listener, whose
      // certificate is typically self-signed and issued for the LAN name
      // rather than 127.0.0.1. Both would abort the navigation otherwise, and
      // the browser only ever loads our own pages — the same rationale as
      // --no-sandbox below.
      acceptInsecureCerts: true,
      // Puppeteer's own SIGINT, SIGTERM and SIGHUP listeners all close Chrome
      // without waiting for the server's shutdown handler (database close,
      // the wait for an export in progress, browser close), and the SIGINT
      // one also calls process.exit(130) before the database is closed. The
      // server's own handler in index.ts covers all three signals.
      // Puppeteer's process 'exit' listener still kills Chrome on any exit.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // Ubuntu 24.04's AppArmor policy blocks unprivileged user namespaces,
      // which breaks Chromium's sandbox. We only ever load our own localhost
      // pages, so disabling it is acceptable here.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
      ],
    });
  } catch (err) {
    await removeProfileDir(profileDir);
    throw err;
  }
  profileDirOf.set(browser, profileDir);
  return browser;
}

function getBrowser(): Promise<Browser> {
  if (shuttingDown) return Promise.reject(shutdownError());
  if (!browserPromise) {
    console.log('[PDF] Launching headless browser...');
    const launched: Promise<Browser> = launchBrowser().then(browser => {
      startedBrowsers.set(launched, browser);
      browser.on('disconnected', () => {
        // If Chromium dies, drop the handle so the next export relaunches
        // instead of failing forever against a dead connection. Compared by
        // identity: a close already replaced or cleared the handle, and this
        // must not clear a newer launch's.
        if (browserPromise === launched) {
          console.warn('[PDF] Browser disconnected — will relaunch on next export');
          browserPromise = null;
        }
        void removeBrowserProfile(browser);
      });
      return browser;
    });
    browserPromise = launched;
  }
  return browserPromise;
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleClose = closeIdleBrowser(); }, BROWSER_IDLE_SHUTDOWN_MS);
  // Don't hold the process open just for the idle timer
  idleTimer.unref?.();
}

/** Closes a browser left unused for BROWSER_IDLE_SHUTDOWN_MS, then removes its profile. */
async function closeIdleBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  idleTimer = null;
  try {
    if (!pending) return;
    const browser = await pending;
    idleClosingBrowser = browser;
    try {
      await browser.close();
      console.log('[PDF] Headless browser closed');
    } catch {
      // Already gone; the profile removal below waits for the process to exit
    }
    await removeBrowserProfile(browser);
  } catch {
    // The launch failed and already removed its profile directory
  } finally {
    idleClose = null;
    idleClosingBrowser = null;
  }
}

/**
 * Shuts PDF export down for a server that is about to exit. No browser is
 * launched from here on. Within one `limitMs` budget, the render already in
 * progress is allowed to finish and the browser is then closed; whatever has
 * not finished when the budget runs out is ended by killing the Chromium
 * process. Resolves once the browser's profile directory has been removed, or
 * at the limit if the browser is still launching (it is killed and its profile
 * removed when the launch finishes). Never rejects.
 */
export async function closeBrowser(limitMs: number): Promise<void> {
  shuttingDown = true;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // The render running now, plus any queued behind it, which fail at once in
  // getBrowser() now that shuttingDown is set.
  const renders = queue;
  const closing = idleClose;

  let limitTimer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>(resolve => {
    limitTimer = setTimeout(() => resolve('timeout'), limitMs);
  });

  // Set when an idle close has not finished by the limit and its browser is killed.
  let idleKilled: Promise<void> | null = null;

  try {
    let outcome = await Promise.race([renders.then(() => 'rendered' as const), limit]);
    // An idle close started before shutdown: the browser it holds is no
    // longer in browserPromise, so wait for that close instead.
    if (closing && outcome !== 'timeout') {
      outcome = await Promise.race([closing.then(() => 'rendered' as const), limit]);
    }
    const stillClosing = idleClosingBrowser;
    if (stillClosing && outcome === 'timeout') {
      console.warn(`[PDF] Idle browser did not close within ${limitMs} ms — killing it`);
      stillClosing.process()?.kill('SIGKILL');
      idleKilled = removeBrowserProfile(stillClosing);
    }

    const pending = browserPromise;
    browserPromise = null;
    if (!pending) return;

    let browser = startedBrowsers.get(pending);
    if (!browser && outcome !== 'timeout') {
      const launched = await Promise.race([pending.catch(() => null), limit]);
      if (launched === null) return; // the failed launch removed its own profile
      if (launched !== 'timeout') browser = launched;
    }
    if (!browser) {
      console.warn(`[PDF] Browser still launching after ${limitMs} ms — it will be killed once started`);
      pending
        .then(started => {
          started.process()?.kill('SIGKILL');
          return removeBrowserProfile(started);
        })
        .catch(() => { /* the failed launch removed its own profile */ });
      return;
    }

    if (outcome === 'timeout') {
      console.warn(`[PDF] Export still rendering after ${limitMs} ms — killing the browser`);
      browser.process()?.kill('SIGKILL');
    } else {
      // A rejected close() counts as not closed: the process may still be
      // running, and the profile removal below waits for it to exit.
      const closed = browser.close().then(() => 'closed' as const, () => 'failed' as const);
      const closeOutcome = await Promise.race([closed, limit]);
      if (closeOutcome === 'timeout') {
        console.warn(`[PDF] Browser did not close within ${limitMs} ms — killing it`);
        browser.process()?.kill('SIGKILL');
      } else if (closeOutcome === 'failed') {
        console.warn('[PDF] Browser close failed — killing it');
        browser.process()?.kill('SIGKILL');
      } else {
        console.log('[PDF] Headless browser closed');
      }
    }
    await removeBrowserProfile(browser);
  } catch {
    // Nothing above is expected to throw; this keeps closeBrowser from
    // rejecting, because the shutdown handler closes the database after it.
  } finally {
    clearTimeout(limitTimer);
    if (idleKilled) await idleKilled;
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
    // Not during shutdown, which closes the browser itself
    if (!shuttingDown) touchIdleTimer();
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
