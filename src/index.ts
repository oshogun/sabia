import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, ConfigError } from './config';
import { initDb, closeDb, getAuthUser, sessionSweep, countActiveIngestTokens, countActiveMcpTokens } from './db';
import { ingestAuthMode } from './auth/ingestAuth';
import { mcpAuthMode } from './auth/mcpAuth';
import { openNavdata, closeNavDb, getLnmNavDb, setSelectedNavdataSource } from './navdata/connection';
import { readNavdataSourceSetting } from './navdata/source';
import { loadAirportTiers } from './navdata/airportTiers';
import { initAirports } from './airports';
import { ensureFlightPlansDir } from './flightPlans';
import { FlightManager } from './flightManager';
import { createServer } from './server';
import { armBodyDeadline } from './bodyDeadline';
import { cancelLnmImportForShutdown } from './routes/navdataImport';
import { warmAssets } from './staticAssets';
import { closeBrowser } from './pdfExport';

// Configuration is read and validated before anything else — before the
// database is opened, before any listener — so a misconfigured deployment
// writes nothing.
let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    // Some ConfigError messages (e.g. a bad SESSION_SECRET) already carry a
    // `[Config] ` prefix on every line; others are a single unprefixed line.
    // Prefix only the lines that don't already have it, so stderr always
    // ends up as one `[Config] ` line per sentence.
    for (const line of err.message.split('\n')) {
      console.error(line.startsWith('[Config]') ? line : `[Config] ${line}`);
    }
    process.exit(1);
  }
  throw err;
}

initDb();
console.log('[DB] Database ready');

// The navdata replica is optional and rebuildable from the sidecar: a missing
// file leaves a null handle, and a failed open is logged, never fatal.
try {
  openNavdata();
} catch (err) {
  console.warn(`[Navdata] Could not open the replica: ${(err as Error).message}`);
}
// The stored choice is read, never rewritten here: an unavailable Little Navmap
// file falls back to simulator data at read time, and a later import makes the
// choice effective again.
const navdataSource = readNavdataSourceSetting();
setSelectedNavdataSource(navdataSource);
if (navdataSource === 'lnm' && getLnmNavDb() === null) {
  console.warn('[Navdata] Little Navmap data is selected but unavailable; showing simulator data');
}
loadAirportTiers();

// The server refuses to start with no operator account — there is no HTTP
// setup flow.
const authUser = getAuthUser();
if (!authUser) {
  console.error('[Auth] Refusing to start: no operator account exists.');
  console.error('[Auth] Run `npm run set-password` to create one (README § First run).');
  process.exit(1);
}

// Only known once the database is open, so this runs after initDb() rather
// than as part of loadConfig() — a Settings-page token cannot be seen before
// that point.
const activeIngest = countActiveIngestTokens();
const ingestMode = ingestAuthMode(config.ingest, activeIngest);
if (ingestMode === 'closed') {
  console.warn('[Auth] WARNING: no ingest token exists (INGEST_TOKEN is unset and none has been created on the Settings page). Every ingest request will get 401 until you create one.');
} else if (ingestMode === 'ui_tokens' && config.ingest.token !== null) {
  console.log(`[Auth] ${activeIngest} ingest token(s) from the Settings page are enforced; INGEST_TOKEN is ignored.`);
} else if (ingestMode === 'ui_tokens' && config.ingest.allowUnauthenticated) {
  console.log(`[Auth] ${activeIngest} ingest token(s) from the Settings page are enforced; ALLOW_UNAUTHENTICATED_INGEST is ignored.`);
}
const activeMcp = countActiveMcpTokens();
if (mcpAuthMode(config.mcp, activeMcp) === 'ui_tokens' && config.mcp.token !== null) {
  console.log(`[Auth] ${activeMcp} MCP token(s) from the Settings page are enforced; MCP_TOKEN is ignored.`);
}

// Sweep expired sessions once at startup, then every 6 hours. The interval is
// unref'd so it never holds the process open at shutdown.
const sweptAtStartup = sessionSweep(Date.now());
if (sweptAtStartup > 0) {
  console.log(`[Auth] Swept ${sweptAtStartup} expired sessions`);
}
setInterval(() => {
  const swept = sessionSweep(Date.now());
  if (swept > 0) {
    console.log(`[Auth] Swept ${swept} expired sessions`);
  }
}, 6 * 60 * 60 * 1000).unref();

ensureFlightPlansDir();

// Non-blocking: airport data will be ready well before the first flight starts
initAirports().catch(err => console.warn('[Airports] Init error:', err));

// Flight data arrives from the MCDU client's sidecar (oshogun/sabia_mcdu),
// which connects to SimConnect locally and pushes frames to /api/ingest.
const flightManager = new FlightManager();
console.log('[Ingest] Waiting for agent data on /api/ingest');

const app = createServer(flightManager);

// One port, one protocol: HTTPS when TLS is configured, plaintext HTTP
// otherwise. There is no second listener redirecting HTTP to HTTPS.
//
// requestTimeout 0 turns off Node's server-wide limit on how long a request body
// may take, which would cut off the hour-long Little Navmap upload; the
// per-request deadline in bodyDeadline.ts puts the 300 s limit back on every
// other request. headersTimeout is set explicitly because Node derives its
// default from requestTimeout, and 0 would also turn off the header timeout.
const timeouts = { requestTimeout: 0, headersTimeout: 60_000 };
let server: http.Server | https.Server;
if (config.tls.enabled) {
  const key = fs.readFileSync(config.tls.keyFile);
  const cert = fs.readFileSync(config.tls.certFile);
  server = https.createServer(
    { key, cert, passphrase: config.tls.passphrase ?? undefined, ...timeouts },
    app
  );
} else {
  server = http.createServer(timeouts, app);
}
// Before Express, so the deadline covers every route and no middleware order changes.
server.prependListener('request', armBodyDeadline);

server.listen(config.port, config.bindHost, () => {
  const scheme = config.tls.enabled ? 'https' : 'http';
  console.log(`[HTTP] Server running at ${scheme}://${config.bindHost}:${config.port}`);
  // Fire-and-forget: primes the compressed-asset cache so the first real
  // request for each JS/CSS asset isn't the one paying for the brotli pass.
  warmAssets(path.join(process.cwd(), 'client', 'dist')).catch(() => {});
});

// The time PDF export gets at shutdown to finish a render already in progress
// and close its browser; a browser still running after it is killed. Shorter
// than the 3 s backup exit below, so the kill and the removal of the browser's
// profile directory normally finish before that timer ends the process.
const BROWSER_CLOSE_LIMIT_MS = 2500;

// Close the database on the way out so the WAL is checkpointed back into
// flights.db; otherwise a hard kill can strand recent flights in the -wal file.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // First, so an upload in flight does not hold server.close() open. Awaited
    // before the databases close: the checkpoint's sync would otherwise wait
    // for the disk to finish writing the discarded build, and the build's files
    // are removed only once its worker has exited.
    const importStopped = cancelLnmImportForShutdown();
    console.log(`\n[Shutdown] ${signal} — closing database...`);
    const browserClosed = closeBrowser(BROWSER_CLOSE_LIMIT_MS);
    server.close(async () => {
      await Promise.all([browserClosed, importStopped]);
      closeNavDb();
      closeDb();
      console.log('[Shutdown] Clean.');
      process.exit(0);
    });
    // Don't hang forever on lingering keep-alive connections
    setTimeout(() => { closeNavDb(); closeDb(); process.exit(0); }, 3000).unref();
  });
}
