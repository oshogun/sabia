// An ephemeral express app around the real sync router, a scratch flights.db
// and a scratch replica directory. Synthetic idents only.

import express from 'express';
import http from 'http';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavdataSyncRouter } from '../src/routes/navdataSync';
import { createNavdataRouter } from '../src/routes/navdata';
import { snapshotUploadDir } from '../src/routes/uploads';
import { SidecarStateStore } from '../src/navdata/sidecarState';
import { closeNavDb, getNavDb, openNavdata, resolveNavdataPath } from '../src/navdata/connection';
import { upsertNavdataRequest } from '../src/db/navdataRequests';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';
import { scratchDbRoot } from './helpers/scratchRoot';
import { createSettingsRouter } from '../src/routes/settings';
import { getLnmNavDb, resolveLnmNavdataPath, setSelectedNavdataSource } from '../src/navdata/connection';
import { LNM_DATASET_DDL } from '../src/navdata/dataset';
import { applyNavdataSchema } from '../src/navdata/schema';
import { getSetting } from '../src/db/settings';
import { listNavdataRequests } from '../src/db/navdataRequests';
import { createHash } from 'crypto';
import { createRouteGeometryRouter } from '../src/routes/navdataRouteGeometry';
import { seedPlannedLeg } from './helpers/db';

const TOKEN = 'test-ingest-token';
const savedEnv = process.env.NAVDATA_DB_PATH;

let scratch: ScratchDb;
let dir: string;
let server: Server;
let base: string;
let state: SidecarStateStore;

function header(snapshotId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'header', v: 1, schemaVersion: 2, snapshotId, rev: 5, simId: '2024',
    simAppName: 'Test Sim', simAppVersion: '1.0', sidecarVersion: '0.0.1-test',
    createdAt: 1_700_000_000_000, counts: {}, ...extra,
  };
}

function snapshotFile(snapshotId: string, opts: { footerRows?: number; truncate?: boolean } = {}): string {
  const rows = [
    { t: 'airport', r: { ident: 'ZZAA', name: 'Zulu Alpha Field', lat: 10, lon: 20, position_source: 'list', rev: 1 } },
    { t: 'airport', r: { ident: 'ZZAB', name: 'Zulu Bravo Field', lat: 11, lon: 21, position_source: 'list', rev: 1 } },
  ];
  const footer = { kind: 'footer', rows: opts.footerRows ?? rows.length, counts: { airport: rows.length } };
  const text = [header(snapshotId), ...rows, footer].map(o => JSON.stringify(o)).join('\n') + '\n';
  let gz = zlib.gzipSync(text);
  if (opts.truncate) gz = gz.subarray(0, Math.floor(gz.length / 2));
  const file = path.join(dir, `navdata-${snapshotId}.ndjson.gz`);
  fs.writeFileSync(file, gz);
  return file;
}

async function postSnapshot(file: string, token: string | null = TOKEN): Promise<Response> {
  const form = new FormData();
  form.append('navdataSnapshot', new Blob([fs.readFileSync(file)], { type: 'application/gzip' }), path.basename(file));
  return fetch(`${base}/api/navdata/snapshot`, {
    method: 'POST', body: form, headers: token ? { 'x-ingest-token': token } : {},
  });
}

const postJson = (p: string, body: unknown, token: string | null = TOKEN) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ingest-token': token } : {}) },
    body: JSON.stringify(body),
  });

const airports = (): string[] =>
  (getNavDb()!.prepare('SELECT ident FROM nav_airport ORDER BY ident').all() as { ident: string }[]).map(r => r.ident);

const uploadTemps = (): string[] => {
  const d = snapshotUploadDir();
  return d && fs.existsSync(d) ? fs.readdirSync(d) : [];
};

beforeEach(async () => {
  scratch = createScratchDb();
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-routes-'));
  process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
  openNavdata();
  state = new SidecarStateStore();

  const app = express();
  app.use('/api/navdata/rows', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.post('/api/other', (_req, res) => { res.json({ ok: true }); });
  app.use('/api/navdata', createNavdataSyncRouter({ token: TOKEN, allowUnauthenticated: false }, state));
  app.get('/api/navdata/features', (_req, res) => { res.status(401).json({ error: 'session' }); });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeNavDb();
  destroyScratchDb(scratch);
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

describe('token gate', () => {
  it('rejects a missing or wrong token on every sync route, and falls through for other paths', async () => {
    expect((await postJson('/api/navdata/rows', {}, null)).status).toBe(401);
    expect((await postJson('/api/navdata/state', {}, 'nope')).status).toBe(401);
    expect((await postSnapshot(snapshotFile('s1'), null)).status).toBe(401);
    expect((await fetch(`${base}/api/navdata/demand`)).status).toBe(401);
    // The router has no router-level gate: a path it does not own reaches the next handler.
    expect((await fetch(`${base}/api/navdata/features`)).status).toBe(401);
    expect((await (await fetch(`${base}/api/navdata/features`)).json())).toEqual({ error: 'session' });
  });
});

describe('POST /snapshot', () => {
  it('imports a snapshot, acks it, and deletes the temp upload', async () => {
    const res = await postSnapshot(snapshotFile('s1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, snapshotId: 's1', rev: 5, counts: { airport: 2 } });
    expect(airports()).toEqual(['ZZAA', 'ZZAB']);
    await new Promise(r => setTimeout(r, 50));
    expect(uploadTemps()).toEqual([]);
  });

  it('a truncated or wrong-footer upload leaves the previous replica intact', async () => {
    expect((await postSnapshot(snapshotFile('s1'))).status).toBe(200);
    const bad = await postSnapshot(snapshotFile('s2', { footerRows: 9 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false, code: 'NAVDATA_BAD_BATCH' });
    expect((await postSnapshot(snapshotFile('s3', { truncate: true }))).status).toBe(400);
    const meta = getNavDb()!.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string };
    expect(meta.s).toBe('s1');
    expect(airports()).toEqual(['ZZAA', 'ZZAB']);
    await new Promise(r => setTimeout(r, 50));
    expect(uploadTemps()).toEqual([]);
    expect(fs.readdirSync(dir).filter(n => n.includes('.incoming-'))).toEqual([]);
  });
});

describe('POST /rows', () => {
  const batch = (snapshotId: string, rows: unknown[], toRev = 6) =>
    ({ v: 1, schemaVersion: 2, snapshotId, fromRev: 5, toRev, rows, more: false });

  it('answers 409 NAVDATA_SNAPSHOT_MISMATCH with no replica', async () => {
    const res = await postJson('/api/navdata/rows', batch('s1', []));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NAVDATA_SNAPSHOT_MISMATCH', serverSnapshotId: null });
  });

  it('applies a batch, reports it, and marks the rows time', async () => {
    await postSnapshot(snapshotFile('s1'));
    expect(state.lastRowsAt()).toBeNull();
    const res = await postJson('/api/navdata/rows', batch('s1', [
      { t: 'airport', r: { ident: 'ZZAC', name: 'Zulu Charlie', lat: 12, lon: 22, position_source: 'list', rev: 6 } },
    ]));
    expect(await res.json()).toEqual({ ok: true, snapshotId: 's1', rev: 6, applied: 1 });
    expect(airports()).toContain('ZZAC');
    expect(state.lastRowsAt()).not.toBeNull();
  });

  it('answers a constraint-violating row with 400 and rolls the whole batch back', async () => {
    await postSnapshot(snapshotFile('s1'));
    const res = await postJson('/api/navdata/rows', batch('s1', [
      { t: 'airport', r: { ident: 'ZZAC', name: 'Zulu Charlie', lat: 12, lon: 22, position_source: 'list', rev: 6 } },
      { t: 'runway', r: { rwy_key: 'NOSUCH|9|0', airport_ident: 'NOSUCH', heading_deg: 90, length_m: 2000, rev: 6 } },
    ]));
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; message: string };
    expect(body.code).toBe('NAVDATA_BAD_BATCH');
    expect(body.message).toContain('runway');
    expect(airports()).not.toContain('ZZAC');
    expect(state.lastRowsAt()).toBeNull();
  });

  it('does not mark the rows time when the batch is refused', async () => {
    await postSnapshot(snapshotFile('s1'));
    expect((await postJson('/api/navdata/rows', batch('other', []))).status).toBe(409);
    expect((await postJson('/api/navdata/rows', batch('s1', [{ t: 'nope', r: {} }]))).status).toBe(400);
    expect(state.lastRowsAt()).toBeNull();
  });

  it('accepts a ~1 MiB body here while the 100 kb limit still holds elsewhere', async () => {
    await postSnapshot(snapshotFile('s1'));
    const pad = 'x'.repeat(1024 * 1024);
    expect((await postJson('/api/navdata/rows', { ...batch('s1', []), pad })).status).toBe(200);
    expect((await postJson('/api/other', { pad })).status).toBe(413);
  });
});

describe('GET /demand and POST /state', () => {
  it('serves demand with no replica present', async () => {
    const res = await fetch(`${base}/api/navdata/demand`, { headers: { 'x-ingest-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ v: 1, airports: [], waypoints: [], more: false });
  });

  it('excludes the idents named in skipAirports and skipWaypoints', async () => {
    const get = (qs: string, token: string | null = TOKEN) =>
      fetch(`${base}/api/navdata/demand${qs}`, { headers: token ? { 'x-ingest-token': token } : {} });
    upsertNavdataRequest('A', 'ZZREQ', null, new Date());

    expect(((await (await get('')).json()) as any).airports).toEqual(['ZZREQ']);
    const skipped = await get('?skipAirports=zzreq,,ZZREQ&skipWaypoints=ZZFIX');
    expect(skipped.status).toBe(200);
    expect(((await skipped.json()) as any).airports).toEqual([]);
    // The request row survives being skipped.
    expect(((await (await get('')).json()) as any).airports).toEqual(['ZZREQ']);
  });

  it('reads a skip list the way URLSearchParams sends it, comma percent-encoded', async () => {
    upsertNavdataRequest('A', 'ZZAB', null, new Date());
    upsertNavdataRequest('A', 'ZZAC', null, new Date());
    upsertNavdataRequest('W', 'ZZFIX', null, new Date());
    const get = async (qs: string) => {
      const res = await fetch(`${base}/api/navdata/demand${qs}`, { headers: { 'x-ingest-token': TOKEN } });
      expect(res.status, qs).toBe(200);
      return (await res.json()) as any;
    };
    const encoded = new URLSearchParams({ skipAirports: 'ZZAB,ZZAC', skipWaypoints: 'ZZFIX' }).toString();
    expect(encoded).toContain('ZZAB%2CZZAC');
    expect(await get(`?${encoded}`)).toMatchObject({ airports: [], waypoints: [] });
    expect(await get('?skipAirports=ZZAB%2CZZAC')).toMatchObject({ airports: [], waypoints: [{ ident: 'ZZFIX', kind: 'W' }] });
    expect(await get('?skipAirports=ZZAB,ZZAC')).toMatchObject({ airports: [] });
    expect((await get('?skipAirports=ZZAB')).airports).toEqual(['ZZAC']);
  });

  it('accepts a sorted, de-duplicated list of exactly 200 idents encoded with %2C', async () => {
    const idents = Array.from({ length: 200 }, (_, i) => `ZZ${String(i).padStart(3, '0')}`).sort();
    const qs = new URLSearchParams({ skipAirports: idents.join(',') }).toString();
    expect(qs).toContain('%2C');
    const res = await fetch(`${base}/api/navdata/demand?${qs}`, { headers: { 'x-ingest-token': TOKEN } });
    expect(res.status).toBe(200);
    const over = new URLSearchParams({ skipAirports: [...idents, 'ZZ200'].join(',') }).toString();
    expect((await fetch(`${base}/api/navdata/demand?${over}`, { headers: { 'x-ingest-token': TOKEN } })).status).toBe(400);
  });

  it('answers a malformed or oversized skip list with 400 NAVDATA_BAD_BATCH', async () => {
    const get = (qs: string) => fetch(`${base}/api/navdata/demand${qs}`, { headers: { 'x-ingest-token': TOKEN } });
    const tooMany = Array.from({ length: 201 }, (_, i) => `ZZ${i}`).join(',');
    for (const qs of ['?skipAirports=ZZ-AA', '?skipWaypoints=ZZAAAAAAA', `?skipAirports=${tooMany}`,
      '?skipAirports=ZZA&skipAirports=ZZB']) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ ok: false, code: 'NAVDATA_BAD_BATCH' });
      expect(body.message).toMatch(/skip(Airports|Waypoints)/);
    }
  });

  it('still requires the ingest token when a skip list is sent', async () => {
    expect((await fetch(`${base}/api/navdata/demand?skipAirports=ZZAA`)).status).toBe(401);
    expect((await fetch(`${base}/api/navdata/demand?skipAirports=ZZ-AA`)).status).toBe(401);
  });

  it('answers a state report with exactly 204 and stores it', async () => {
    const res = await postJson('/api/navdata/state', {
      v: 1, state: 'nav.ready', reason: null, snapshotId: 's1', rev: 3, sentAt: 1,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(state.read()).toMatchObject({ state: 'nav.ready', snapshotId: 's1', rev: 3 });
  });

  it('rejects an unknown state with 400 and stores nothing', async () => {
    const res = await postJson('/api/navdata/state', { v: 1, state: 'nav.weird' });
    expect(res.status).toBe(400);
    expect(state.read()).toBeNull();
  });
});

describe('batches during a snapshot import', () => {
  it('are refused for the whole import, and accepted once the swap has landed', async () => {
    await postSnapshot(snapshotFile('s1'));
    const batch = { v: 1, schemaVersion: 2, snapshotId: 's1', fromRev: 5, toRev: 6, rows: [], more: false };

    // Hold a snapshot upload open by sending only part of the multipart body.
    const boundary = 'testboundary';
    const gz = fs.readFileSync(snapshotFile('s2'));
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="navdataSnapshot"; filename="s2.gz"\r\n` +
      'Content-Type: application/gzip\r\n\r\n',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const url = new URL(base);
    const req = http.request({
      host: url.hostname, port: url.port, path: '/api/navdata/snapshot', method: 'POST',
      headers: {
        'x-ingest-token': TOKEN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': head.length + gz.length + tail.length,
      },
    });
    const done = new Promise<number>((resolve, reject) => {
      req.on('response', r => { r.resume(); resolve(r.statusCode ?? 0); });
      req.on('error', reject);
    });
    req.write(head);
    req.write(gz.subarray(0, 10));
    await new Promise(r => setTimeout(r, 100));

    const mid = await postJson('/api/navdata/rows', batch);
    expect(mid.status).toBe(503);
    expect(mid.headers.get('retry-after')).toBe('2');
    expect(await mid.json()).toMatchObject({ ok: false, code: 'NAVDATA_BUSY' });
    expect(state.lastRowsAt()).toBeNull();

    req.write(gz.subarray(10));
    req.end(tail);
    expect(await done).toBe(200);

    const after = await postJson('/api/navdata/rows', { ...batch, snapshotId: 's2' });
    expect(after.status).toBe(200);
  });

  it('release the hold when the upload itself is refused', async () => {
    const bad = await fetch(`${base}/api/navdata/snapshot`, {
      method: 'POST', headers: { 'x-ingest-token': TOKEN }, body: new FormData(),
    });
    expect(bad.status).toBe(400);
    expect((await postSnapshot(snapshotFile('s1'))).status).toBe(200);
  });
});

describe('busy', () => {
  it('answers 503 NAVDATA_BUSY with Retry-After while a swap is in progress', async () => {
    // Hold the router in its import phase by racing two uploads: the second sees the first.
    const first = postSnapshot(snapshotFile('s1'));
    const second = await postSnapshot(snapshotFile('s2'));
    const firstRes = await first;
    const statuses = [firstRes.status, second.status].sort();
    if (statuses[1] === 503) {
      const busy = firstRes.status === 503 ? firstRes : second;
      expect(busy.headers.get('retry-after')).toBe('2');
      expect(await busy.json()).toMatchObject({ ok: false, code: 'NAVDATA_BUSY' });
    } else {
      expect(statuses).toEqual([200, 200]);
    }
    expect(resolveNavdataPath()).toBe(path.join(dir, 'navdata.db'));
  });
});

describe('onDemandChanged — sync router', () => {
  let demandServer: Server;
  let demandBase: string;
  let onDemandChanged: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDemandChanged = vi.fn<() => void>();
    const app = express();
    app.use('/api/navdata/rows', express.json({ limit: '4mb' }));
    app.use(express.json({ limit: '100kb' }));
    app.use('/api/navdata', createNavdataSyncRouter({ token: TOKEN, allowUnauthenticated: false }, state, Date.now, onDemandChanged));
    await new Promise<void>(resolve => { demandServer = app.listen(0, '127.0.0.1', resolve); });
    demandBase = `http://127.0.0.1:${(demandServer.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => demandServer.close(() => resolve()));
  });

  const demandPostJson = (p: string, body: unknown) =>
    fetch(`${demandBase}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': TOKEN },
      body: JSON.stringify(body),
    });

  it('POST /snapshot calls onDemandChanged once on a successful import', async () => {
    const form = new FormData();
    form.append('navdataSnapshot', new Blob([fs.readFileSync(snapshotFile('d1'))], { type: 'application/gzip' }), 'd1.gz');

    const res = await fetch(`${demandBase}/api/navdata/snapshot`, {
      method: 'POST', body: form, headers: { 'x-ingest-token': TOKEN },
    });

    expect(res.status).toBe(200);
    expect(onDemandChanged).toHaveBeenCalledTimes(1);
  });

  it('POST /snapshot does not call onDemandChanged on a refused upload', async () => {
    const bad = await fetch(`${demandBase}/api/navdata/snapshot`, {
      method: 'POST', headers: { 'x-ingest-token': TOKEN }, body: new FormData(),
    });
    expect(bad.status).toBe(400);
    expect(onDemandChanged).not.toHaveBeenCalled();
  });

  it('POST /rows calls onDemandChanged once on a successful batch, zero on a refused one', async () => {
    const form = new FormData();
    form.append('navdataSnapshot', new Blob([fs.readFileSync(snapshotFile('d2'))], { type: 'application/gzip' }), 'd2.gz');
    await fetch(`${demandBase}/api/navdata/snapshot`, { method: 'POST', body: form, headers: { 'x-ingest-token': TOKEN } });
    onDemandChanged.mockClear();

    const refused = await demandPostJson('/api/navdata/rows', {
      v: 1, schemaVersion: 2, snapshotId: 'other', fromRev: 5, toRev: 6, rows: [], more: false,
    });
    expect(refused.status).toBe(409);
    expect(onDemandChanged).not.toHaveBeenCalled();

    const ok = await demandPostJson('/api/navdata/rows', {
      v: 1, schemaVersion: 2, snapshotId: 'd2', fromRev: 5, toRev: 6,
      rows: [{ t: 'airport', r: { ident: 'ZZDD', name: 'Zulu Demand', lat: 1, lon: 2, position_source: 'list', rev: 6 } }],
      more: false,
    });
    expect(ok.status).toBe(200);
    expect(onDemandChanged).toHaveBeenCalledTimes(1);
  });

  it('GET /demand never calls onDemandChanged', async () => {
    const res = await fetch(`${demandBase}/api/navdata/demand`, { headers: { 'x-ingest-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(onDemandChanged).not.toHaveBeenCalled();
  });

  it('POST /state never calls onDemandChanged', async () => {
    const res = await demandPostJson('/api/navdata/state', {
      v: 1, state: 'nav.ready', reason: null, snapshotId: 's1', rev: 3, sentAt: 1,
    });
    expect(res.status).toBe(204);
    expect(onDemandChanged).not.toHaveBeenCalled();
  });
});

describe('onDemandChanged — POST /navdata/request', () => {
  let reqServer: Server;
  let reqBase: string;
  let onDemandChanged: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDemandChanged = vi.fn<() => void>();
    const app = express();
    app.use(express.json());
    app.use('/api', createNavdataRouter(state, onDemandChanged));
    await new Promise<void>(resolve => { reqServer = app.listen(0, '127.0.0.1', resolve); });
    reqBase = `http://127.0.0.1:${(reqServer.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => reqServer.close(() => resolve()));
  });

  const request = (body: unknown) =>
    fetch(`${reqBase}/api/navdata/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('calls onDemandChanged once when the request is freshly queued', async () => {
    const res = await request({ kind: 'A', ident: 'ZZNEW' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: 'queued', ident: 'ZZNEW' });
    expect(onDemandChanged).toHaveBeenCalledTimes(1);
  });

  it('does not call onDemandChanged on a 400 (bad kind)', async () => {
    const res = await request({ kind: 'X', ident: 'ZZNEW' });
    expect(res.status).toBe(400);
    expect(onDemandChanged).not.toHaveBeenCalled();
  });

  it('does not call onDemandChanged for a known-absent ident', async () => {
    // submitRequest only consults nav_absent/nav_airport when getNavDb() is
    // non-null, which requires a replica file to exist on disk — so a
    // snapshot has to land first, same as the already-present case below.
    await postSnapshot(snapshotFile('req-absent'));
    getNavDb()!.prepare(
      `INSERT INTO nav_absent (kind, ident, region, reason, first_seen_at, last_checked_at, attempts, rev)
       VALUES ('A', 'ZZNOPE', '', 'silent', ?, ?, 1, 1)`,
    ).run(Date.now(), Date.now());

    const res = await request({ kind: 'A', ident: 'ZZNOPE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'known-absent' });
    expect(onDemandChanged).not.toHaveBeenCalled();
  });

  it('does not call onDemandChanged for an already-present airport', async () => {
    await postSnapshot(snapshotFile('req1'));
    getNavDb()!.prepare("UPDATE nav_airport SET detail_state = 'detail' WHERE ident = 'ZZAA'").run();

    const res = await request({ kind: 'A', ident: 'ZZAA' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'already-present' });
    expect(onDemandChanged).not.toHaveBeenCalled();
  });
});

describe('browser reads follow the selected source', () => {
  let appServer: Server;
  let appBase: string;
  let onDemandChanged: ReturnType<typeof vi.fn<() => void>>;
  let onSourceChanged: ReturnType<typeof vi.fn<() => void>>;

  /** A replica holding the named airports, each already marked as fully fetched. */
  function buildFile(file: string, snapshotId: string, idents: string[], lnm = false): void {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    applyNavdataSchema(db);
    db.prepare(
      "INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at) VALUES (1, 2, ?, '2024', 1, 1)",
    ).run(snapshotId);
    idents.forEach((ident, i) => {
      db.prepare(
        "INSERT INTO nav_airport (ident, lat, lon, name, detail_state, rev) VALUES (?, ?, ?, ?, 'detail', 1)",
      ).run(ident, 10 + i, 20 + i, `Field ${ident}`);
    });
    if (lnm) {
      db.exec(LNM_DATASET_DDL);
      db.prepare(
        `INSERT INTO lnm_dataset (id, snapshot_id, data_source, source_file_name, source_bytes, imported_at, label)
         VALUES (1, ?, 'MSFS', 'synthetic.sqlite', 1, 1, 'Synthetic dataset')`,
      ).run(snapshotId);
    }
    db.close();
  }

  const fileSha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const getJson = async (p: string): Promise<any> => (await fetch(`${appBase}${p}`)).json();
  const put = (source: unknown) =>
    fetch(`${appBase}/api/settings/navdata-source`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
    });
  const airportIdents = async (): Promise<string[]> =>
    ((await getJson('/api/navdata/features?bbox=-180,-90,180,90&zoom=6&kinds=airports')).airports as { ident: string }[])
      .map(a => a.ident).sort();
  const demand = () => fetch(`${appBase}/api/navdata/demand`, { headers: { 'x-ingest-token': TOKEN } });
  const request = (body: unknown) =>
    fetch(`${appBase}/api/navdata/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  beforeEach(async () => {
    buildFile(resolveNavdataPath(), 'mcdu-snap', ['ZZAA', 'ZZAB']);
    buildFile(resolveLnmNavdataPath(), 'lnm-snap', ['LLAA', 'LLAB', 'LLAC'], true);
    openNavdata();
    onDemandChanged = vi.fn<() => void>();
    onSourceChanged = vi.fn<() => void>();
    const app = express();
    app.use('/api/navdata/rows', express.json({ limit: '4mb' }));
    app.use(express.json());
    app.use('/api/navdata', createNavdataSyncRouter({ token: TOKEN, allowUnauthenticated: false }, state));
    app.use('/api', createSettingsRouter({ token: null, allowUnauthenticated: false }, { token: null, enabled: false }, onSourceChanged));
    app.use('/api', createNavdataRouter(state, onDemandChanged));
    app.use('/api', createRouteGeometryRouter());
    await new Promise<void>(resolve => { appServer = app.listen(0, '127.0.0.1', resolve); });
    appBase = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    setSelectedNavdataSource('mcdu');
    await new Promise<void>(resolve => appServer.close(() => resolve()));
  });

  it('swaps the handle read by features and status when the source changes, with no restart', async () => {
    expect(await airportIdents()).toEqual(['ZZAA', 'ZZAB']);
    expect((await getJson('/api/navdata/status')).snapshotId).toBe('mcdu-snap');

    expect((await put('lnm')).status).toBe(200);
    expect(await airportIdents()).toEqual(['LLAA', 'LLAB', 'LLAC']);
    const status = await getJson('/api/navdata/status');
    expect(status).toMatchObject({ present: true, snapshotId: 'lnm-snap', counts: { airports: 3 } });
    expect((await getJson('/api/navdata/airports/LLAB')).ident).toBe('LLAB');
    expect((await fetch(`${appBase}/api/navdata/airports/ZZAA`)).status).toBe(404);

    expect((await put('mcdu')).status).toBe(200);
    expect(await airportIdents()).toEqual(['ZZAA', 'ZZAB']);
    expect((await getJson('/api/navdata/status')).snapshotId).toBe('mcdu-snap');
    expect((await fetch(`${appBase}/api/navdata/airports/LLAB`)).status).toBe(404);
    expect(onSourceChanged).toHaveBeenCalledTimes(2);
  });

  it('a sidecar snapshot while the Little Navmap data is shown replaces only the simulator file', async () => {
    expect((await put('lnm')).status).toBe(200);
    const lnmBefore = fileSha(resolveLnmNavdataPath());

    const res = await fetch(`${appBase}/api/navdata/snapshot`, {
      method: 'POST', headers: { 'x-ingest-token': TOKEN },
      body: (() => {
        const form = new FormData();
        form.append('navdataSnapshot', new Blob([fs.readFileSync(snapshotFile('s-new'))], { type: 'application/gzip' }), 's-new.gz');
        return form;
      })(),
    });
    expect(res.status).toBe(200);

    const mcdu = new Database(resolveNavdataPath(), { readonly: true });
    expect((mcdu.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string }).s).toBe('s-new');
    mcdu.close();
    expect(fileSha(resolveLnmNavdataPath())).toBe(lnmBefore);
    expect(getLnmNavDb()!.prepare('SELECT snapshot_id AS s FROM nav_meta').get()).toEqual({ s: 'lnm-snap' });

    // The shown data and the selection are untouched.
    expect(await airportIdents()).toEqual(['LLAA', 'LLAB', 'LLAC']);
    expect(await getJson('/api/settings/navdata-source')).toMatchObject({ selected: 'lnm', effective: 'lnm' });
    expect(getSetting('navdata_source')).toBe('lnm');
  });

  it('rejects selecting Little Navmap data that was never imported, and keeps the stored choice', async () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(resolveLnmNavdataPath() + suffix, { force: true });
    openNavdata();
    const res = await put('lnm');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Little Navmap data has been imported', code: 'LNM_NOT_AVAILABLE' });
    expect(getSetting('navdata_source')).toBeNull();
    expect(await getJson('/api/settings/navdata-source')).toMatchObject({
      selected: 'mcdu', effective: 'mcdu', fallback: null, lnm: { present: false, dataset: null },
    });
    expect(onSourceChanged).not.toHaveBeenCalled();
  });

  it('rejects a source other than mcdu or lnm with 400 INVALID_SOURCE', async () => {
    for (const body of ['MCDU', '', null, 1, ['lnm'], { source: 'lnm' }, undefined]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "source must be 'mcdu' or 'lnm'", code: 'INVALID_SOURCE' });
    }
    const noBody = await fetch(`${appBase}/api/settings/navdata-source`, { method: 'PUT' });
    expect(noBody.status).toBe(400);
    expect(getSetting('navdata_source')).toBeNull();
    expect(onSourceChanged).not.toHaveBeenCalled();
  });

  it('answers from the simulator replica when Little Navmap data is selected but missing, without rewriting the choice', async () => {
    expect((await put('lnm')).status).toBe(200);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(resolveLnmNavdataPath() + suffix, { force: true });
    openNavdata();
    expect(await airportIdents()).toEqual(['ZZAA', 'ZZAB']);
    expect(await getJson('/api/settings/navdata-source')).toMatchObject({
      selected: 'lnm', effective: 'mcdu', fallback: 'lnm-unavailable', lnm: { present: false },
    });
    expect(getSetting('navdata_source')).toBe('lnm');
  });

  it('reports both datasets from the one reader', async () => {
    const body = await getJson('/api/settings/navdata-source');
    expect(body).toMatchObject({
      selected: 'mcdu', effective: 'mcdu', fallback: null, importDir: dir,
      mcdu: { present: true, dataset: { source: 'mcdu', label: 'Simulator', importedAt: 1 } },
      lnm: { present: true, dataset: { source: 'lnm', label: 'Synthetic dataset', provider: 'MSFS' } },
    });
  });

  it('stops demand while Little Navmap data is shown, keeps the queued requests, and resumes on switch back', async () => {
    upsertNavdataRequest('A', 'ZZREQ', null, new Date());
    expect(((await (await demand()).json()) as any).airports).toEqual(['ZZREQ']);

    expect((await put('lnm')).status).toBe(200);
    const paused = await demand();
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ v: 1, airports: [], waypoints: [], cap: 50, more: false });
    // The skip list is still validated, and the token is still required.
    expect((await fetch(`${appBase}/api/navdata/demand?skipAirports=ZZ-AA`, { headers: { 'x-ingest-token': TOKEN } })).status).toBe(400);
    expect((await fetch(`${appBase}/api/navdata/demand`)).status).toBe(401);
    expect(listNavdataRequests().map(r => r.ident)).toEqual(['ZZREQ']);

    expect((await put('mcdu')).status).toBe(200);
    expect(((await (await demand()).json()) as any).airports).toEqual(['ZZREQ']);
  });

  it('answers a manual request from the complete dataset and queues nothing while Little Navmap data is shown', async () => {
    expect((await put('lnm')).status).toBe(200);
    onDemandChanged.mockClear();

    const held = await request({ kind: 'A', ident: 'LLAA' });
    expect(await held.json()).toMatchObject({ ok: true, state: 'already-present', ident: 'LLAA' });
    const absent = await request({ kind: 'A', ident: 'ZZNEW', force: true });
    expect(await absent.json()).toMatchObject({ ok: true, state: 'known-absent', ident: 'ZZNEW' });
    const heldForced = await request({ kind: 'A', ident: 'LLAB', force: true });
    expect(await heldForced.json()).toMatchObject({ state: 'already-present' });
    expect(listNavdataRequests()).toEqual([]);
    expect(onDemandChanged).not.toHaveBeenCalled();

    expect((await put('mcdu')).status).toBe(200);
    const queued = await request({ kind: 'A', ident: 'ZZNEW' });
    expect(await queued.json()).toMatchObject({ state: 'queued' });
    expect(listNavdataRequests().map(r => r.ident)).toEqual(['ZZNEW']);
    expect(onDemandChanged).toHaveBeenCalledTimes(1);
  });

  it('resolves a planned leg against the replica that is shown', async () => {
    const legId = seedPlannedLeg(scratch.db, { trip_id: null, departure_ident: 'ZZAA', departure_lat: 10, departure_lon: 20 });
    scratch.db.prepare("UPDATE planned_legs SET sid_name = 'ALPHA1' WHERE id = ?").run(legId);
    const unresolved = async () => (await getJson(`/api/planned-legs/${legId}/route-geometry`)).unresolved;

    // ZZAA is fetched in the simulator replica and absent from the Little Navmap one.
    expect(await unresolved()).toEqual([{ kind: 'sid', name: 'ALPHA1', reason: 'procedure not in cache' }]);
    expect((await put('lnm')).status).toBe(200);
    expect(await unresolved()).toEqual([{ kind: 'sid', name: 'ALPHA1', reason: 'airport detail not fetched' }]);
    expect((await put('mcdu')).status).toBe(200);
    expect(await unresolved()).toEqual([{ kind: 'sid', name: 'ALPHA1', reason: 'procedure not in cache' }]);
  });
});
