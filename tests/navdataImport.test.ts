// The Little Navmap import endpoints on an ephemeral express app: upload and
// server-side path, the prechecks, every upload failure and its cleanup,
// progress, cancellation, and the swap into the Little Navmap replica. The
// build itself runs in-process on the synthetic atools fixtures (vitest cannot
// start a .ts worker thread); cancellation uses a fake runner that the test
// drives message by message. Invented idents only; the simulator replica is
// hashed before and after to show an import never writes it.

import express from 'express';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { PassThrough, Writable } from 'stream';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../src/auth/middleware';
import { isIngestScopedRoute } from '../src/auth/ingestScope';
import {
  closeNavDb, effectiveNavdataSource, getLnmNavDb, getSelectedNavdataSource, openNavdata, resolveLnmNavdataPath,
  resolveNavdataPath, setSelectedNavdataSource,
} from '../src/navdata/connection';
import { inProcessRunner } from '../src/navdata/lnm';
import { runLnmPipeline, runLnmPipelineToMessages } from '../src/navdata/lnm/pipeline';
import type {
  LnmImportJob, LnmImportResult, LnmImportRunner, LnmWorkerMessage, LnmWorkerRequest,
} from '../src/navdata/lnm/types';
import { applyNavdataSchema } from '../src/navdata/schema';
import { cancelLnmImportForShutdown, createNavdataImportRouter, type NavdataImportOptions } from '../src/routes/navdataImport';
import {
  LNM_BUILD_RESERVE_BYTES, LNM_DISK_MARGIN_BYTES, LNM_MEMORY_RESERVE_BYTES, LNM_UPLOAD_MAX_BYTES,
  LNM_UPLOAD_MULTIPART_SLACK_BYTES,
} from '../src/routes/uploads';
import { buildLnmFixture, makeLnmFixtureDir, navigraph } from './helpers/lnmFixture';
import { scratchDbRoot } from './helpers/scratchRoot';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const NOW = Date.UTC(2026, 9, 1, 12);
const BAD_UPLOAD = 'Send exactly one file in the field lnmDatabase and nothing else';
const ABORTED = 'Upload stopped: the page was closed or the connection dropped';

// ── Fixtures ─────────────────────────────────────────────────────────────────

let fixtureDir: string;
let goodBytes: Buffer;
let wrongSourceBytes: Buffer;
/** The replica a real build of the good fixture produces, built once; most tests replay it instead of rebuilding. */
let prebuilt: { file: string; result: LnmImportResult };

beforeAll(() => {
  fixtureDir = makeLnmFixtureDir();
  const good = buildLnmFixture(fixtureDir, navigraph({ fileName: 'good.sqlite' }));
  goodBytes = fs.readFileSync(good);
  const file = path.join(fixtureDir, 'prebuilt.db');
  const result = runLnmPipeline({ sourcePath: good, sourceFileName: 'good.sqlite', sourceBytes: goodBytes.length, incomingPath: file, now: NOW }, () => {});
  prebuilt = { file, result };
  wrongSourceBytes = fs.readFileSync(buildLnmFixture(
    fixtureDir, navigraph({ fileName: 'wrong-source.sqlite', metadata: { data_source: 'XP12' } }),
  ));
}, 30_000);

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// ── Per-test directory, server and replica ───────────────────────────────────

const savedEnv = process.env.NAVDATA_DB_PATH;
let dir: string;
let server: http.Server | null = null;
let base = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'lnm-import-'));
  process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
});

afterEach(async () => {
  cancelLnmImportForShutdown();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  setSelectedNavdataSource('mcdu');
  closeNavDb();
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

/** Puts the prebuilt replica at the request's incoming path and returns the result its build reported. */
function buildFor(req: LnmWorkerRequest): LnmImportResult {
  fs.copyFileSync(prebuilt.file, req.incomingPath);
  return prebuilt.result;
}

/** Finishes at once with the prebuilt replica, so the swap and verification are real but the 2 s build is not repeated. */
const replayRunner: LnmImportRunner = {
  start(req, onMessage) {
    let cancelled = false;
    const done = new Promise<void>(resolve => {
      setImmediate(() => {
        if (!cancelled) {
          onMessage({ type: 'progress', stage: 'validating', done: 1, total: 1 });
          onMessage({ type: 'done', result: buildFor(req) });
        }
        resolve();
      });
    });
    return { done, cancel() { cancelled = true; } };
  },
};

/** Enough space and memory that the machine running the suite never decides a test. */
const ROOMY: NavdataImportOptions = {
  runner: replayRunner,
  now: () => NOW,
  statfs: () => ({ availableBytes: 100 * GIB }),
  availableMemory: () => 64 * GIB,
};

async function start(opts: NavdataImportOptions = {}, gate?: express.RequestHandler, router?: express.Router): Promise<void> {
  const app = express();
  app.use(express.json());
  if (gate) app.use('/api', gate);
  app.use('/api', router ?? createNavdataImportRouter({ ...ROOMY, ...opts }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The simulator replica, written the way the sidecar's import would leave it. */
function writeSimulatorReplica(): string {
  const file = resolveNavdataPath();
  const db = new Database(file);
  applyNavdataSchema(db);
  db.prepare(
    `INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, sim_app_name, sim_app_version, created_at, updated_at)
     VALUES (1, 2, 'sim-snapshot', '2024', 'Test Sim', '1.0', 1, 1)`,
  ).run();
  db.prepare(
    "INSERT INTO nav_airport (ident, name, lat, lon, position_source, rev) VALUES ('ZZSM', 'Zulu Sim Field', 1, 2, 'list', 1)",
  ).run();
  db.close();
  return file;
}

const md5 = (file: string): string => createHash('md5').update(fs.readFileSync(file)).digest('hex');
const exists = (file: string): boolean => fs.existsSync(file);

/** Spool and incoming files left in the replica directory, journal siblings included. */
const leftovers = (): string[] => fs.readdirSync(dir).filter(n => n.includes('.upload-') || n.includes('.incoming-'));

function placeFile(name: string, bytes: Buffer | string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface Reply<T = Record<string, unknown>> { status: number; body: T }

async function reply<T = Record<string, unknown>>(r: Response): Promise<Reply<T>> {
  return { status: r.status, body: (await r.json()) as T };
}

const getJob = async (): Promise<LnmImportJob | null> =>
  ((await reply<{ job: LnmImportJob | null }>(await fetch(`${base}/api/navdata/lnm-import`))).body.job);

const postPath = async (fileName: unknown) =>
  reply<{ job: LnmImportJob } & Record<string, unknown>>(await fetch(`${base}/api/navdata/lnm-import/path`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName }),
  }));

const del = async () => reply<{ job: LnmImportJob } & Record<string, unknown>>(
  await fetch(`${base}/api/navdata/lnm-import`, { method: 'DELETE' }),
);

function form(parts: { name: string; value: Buffer | string; filename?: string }[]): FormData {
  const f = new FormData();
  for (const p of parts) {
    if (p.filename === undefined) f.append(p.name, String(p.value));
    else f.append(p.name, new Blob([new Uint8Array(Buffer.from(p.value))]), p.filename);
  }
  return f;
}

const postForm = async (body: FormData) =>
  reply<{ job: LnmImportJob } & Record<string, unknown>>(
    await fetch(`${base}/api/navdata/lnm-import/upload`, { method: 'POST', body }),
  );

const upload = (bytes: Buffer | string, filename = 'good.sqlite') =>
  postForm(form([{ name: 'lnmDatabase', value: bytes, filename }]));

async function until<T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const settled = (): Promise<LnmImportJob> =>
  until(async () => {
    const job = await getJob();
    return job && job.state !== 'receiving' && job.state !== 'running' ? job : null;
  }, 'the job to end');

/** A multipart upload that stops after `sent` bytes of a body that promised more; the caller ends it. */
function partialUpload(sent: number): { req: http.ClientRequest; closed: Promise<void> } {
  const boundary = 'PARTIALBOUNDARY';
  const req = http.request({
    host: '127.0.0.1', port: Number(new URL(base).port), path: '/api/navdata/lnm-import/upload', method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(sent + 100_000) },
  });
  const closed = new Promise<void>(resolve => {
    req.on('error', () => resolve());
    req.on('close', () => resolve());
  });
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="lnmDatabase"; filename="half.sqlite"\r\n\r\n`;
  req.write(head + 'x'.repeat(Math.max(sent - head.length, 0)));
  return { req, closed };
}

// ── Fake runner ──────────────────────────────────────────────────────────────

interface FakeRun {
  req: LnmWorkerRequest;
  post(message: LnmWorkerMessage): void;
  /** The worker has exited: the runner's done promise settles. */
  exit(): void;
  cancelCalls: number;
}

/** A runner the test drives by hand; cancel() only counts, like a runner whose latch has not run yet. */
function fakeRunner(onCancel: (run: FakeRun) => void = () => {}): { runner: LnmImportRunner; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const runner: LnmImportRunner = {
    start(req, onMessage) {
      let exit!: () => void;
      const done = new Promise<void>(resolve => { exit = resolve; });
      const run: FakeRun = { req, post: onMessage, exit, cancelCalls: 0 };
      runs.push(run);
      return { done, cancel() { run.cancelCalls++; onCancel(run); } };
    },
  };
  return { runner, runs };
}

// ── Path import ──────────────────────────────────────────────────────────────

describe('server-side path import', () => {
  it('imports a synthetic fixture into the Little Navmap replica and leaves the simulator replica byte-identical', async () => {
    const sim = writeSimulatorReplica();
    openNavdata();
    const simBefore = md5(sim);
    const source = placeFile('little.sqlite', goodBytes);
    const sourceBefore = md5(source);
    await start({ runner: inProcessRunner });

    const accepted = await postPath('little.sqlite');
    expect(accepted.status).toBe(202);
    expect(accepted.body.job).toMatchObject({ origin: 'path', sourceFileName: 'little.sqlite', sourceBytes: goodBytes.length });

    const job = await settled();
    expect(job).toMatchObject({ state: 'succeeded', stage: 'swapping', fraction: 1, error: null, finishedAt: NOW });
    expect(job.result?.counts.airports).toBeGreaterThan(0);
    expect(job.result?.counts.coverageCells).toBe(777_600);
    expect(job.result?.dataset).toMatchObject({ source: 'lnm', provider: 'NAVIGRAPH', airacCycle: '2610' });
    expect(job.result?.dataset.label).toMatch(/AIRAC 2610/);

    expect(exists(resolveLnmNavdataPath())).toBe(true);
    expect(getLnmNavDb()).not.toBeNull();
    expect(md5(sim)).toBe(simBefore);
    expect(md5(source)).toBe(sourceBefore);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it('does not change which source is selected: that stays an explicit choice', async () => {
    placeFile('little.sqlite', goodBytes);
    await start();
    await postPath('little.sqlite');
    expect((await settled()).state).toBe('succeeded');
    expect(getSelectedNavdataSource()).toBe('mcdu');
    expect(effectiveNavdataSource()).toBe('mcdu');
    setSelectedNavdataSource('lnm');
    expect(effectiveNavdataSource()).toBe('lnm');
  });

  it('ends a file that is not a Little Navmap database as a failed job with a one-line reason and no leftovers', async () => {
    placeFile('wrong-source.sqlite', wrongSourceBytes);
    await start({ runner: inProcessRunner });
    expect((await postPath('wrong-source.sqlite')).status).toBe(202);
    const job = await settled();
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('LNM_UNSUPPORTED_SOURCE');
    expect(job.error?.message).not.toMatch(/\n/);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(exists(path.join(dir, 'wrong-source.sqlite'))).toBe(true);
  });

  it('refuses a file that does not start with the SQLite header, before any job exists', async () => {
    placeFile('notes.sqlite', 'this is not a database, only a text file of some length');
    placeFile('short.sqlite', 'SQLite');
    await start();
    for (const name of ['notes.sqlite', 'short.sqlite']) {
      const r = await postPath(name);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'The file is not a SQLite database', code: 'LNM_NOT_SQLITE' });
    }
    expect(await getJob()).toBeNull();
  });

  it('accepts only a plain .sqlite file name inside the import directory', async () => {
    placeFile('.hidden.sqlite', goodBytes);
    placeFile('navdata.db', goodBytes);
    fs.mkdirSync(path.join(dir, 'sub'));
    placeFile('sub/inner.sqlite', goodBytes);
    await start();
    const bad: unknown[] = [
      '../navdata.sqlite', 'sub/inner.sqlite', 'sub\\inner.sqlite', '/etc/passwd.sqlite', '.hidden.sqlite',
      'navdata.db', 'flights.db', 'little.sqlite\0', 'little', '', `${'a'.repeat(250)}.sqlite`, 42, null, ['a.sqlite'],
    ];
    for (const name of bad) {
      const r = await postPath(name);
      expect(r.status, JSON.stringify(name)).toBe(400);
      expect(r.body.code).toBe('LNM_BAD_REQUEST');
    }
    const noBody = await reply(await fetch(`${base}/api/navdata/lnm-import/path`, { method: 'POST' }));
    expect(noBody).toMatchObject({ status: 400, body: { code: 'LNM_BAD_REQUEST' } });
    expect(await getJob()).toBeNull();
  });

  it('answers 404 for a missing file and 400 for a symlink or a directory, and never follows a link out', async () => {
    const outside = path.join(fixtureDir, 'good.sqlite');
    fs.symlinkSync(outside, path.join(dir, 'linked.sqlite'));
    fs.mkdirSync(path.join(dir, 'folder.sqlite'));
    await start();
    expect(await postPath('absent.sqlite')).toMatchObject({ status: 404, body: { code: 'LNM_FILE_NOT_FOUND' } });
    expect(await postPath('linked.sqlite')).toMatchObject({ status: 400, body: { code: 'LNM_BAD_REQUEST' } });
    expect(await postPath('folder.sqlite')).toMatchObject({ status: 400, body: { code: 'LNM_BAD_REQUEST' } });
    expect(await getJob()).toBeNull();
  });

  it('lists only plain .sqlite files, with the limits the client needs', async () => {
    placeFile('b.sqlite', 'bb');
    placeFile('A.SQLITE', 'a');
    placeFile('c.db', 'c');
    placeFile('.hidden.sqlite', 'h');
    fs.mkdirSync(path.join(dir, 'folder.sqlite'));
    fs.symlinkSync(path.join(fixtureDir, 'good.sqlite'), path.join(dir, 'linked.sqlite'));
    await start({ statfs: () => ({ availableBytes: 5 * GIB }) });
    const r = await reply<{ dir: string; files: { name: string; sizeBytes: number; modifiedAt: number }[] } & Record<string, unknown>>(
      await fetch(`${base}/api/navdata/lnm-import/files`),
    );
    expect(r.status).toBe(200);
    expect(r.body.dir).toBe(dir);
    expect(r.body.files.map(f => [f.name, f.sizeBytes])).toEqual([['A.SQLITE', 1], ['b.sqlite', 2]]);
    expect(r.body.files[0].modifiedAt).toBe(Math.round(fs.statSync(path.join(dir, 'A.SQLITE')).mtimeMs));
    expect(r.body).toMatchObject({
      maxUploadBytes: LNM_UPLOAD_MAX_BYTES, availableBytes: 5 * GIB, reserveBytes: LNM_BUILD_RESERVE_BYTES + LNM_DISK_MARGIN_BYTES,
    });
    expect(Object.keys(r.body.files[0]).sort()).toEqual(['modifiedAt', 'name', 'sizeBytes']);
  });

  it('reports no files for an unreadable directory and null space when statfs fails', async () => {
    process.env.NAVDATA_DB_PATH = path.join(dir, 'missing-dir', 'navdata.db');
    await start({ statfs: () => { throw new Error('no statfs'); } });
    const r = await reply(await fetch(`${base}/api/navdata/lnm-import/files`));
    expect(r.body).toMatchObject({ files: [], availableBytes: null });
  });

  it('creates a missing import directory on first use: the listing is empty, and a path import is a plain 404', async () => {
    const sub = path.join(dir, 'fresh');
    process.env.NAVDATA_DB_PATH = path.join(sub, 'navdata.db');
    await start();
    expect(exists(sub)).toBe(false);

    const listed = await reply(await fetch(`${base}/api/navdata/lnm-import/files`));
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ dir: sub, files: [], availableBytes: 100 * GIB });
    expect(fs.statSync(sub).isDirectory()).toBe(true);

    fs.rmdirSync(sub);
    expect(await postPath('little.sqlite')).toEqual({
      status: 404, body: { error: 'No such file in the import directory', code: 'LNM_FILE_NOT_FOUND' },
    });
    expect(fs.statSync(sub).isDirectory()).toBe(true);
  });
});

// ── Prechecks ────────────────────────────────────────────────────────────────

describe('prechecks', () => {
  it('refuses a path import with 507 LNM_INSUFFICIENT_STORAGE when the build reserve does not fit', async () => {
    const source = placeFile('little.sqlite', goodBytes);
    const simBefore = exists(resolveNavdataPath());
    await start({ statfs: () => ({ availableBytes: 900 * MIB }) });
    const r = await postPath('little.sqlite');
    const required = LNM_BUILD_RESERVE_BYTES + LNM_DISK_MARGIN_BYTES;
    expect(r.status).toBe(507);
    expect(r.body).toEqual({
      error: `Not enough disk space: need ${required / MIB} MiB free in the navdata directory, 900 MiB available`,
      code: 'LNM_INSUFFICIENT_STORAGE', requiredBytes: required, availableBytes: 900 * MIB,
    });
    expect(await getJob()).toBeNull();
    expect(exists(source)).toBe(true);
    expect(exists(resolveNavdataPath())).toBe(simBefore);
    expect(leftovers()).toEqual([]);
  });

  it('counts the upload itself in the space it needs, from its Content-Length', async () => {
    const free = LNM_BUILD_RESERVE_BYTES + LNM_DISK_MARGIN_BYTES + goodBytes.length;
    await start({ statfs: () => ({ availableBytes: free - 1 }) });
    const body = form([{ name: 'lnmDatabase', value: goodBytes, filename: 'good.sqlite' }]);
    const length = Number((await new Response(body).arrayBuffer()).byteLength);
    expect(length).toBeGreaterThan(goodBytes.length);
    const r = await upload(goodBytes);
    expect(r.status).toBe(507);
    expect(r.body).toMatchObject({ code: 'LNM_INSUFFICIENT_STORAGE', availableBytes: free - 1 });
    expect(r.body.requiredBytes).toBe(length + LNM_BUILD_RESERVE_BYTES + LNM_DISK_MARGIN_BYTES);
    expect(await getJob()).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('refuses with 507 LNM_INSUFFICIENT_MEMORY when too little memory is free, upload and path alike', async () => {
    placeFile('little.sqlite', goodBytes);
    await start({ availableMemory: () => 300 * MIB });
    const expected = {
      error: `Not enough free memory to import: need ${LNM_MEMORY_RESERVE_BYTES / MIB} MiB, 300 MiB available`,
      code: 'LNM_INSUFFICIENT_MEMORY', requiredBytes: LNM_MEMORY_RESERVE_BYTES, availableBytes: 300 * MIB,
    };
    expect(await postPath('little.sqlite')).toEqual({ status: 507, body: expected });
    expect(await upload(goodBytes)).toEqual({ status: 507, body: expected });
    expect(await getJob()).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('checks space before memory, and reads memory only when space was enough', async () => {
    placeFile('little.sqlite', goodBytes);
    let memoryReads = 0;
    await start({
      statfs: () => ({ availableBytes: 1 }),
      availableMemory: () => { memoryReads++; return 1; },
    });
    expect((await postPath('little.sqlite')).body.code).toBe('LNM_INSUFFICIENT_STORAGE');
    expect(memoryReads).toBe(0);
  });

  it('does not refuse space it cannot measure: a build that runs out of space fails cleanly instead', async () => {
    placeFile('little.sqlite', goodBytes);
    await start({ statfs: () => { throw new Error('no statfs'); } });
    expect((await postPath('little.sqlite')).status).toBe(202);
    expect((await settled()).state).toBe('succeeded');
  });

  it('answers 411 for an upload with no Content-Length, before reading anything', async () => {
    await start();
    const r = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: Number(new URL(base).port), path: '/api/navdata/lnm-import/upload', method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=B', 'transfer-encoding': 'chunked' },
      }, res => {
        let text = '';
        res.on('data', d => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end('--B--\r\n');
    });
    expect(r).toEqual({ status: 411, body: { error: 'The upload must state its Content-Length', code: 'LNM_LENGTH_REQUIRED' } });
    expect(await getJob()).toBeNull();
  });

  it('answers 413 from the Content-Length alone when it is over the limit plus the multipart framing', async () => {
    await start({ maxUploadBytes: 1000 });
    const r = await upload(Buffer.alloc(1000 + LNM_UPLOAD_MULTIPART_SLACK_BYTES + 1, 'a'));
    expect(r).toEqual({ status: 413, body: { error: 'File exceeds 1000 bytes', code: 'LNM_TOO_LARGE' } });
    expect(await getJob()).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('words the default limit as 2 GiB', async () => {
    expect(LNM_UPLOAD_MAX_BYTES).toBe(2 * GIB);
    await start({ maxUploadBytes: LNM_UPLOAD_MAX_BYTES });
    const f = await reply<{ maxUploadBytes: number }>(await fetch(`${base}/api/navdata/lnm-import/files`));
    expect(f.body.maxUploadBytes).toBe(2 * GIB);
  });
});

// ── Upload ───────────────────────────────────────────────────────────────────

describe('upload', () => {
  it('accepts a synthetic fixture, reports progress to done, swaps it in and removes the spool', async () => {
    const sim = writeSimulatorReplica();
    openNavdata();
    const simBefore = md5(sim);
    await start({ runner: inProcessRunner });

    const accepted = await upload(goodBytes, 'C:\\Users\\someone\\little navmap.sqlite');
    expect(accepted.status).toBe(202);
    expect(accepted.body.job).toMatchObject({
      origin: 'upload', sourceFileName: 'little navmap.sqlite', sourceBytes: goodBytes.length, state: 'running',
    });
    expect(accepted.body.job.id).toMatch(/^[0-9a-f]{12}$/);

    const job = await settled();
    expect(job).toMatchObject({ state: 'succeeded', fraction: 1, error: null });
    expect(job.result?.dataset.source).toBe('lnm');
    expect(getLnmNavDb()).not.toBeNull();
    expect(md5(sim)).toBe(simBefore);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it('spools on the navdata volume, beside the replica, while the body arrives', async () => {
    await start();
    const { req, closed } = partialUpload(5000);
    const job = await until(async () => {
      const j = await getJob();
      return j?.state === 'receiving' && leftovers().length > 0 ? j : null;
    }, 'the spool file');
    expect(job).toMatchObject({ origin: 'upload', state: 'receiving', stage: null, fraction: 0, finishedAt: null });
    expect(leftovers()).toHaveLength(1);
    expect(leftovers()[0].startsWith('navdata.db.lnm.upload-')).toBe(true);
    req.destroy();
    await closed;
    await settled();
  });

  it('refuses a file that is not SQLite with a one-line error, records the same code on the job and removes the spool', async () => {
    await start();
    const r = await upload('definitely not a database, just a few words in a file', 'notes.sqlite');
    expect(r).toEqual({ status: 400, body: { error: 'The file is not a SQLite database', code: 'LNM_NOT_SQLITE' } });
    expect(await getJob()).toMatchObject({
      state: 'failed', error: { code: 'LNM_NOT_SQLITE', message: 'The file is not a SQLite database' },
    });
    expect(leftovers()).toEqual([]);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
  });

  it('turns a wrong-flavour database into a failed job with a one-line reason, no replica and no spool', async () => {
    await start({ runner: inProcessRunner });
    expect((await upload(wrongSourceBytes, 'xplane.sqlite')).status).toBe(202);
    const job = await settled();
    expect(job).toMatchObject({ state: 'failed', sourceFileName: 'xplane.sqlite', error: { code: 'LNM_UNSUPPORTED_SOURCE' } });
    expect(job.error?.message).not.toMatch(/\n/);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('answers 413 LNM_TOO_LARGE when the file passes the size limit mid-body, and the job records the same code', async () => {
    await start({ maxUploadBytes: 1000 });
    const r = await upload(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(2000)]), 'big.sqlite');
    expect(r).toEqual({ status: 413, body: { error: 'File exceeds 1000 bytes', code: 'LNM_TOO_LARGE' } });
    const job = await getJob();
    expect(job).toMatchObject({ state: 'failed', error: { code: r.body.code, message: r.body.error } });
    expect(leftovers()).toEqual([]);
  });

  describe.each([
    ['an extra text field', () => form([
      { name: 'note', value: 'hello' },
      { name: 'lnmDatabase', value: goodBytes, filename: 'good.sqlite' },
    ])],
    ['an extra text field after the file', () => form([
      { name: 'lnmDatabase', value: goodBytes, filename: 'good.sqlite' },
      { name: 'note', value: 'hello' },
    ])],
    ['two files', () => form([
      { name: 'lnmDatabase', value: goodBytes, filename: 'one.sqlite' },
      { name: 'lnmDatabase', value: goodBytes, filename: 'two.sqlite' },
    ])],
    ['a file under the wrong field name', () => form([{ name: 'file', value: goodBytes, filename: 'good.sqlite' }])],
    ['no parts at all', () => form([])],
  ])('with %s', (_what, makeForm) => {
    it('answers 400 LNM_BAD_REQUEST, fails the job with the same code and message, and removes the spool', async () => {
      await start();
      const r = await postForm(makeForm());
      expect(r).toEqual({ status: 400, body: { error: BAD_UPLOAD, code: 'LNM_BAD_REQUEST' } });
      const job = await getJob();
      expect(job).toMatchObject({ state: 'failed', error: { code: 'LNM_BAD_REQUEST', message: BAD_UPLOAD } });
      expect(job?.error?.code).toBe(r.body.code);
      expect(leftovers()).toEqual([]);
      expect(exists(resolveLnmNavdataPath())).toBe(false);
    });
  });

  it('answers 400 LNM_BAD_REQUEST for a body that is not multipart', async () => {
    await start();
    const r = await reply(await fetch(`${base}/api/navdata/lnm-import/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    }));
    expect(r).toEqual({ status: 400, body: { error: BAD_UPLOAD, code: 'LNM_BAD_REQUEST' } });
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_BAD_REQUEST' } });
  });

  it.each([
    ['a form-encoded text body', 'application/x-www-form-urlencoded', 'x'],
    ['an octet-stream body of about 100 KB', 'application/octet-stream', 'y'.repeat(100_000)],
  ])('answers 400 LNM_BAD_REQUEST, and does answer, for %s that nothing reads before multer is called', async (_what, type, body) => {
    await start();
    const r = await Promise.race([
      fetch(`${base}/api/navdata/lnm-import/upload`, { method: 'POST', headers: { 'content-type': type }, body })
        .then(res => reply(res)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no response')), 3000)),
    ]);
    expect(r).toEqual({ status: 400, body: { error: BAD_UPLOAD, code: 'LNM_BAD_REQUEST' } });
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_BAD_REQUEST', message: BAD_UPLOAD } });
    expect(leftovers()).toEqual([]);
  });

  it('creates a missing import directory before spooling, so a first upload on a fresh install succeeds', async () => {
    const sub = path.join(dir, 'fresh');
    process.env.NAVDATA_DB_PATH = path.join(sub, 'navdata.db');
    await start();
    expect(exists(sub)).toBe(false);

    expect((await upload(goodBytes)).status).toBe(202);
    expect(await settled()).toMatchObject({ state: 'succeeded', error: null });
    expect(getLnmNavDb()).not.toBeNull();
    expect(exists(path.join(sub, 'navdata.db.lnm'))).toBe(true);
    expect(fs.readdirSync(sub).filter(n => n.includes('.upload-') || n.includes('.incoming-'))).toEqual([]);
  });

  it('lets a new upload start once the previous one has failed', async () => {
    await start();
    expect((await upload('not sqlite at all, but long enough to be a file')).status).toBe(400);
    expect((await upload(goodBytes)).status).toBe(202);
    expect((await settled()).state).toBe('succeeded');
  });
});

// ── An upload the disk cannot take ───────────────────────────────────────────

describe('a spool write that fails', () => {
  /**
   * Makes every write to a spool file fail with the given errno on its first
   * chunk. The file exists by then, as it does when a disk fills mid-write, so
   * the test can show it is removed. The message embeds the path, as a real one does.
   */
  function failSpoolWrites(code: string): { created: () => boolean } {
    const real = fs.createWriteStream;
    let created = false;
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (!String(file).includes('.upload-')) return (real as (...a: unknown[]) => fs.WriteStream)(file, ...rest);
      return new Writable({
        construct(callback) {
          fs.writeFileSync(file, '');
          created = true;
          callback();
        },
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error(`${code}: write failed, '${String(file)}'`), { code, syscall: 'write' }));
        },
      });
    }) as unknown as typeof fs.createWriteStream);
    return { created: () => created };
  }

  it.each(['ENOSPC', 'EDQUOT'])('answers 507 LNM_INSUFFICIENT_STORAGE for %s, records the same code on the job and removes the spool', async code => {
    const spool = failSpoolWrites(code);
    await start();
    const r = await upload(goodBytes);
    expect(r).toEqual({ status: 507, body: { error: 'Not enough disk space to receive the upload', code: 'LNM_INSUFFICIENT_STORAGE' } });
    expect(spool.created()).toBe(true);
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: r.body.code, message: r.body.error } });
    expect(leftovers()).toEqual([]);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
  });

  it.each(['EIO', 'EACCES', 'EROFS'])('answers 500 LNM_SPOOL_FAILED for %s, records the same code on the job, removes the spool and shows no path', async code => {
    const spool = failSpoolWrites(code);
    await start();
    const r = await upload(goodBytes);
    expect(r).toEqual({ status: 500, body: { error: 'The server could not store the upload', code: 'LNM_SPOOL_FAILED' } });
    expect(spool.created()).toBe(true);
    const job = await getJob();
    expect(job).toMatchObject({ state: 'failed', error: { code: r.body.code, message: r.body.error } });
    expect(JSON.stringify(job)).not.toContain(dir);
    expect(leftovers()).toEqual([]);
  });

  it('answers 500 LNM_SPOOL_FAILED, with nothing injected, when the import directory cannot exist', async () => {
    placeFile('blocker', 'a file where the directory should be');
    process.env.NAVDATA_DB_PATH = path.join(dir, 'blocker', 'navdata.db');
    await start();
    const r = await upload(goodBytes);
    expect(r).toEqual({ status: 500, body: { error: 'The server could not store the upload', code: 'LNM_SPOOL_FAILED' } });
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_SPOOL_FAILED' } });
  });

  it('frees the slot: the next upload is accepted once the disk takes writes again', async () => {
    failSpoolWrites('ENOSPC');
    await start();
    expect((await upload(goodBytes)).status).toBe(507);
    vi.restoreAllMocks();
    expect((await upload(goodBytes)).status).toBe(202);
    expect((await settled()).state).toBe('succeeded');
  });
});

// ── An upload that stops mid-body ────────────────────────────────────────────

describe('a client that stops sending', () => {
  async function receiving(): Promise<void> {
    await until(async () => (await getJob())?.state === 'receiving' && leftovers().length > 0, 'a receiving upload');
  }

  it('leaves the job failed LNM_UPLOAD_ABORTED, never LNM_BAD_REQUEST, and removes the spool (connection destroyed)', async () => {
    await start();
    const { req, closed } = partialUpload(8000);
    await receiving();
    req.destroy();
    await closed;
    const job = await settled();
    expect(job).toMatchObject({ state: 'failed', error: { code: 'LNM_UPLOAD_ABORTED', message: ABORTED } });
    await until(() => leftovers().length === 0, 'the spool to be removed');
    expect(exists(resolveLnmNavdataPath())).toBe(false);
  });

  it('reads the same when the client closes its end and the response is still writable', async () => {
    await start();
    const { req, closed } = partialUpload(8000);
    await receiving();
    req.socket?.end();
    await closed;
    const job = await settled();
    expect(job).toMatchObject({ state: 'failed', error: { code: 'LNM_UPLOAD_ABORTED' } });
    await until(() => leftovers().length === 0, 'the spool to be removed');
  });

  it('is one abort when the response closes first: the multer callback that follows changes nothing and sends nothing', async () => {
    await start();
    const { req, closed } = partialUpload(8000);
    await receiving();
    req.destroy();
    await closed;
    const first = await settled();
    // Late events for the same job: the multer callback has been and gone, and a cancel finds it terminal.
    await new Promise(r => setTimeout(r, 100));
    expect(await getJob()).toEqual(first);
    expect((await del()).status).toBe(409);
  });

  it('is the same abort when multer reports the truncated body before the response has closed, and sends no response', async () => {
    // Over a real socket Node closes the response first in every case tried (a
    // destroyed connection and a half-closed one), so this order is driven by
    // hand: the request stream fails while the response is still open.
    const router = createNavdataImportRouter({ ...ROOMY });
    await start({}, undefined, router);
    const boundary = 'HANDBOUNDARY';
    const req = Object.assign(new PassThrough(), {
      method: 'POST', url: '/navdata/lnm-import/upload', originalUrl: '/api/navdata/lnm-import/upload', complete: false,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': '100000' },
    });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn(), set: vi.fn(),
    });
    router(req as unknown as express.Request, res as unknown as express.Response, () => {});
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="lnmDatabase"; filename="half.sqlite"\r\n\r\n`;
    req.write(head + 'x'.repeat(500));
    await until(async () => (await getJob())?.state === 'receiving' && leftovers().length > 0, 'a receiving upload');

    req.destroy(new Error('aborted'));
    const job = await settled();
    expect(job).toMatchObject({ state: 'failed', error: { code: 'LNM_UPLOAD_ABORTED', message: ABORTED } });
    await until(() => leftovers().length === 0, 'the spool to be removed');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();

    // the response closing afterwards finds a terminal job
    res.destroyed = true;
    res.emit('close');
    expect(await getJob()).toEqual(job);
  });

  it('frees the slot: a new upload is accepted after an abort', async () => {
    await start();
    const { req, closed } = partialUpload(8000);
    await receiving();
    req.destroy();
    await closed;
    await settled();
    expect((await upload(goodBytes)).status).toBe(202);
    expect((await settled()).state).toBe('succeeded');
    expect(leftovers()).toEqual([]);
  });

  it('is cancelled, not failed, when the user cancelled while the body was still arriving', async () => {
    await start();
    const { closed } = partialUpload(8000);
    await receiving();
    const cancel = await del();
    expect(cancel.status).toBe(202);
    await closed;
    const job = await settled();
    expect(job).toMatchObject({ state: 'cancelled', error: null });
    await until(() => leftovers().length === 0, 'the spool to be removed');
  });
});

// ── One job at a time ────────────────────────────────────────────────────────

describe('one import at a time', () => {
  it('answers 409 LNM_IMPORT_BUSY to a second start, upload or path, while a job is running', async () => {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    expect((await postPath('little.sqlite')).status).toBe(202);
    expect(runs).toHaveLength(1);
    const busy = { status: 409, body: { error: 'Another Little Navmap import is already running', code: 'LNM_IMPORT_BUSY' } };
    expect(await postPath('little.sqlite')).toEqual(busy);
    expect(await upload(goodBytes)).toEqual(busy);
    expect(runs).toHaveLength(1);
    expect((await getJob())?.state).toBe('running');
    runs[0].post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' });
    runs[0].exit();
    expect((await getJob())?.state).toBe('failed');
    expect((await postPath('little.sqlite')).status).toBe(202);
  });

  it('answers 409 to a second upload while the first body is still arriving, and the first is unharmed', async () => {
    await start();
    const { req, closed } = partialUpload(8000);
    await until(async () => (await getJob())?.state === 'receiving', 'a receiving upload');
    expect(await upload(goodBytes)).toMatchObject({ status: 409, body: { code: 'LNM_IMPORT_BUSY' } });
    expect((await getJob())?.state).toBe('receiving');
    req.destroy();
    await closed;
    await settled();
  });

  it('answers 409 LNM_NOT_RUNNING to a cancel when nothing is running, before and after a job', async () => {
    placeFile('little.sqlite', goodBytes);
    await start();
    const none = { status: 409, body: { error: 'No Little Navmap import is running', code: 'LNM_NOT_RUNNING' } };
    expect(await del()).toEqual(none);
    await postPath('little.sqlite');
    await settled();
    expect(await del()).toEqual(none);
  });

  it('serves the last job, or null before any, to GET', async () => {
    placeFile('little.sqlite', goodBytes);
    await start();
    expect(await getJob()).toBeNull();
    await postPath('little.sqlite');
    expect((await settled()).id).toBe((await getJob())?.id);
  });
});

// ── Progress ─────────────────────────────────────────────────────────────────

describe('progress', () => {
  it('weights the stages: finished stages plus the share of the current one, never going backwards', async () => {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    await postPath('little.sqlite');
    expect(await getJob()).toMatchObject({ state: 'running', stage: null, fraction: 0 });
    const post = (stage: string, done: number, total: number) =>
      runs[0].post({ type: 'progress', stage: stage as 'airports', done, total });
    post('validating', 1, 1);
    expect(await getJob()).toMatchObject({ stage: 'validating', fraction: 0.02 });
    post('airports', 1, 2);
    // validating 2 + indexing 8 + half of airports 10
    expect((await getJob())?.fraction).toBeCloseTo(0.15, 10);
    post('airports', 0, 2);
    expect((await getJob())?.fraction).toBeCloseTo(0.15, 10);
    post('procedures', 0, 0);
    // everything before procedures: 2 + 8 + 10 + 4 + 10 + 5
    expect((await getJob())?.fraction).toBeCloseTo(0.39, 10);
    post('verifying', 2, 1);
    expect((await getJob())?.fraction).toBeCloseTo(0.99, 10);
    runs[0].post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage verifying' });
    expect((await getJob())?.stage).toBe('verifying');
  });

  it('shows every stage in order for a real import', async () => {
    placeFile('little.sqlite', goodBytes);
    const seen: string[] = [];
    const watching: LnmImportRunner = {
      start(req, onMessage) {
        return inProcessRunner.start(req, m => {
          if (m.type === 'progress' && seen[seen.length - 1] !== m.stage) seen.push(m.stage);
          onMessage(m);
        });
      },
    };
    await start({ runner: watching });
    await postPath('little.sqlite');
    const job = await settled();
    expect(seen).toEqual([
      'validating', 'indexing', 'airports', 'navaids', 'waypoints', 'airways', 'procedures', 'finalising', 'coverage', 'verifying',
    ]);
    expect(job.fraction).toBe(1);
  }, 30_000);
});

// ── Cancellation and failure with a fake runner ──────────────────────────────

describe('cancellation', () => {
  /** An existing Little Navmap replica, built by a real import. */
  async function importOnce(): Promise<string> {
    placeFile('first.sqlite', goodBytes);
    await start();
    await postPath('first.sqlite');
    expect((await settled()).state).toBe('succeeded');
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
    return resolveLnmNavdataPath();
  }

  it('ends a job cancelled when the finished build arrives after DELETE: L byte-identical, incoming file and spool gone', async () => {
    const sim = writeSimulatorReplica();
    const lnm = await importOnce();
    const lnmBefore = md5(lnm);
    const simBefore = md5(sim);
    const labelBefore = (getLnmNavDb()!.prepare('SELECT snapshot_id FROM nav_meta').get() as { snapshot_id: string }).snapshot_id;

    placeFile('second.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    expect((await postPath('second.sqlite')).status).toBe(202);
    const incoming = runs[0].req.incomingPath;
    // the worker had already finished its build when the cancel came in
    const result = buildFor(runs[0].req);
    expect(exists(incoming)).toBe(true);

    expect((await del()).status).toBe(202);
    expect(runs[0].cancelCalls).toBe(1);
    expect((await getJob())?.state).toBe('running');

    runs[0].post({ type: 'done', result });
    expect(await getJob()).toMatchObject({ state: 'cancelled', error: null, result: null });
    expect(exists(incoming)).toBe(false);
    expect(leftovers()).toEqual([]);
    runs[0].exit();

    expect(md5(lnm)).toBe(lnmBefore);
    expect(md5(sim)).toBe(simBefore);
    expect((getLnmNavDb()!.prepare('SELECT snapshot_id FROM nav_meta').get() as { snapshot_id: string }).snapshot_id).toBe(labelBefore);
  });

  it('does the same when there is no Little Navmap replica yet: it is still absent', async () => {
    placeFile('second.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    await postPath('second.sqlite');
    const result = buildFor(runs[0].req);
    await del();
    runs[0].post({ type: 'done', result });
    expect((await getJob())?.state).toBe('cancelled');
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(getLnmNavDb()).toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('ends cancelled, not failed, when DELETE stops a running build whose worker exits with code 1', async () => {
    const { runner, runs } = fakeRunner();
    placeFile('second.sqlite', goodBytes);
    await start({ runner });
    await postPath('second.sqlite');
    runs[0].post({ type: 'progress', stage: 'procedures', done: 1, total: 3 });
    // terminate() leaves a partial incoming file and the worker exits without any message
    fs.writeFileSync(runs[0].req.incomingPath, 'partial');
    fs.writeFileSync(`${runs[0].req.incomingPath}-journal`, 'partial');

    const cancel = await del();
    expect(cancel.status).toBe(202);
    expect(cancel.body.job.state).toBe('running');
    expect(runs[0].cancelCalls).toBe(1);
    // not terminal until the worker has exited
    expect((await getJob())?.state).toBe('running');
    runs[0].exit();
    const job = await settled();
    expect(job).toMatchObject({ state: 'cancelled', error: null, stage: 'procedures' });
    expect(leftovers()).toEqual([]);
  });

  it('reports a worker error that arrives after a cancel as cancelled', async () => {
    const { runner, runs } = fakeRunner();
    placeFile('second.sqlite', goodBytes);
    await start({ runner });
    await postPath('second.sqlite');
    await del();
    runs[0].post({ type: 'error', code: 'LNM_WORKER_FAILED', message: 'import worker stopped unexpectedly' });
    expect(await getJob()).toMatchObject({ state: 'cancelled', error: null });
  });

  it('deletes the uploaded spool when a running upload is cancelled', async () => {
    const { runner, runs } = fakeRunner();
    await start({ runner });
    expect((await upload(goodBytes)).status).toBe(202);
    const spool = runs[0].req.sourcePath;
    expect(path.dirname(spool)).toBe(dir);
    expect(path.basename(spool).startsWith('navdata.db.lnm.upload-')).toBe(true);
    expect(exists(spool)).toBe(true);
    await del();
    runs[0].exit();
    expect((await settled()).state).toBe('cancelled');
    expect(exists(spool)).toBe(false);
  });

  it('never moves a job out of its terminal state: a message after the end changes nothing', async () => {
    const { runner, runs } = fakeRunner();
    placeFile('second.sqlite', goodBytes);
    await start({ runner });
    await postPath('second.sqlite');
    runs[0].post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' });
    const failed = await getJob();
    expect(failed?.state).toBe('failed');
    runs[0].post({ type: 'progress', stage: 'coverage', done: 1, total: 1 });
    runs[0].post({ type: 'done', result: buildFor(runs[0].req) });
    runs[0].exit();
    await new Promise(r => setTimeout(r, 20));
    expect(await getJob()).toEqual(failed);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
  });
});

describe('failure', () => {
  it('shows a non-LnmImportError from the build as "import failed in stage <stage>" and nothing else', async () => {
    placeFile('little.sqlite', goodBytes);
    const throwing: LnmImportRunner = {
      start(req, onMessage) {
        let exit!: () => void;
        const done = new Promise<void>(resolve => { exit = resolve; });
        setImmediate(() => {
          runLnmPipelineToMessages(req, onMessage, {
            converters: [{ stage: 'airports', run() { throw new Error('boom at ZZAA in /home/someone/atools.sqlite'); } }],
          });
          exit();
        });
        return { done, cancel() {} };
      },
    };
    await start({ runner: throwing });
    await postPath('little.sqlite');
    const job = await settled();
    expect(job).toMatchObject({ state: 'failed', error: { code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' } });
    expect(JSON.stringify(job)).not.toMatch(/boom|ZZAA|home/);
    expect(leftovers()).toEqual([]);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
  });

  it('fails with the worker code and message, and removes the incoming file and the upload spool', async () => {
    const { runner, runs } = fakeRunner();
    await start({ runner });
    expect((await upload(goodBytes)).status).toBe(202);
    fs.writeFileSync(runs[0].req.incomingPath, 'partial');
    runs[0].post({ type: 'error', code: 'LNM_DISK_FULL', message: 'disk full in stage procedures' });
    expect(await getJob()).toMatchObject({
      state: 'failed', error: { code: 'LNM_DISK_FULL', message: 'disk full in stage procedures' }, result: null,
    });
    expect(leftovers()).toEqual([]);
  });

  it('fails LNM_WORKER_FAILED when the runner stops without a result and nobody cancelled', async () => {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    await postPath('little.sqlite');
    runs[0].exit();
    expect(await settled()).toMatchObject({
      state: 'failed', error: { code: 'LNM_WORKER_FAILED', message: 'import worker stopped unexpectedly' },
    });
  });

  it('fails LNM_WORKER_FAILED when the runner cannot start', async () => {
    placeFile('little.sqlite', goodBytes);
    await start({ runner: { start() { throw new Error('cannot start'); } } });
    expect((await postPath('little.sqlite')).status).toBe(202);
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_WORKER_FAILED' } });
  });

  it('keeps the previous replica and fails LNM_VERIFY_FAILED when the built file does not match its result', async () => {
    placeFile('first.sqlite', goodBytes);
    await start();
    await postPath('first.sqlite');
    await settled();
    const lnm = resolveLnmNavdataPath();
    const before = md5(lnm);

    const { runner, runs } = fakeRunner();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
    await start({ runner });
    await postPath('first.sqlite');
    const result = buildFor(runs[0].req);
    runs[0].post({ type: 'done', result: { ...result, snapshotId: 'some-other-snapshot' } });
    runs[0].exit();
    const job = await settled();
    expect(job).toMatchObject({
      state: 'failed', error: { code: 'LNM_VERIFY_FAILED', message: 'verification failed: the header and the dataset row disagree' },
    });
    expect(md5(lnm)).toBe(before);
    expect(getLnmNavDb()).not.toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('fails LNM_VERIFY_FAILED, with a fixed message, for an incoming file that is not a replica', async () => {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    await postPath('little.sqlite');
    const result = buildFor(runs[0].req);
    // Replace the finished file with an empty database: it opens, but holds none of the replica tables.
    fs.rmSync(runs[0].req.incomingPath);
    new Database(runs[0].req.incomingPath).close();
    runs[0].post({ type: 'done', result });
    const job = await settled();
    expect(job?.state).toBe('failed');
    expect(job?.error?.code).toBe('LNM_VERIFY_FAILED');
    expect(job?.error?.message).toMatch(/^verification failed: [^\n/]+$/);
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe('the swap', () => {
  /** Holds the file sync that precedes the swap until the test lets it go. */
  function holdSync(): { release: () => void; opened: () => unknown[][] } {
    const original = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
      await gate;
      return original(...args);
    }) as never);
    return { release, opened: () => spy.mock.calls as unknown[][] };
  }

  async function finishedBuild(): Promise<{ run: FakeRun; result: LnmImportResult; incoming: string }> {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner });
    await postPath('little.sqlite');
    const run = runs[0];
    return { run, result: buildFor(run.req), incoming: run.req.incomingPath };
  }

  it('writes the built file to disk off the main thread first, and the runner exiting meanwhile is not a failure', async () => {
    const hold = holdSync();
    const { run, result, incoming } = await finishedBuild();
    run.post({ type: 'done', result });
    run.post({ type: 'progress', stage: 'coverage', done: 1, total: 2 });
    run.exit();
    await new Promise(r => setTimeout(r, 50));
    expect(await getJob()).toMatchObject({ state: 'running', stage: 'swapping', fraction: 0.99 });
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(hold.opened()).toEqual([[incoming, 'r+']]);
    hold.release();
    const job = await settled();
    expect(job).toMatchObject({ state: 'succeeded', stage: 'swapping', fraction: 1 });
    expect(exists(resolveLnmNavdataPath())).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('ends cancelled, with the previous replica untouched, when the user cancels while the file is being written out', async () => {
    placeFile('first.sqlite', goodBytes);
    await start();
    await postPath('first.sqlite');
    await settled();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
    const lnm = resolveLnmNavdataPath();
    const before = md5(lnm);

    const hold = holdSync();
    const { run, result, incoming } = await finishedBuild();
    run.post({ type: 'done', result });
    expect((await del()).status).toBe(202);
    hold.release();
    expect(await settled()).toMatchObject({ state: 'cancelled', error: null, result: null });
    expect(exists(incoming)).toBe(false);
    expect(md5(lnm)).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  it('does not swap after a shutdown that arrived while the file was being written out', async () => {
    const hold = holdSync();
    const { run, result, incoming } = await finishedBuild();
    run.post({ type: 'done', result });
    cancelLnmImportForShutdown();
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_INTERRUPTED' } });
    hold.release();
    await new Promise(r => setTimeout(r, 100));
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_INTERRUPTED' } });
    expect(exists(resolveLnmNavdataPath())).toBe(false);
    expect(exists(incoming)).toBe(false);
  });

  it('swaps in the file as the build leaves it, in WAL mode with no -wal or -shm: verified read-only, then served', async () => {
    const head = Buffer.alloc(2);
    const fd = fs.openSync(prebuilt.file, 'r');
    try {
      fs.readSync(fd, head, 0, 2, 18);
    } finally {
      fs.closeSync(fd);
    }
    // bytes 18 and 19 of the header are 2 in WAL mode
    expect([...head]).toEqual([2, 2]);
    expect(exists(`${prebuilt.file}-wal`) || exists(`${prebuilt.file}-shm`)).toBe(false);
    placeFile('little.sqlite', goodBytes);
    await start();
    await postPath('little.sqlite');
    expect(await settled()).toMatchObject({ state: 'succeeded', error: null });
    const db = getLnmNavDb();
    expect(db).not.toBeNull();
    expect(db!.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db!.prepare('SELECT COUNT(*) FROM nav_airport').pluck().get()).toBe(prebuilt.result.counts.airports);
    expect(db!.prepare('SELECT snapshot_id FROM nav_meta WHERE id = 1').pluck().get()).toBe(prebuilt.result.snapshotId);
    expect(leftovers()).toEqual([]);
  });

  it('goes on to the swap when the file cannot be opened for the last write-out before it', async () => {
    vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('no sync today'));
    const { run, result } = await finishedBuild();
    run.post({ type: 'done', result });
    expect((await settled()).state).toBe('succeeded');
    expect(exists(resolveLnmNavdataPath())).toBe(true);
  });
});

describe('writing the build out while it runs', () => {
  const INTERVAL = 10;

  /** Stands in for the incoming file's handle and counts what the route does to it. */
  function syncProbe(syncMs = 0) {
    const log = { opens: [] as string[], syncs: 0, closes: 0, running: 0, overlaps: 0 };
    const openForSync = async (file: string) => {
      log.opens.push(file);
      return {
        async sync() {
          log.syncs++;
          if (++log.running > 1) log.overlaps++;
          if (syncMs > 0) await new Promise(r => setTimeout(r, syncMs));
          log.running--;
        },
        async close() {
          log.closes++;
        },
      };
    };
    return { log, openForSync };
  }

  const quiet = (ms = 80): Promise<void> => new Promise(r => setTimeout(r, ms));

  async function running(openForSync: NavdataImportOptions['openForSync']) {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner, openForSync, syncIntervalMs: INTERVAL });
    await postPath('little.sqlite');
    return runs[0];
  }

  it('writes nothing out while the build is validating, and starts when the file begins to grow', async () => {
    const { log, openForSync } = syncProbe();
    const run = await running(openForSync);
    run.post({ type: 'progress', stage: 'validating', done: 0, total: 1 });
    run.post({ type: 'progress', stage: 'validating', done: 1, total: 1 });
    await quiet();
    expect(log).toMatchObject({ opens: [], syncs: 0 });
    run.post({ type: 'progress', stage: 'indexing', done: 0, total: 1 });
    await until(() => log.syncs >= 3, 'three write-outs');
    expect(log.opens).toEqual([run.req.incomingPath]);
    expect(log.closes).toBe(0);
  });

  it('keeps one handle for the whole build, writes out once more before the swap, and closes it before the swap', async () => {
    const { log, openForSync } = syncProbe();
    const run = await running(openForSync);
    run.post({ type: 'progress', stage: 'procedures', done: 1, total: 4 });
    await until(() => log.syncs >= 2, 'two write-outs');
    run.post({ type: 'progress', stage: 'procedures', done: 2, total: 4 });
    run.post({ type: 'progress', stage: 'coverage', done: 1, total: 2 });
    await quiet(40);
    const beforeDone = log.syncs;
    run.post({ type: 'done', result: buildFor(run.req) });
    expect(await settled()).toMatchObject({ state: 'succeeded' });
    expect(log.opens).toHaveLength(1);
    expect(log.closes).toBe(1);
    expect(log.syncs).toBeGreaterThan(beforeDone);
    const after = log.syncs;
    await quiet();
    expect(log.syncs).toBe(after);
    expect(log.opens).toHaveLength(1);
  });

  it('never runs two write-outs at once: a slow one delays the next', async () => {
    const { log, openForSync } = syncProbe(40);
    const run = await running(openForSync);
    run.post({ type: 'progress', stage: 'airports', done: 1, total: 2 });
    await until(() => log.syncs >= 3, 'three write-outs', 5000);
    expect(log.overlaps).toBe(0);
    run.post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' });
    await until(() => log.closes === 1, 'the handle to be closed');
  });

  const endings: [string, (run: FakeRun) => Promise<void>, string][] = [
    ['fails', async run => { run.post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' }); }, 'failed'],
    ['is cancelled', async run => { await del(); run.exit(); }, 'cancelled'],
    ['is interrupted by a shutdown', async () => { cancelLnmImportForShutdown(); }, 'failed'],
  ];
  it.each(endings)('stops and closes its handle once, and writes nothing more, when the job %s', async (_name, end, state) => {
    const { log, openForSync } = syncProbe();
    const run = await running(openForSync);
    run.post({ type: 'progress', stage: 'navaids', done: 1, total: 2 });
    await until(() => log.syncs >= 2, 'two write-outs');
    await end(run);
    expect((await settled()).state).toBe(state);
    await until(() => log.closes === 1, 'the handle to be closed');
    const after = log.syncs;
    await quiet();
    expect(log.syncs).toBe(after);
    expect(log).toMatchObject({ closes: 1, opens: [run.req.incomingPath] });
  });

  it('closes a handle that was still being opened when the job ended, and writes nothing through it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let closes = 0;
    let syncs = 0;
    const run = await running(async () => {
      await gate;
      return { async sync() { syncs++; }, async close() { closes++; } };
    });
    run.post({ type: 'progress', stage: 'airports', done: 0, total: 1 });
    await quiet(40);
    run.post({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airports' });
    expect((await getJob())?.state).toBe('failed');
    release();
    await until(() => closes === 1, 'the late handle to be closed');
    await quiet();
    expect({ closes, syncs }).toEqual({ closes: 1, syncs: 0 });
  });

  it('does not fail the import when the file cannot be opened for the write-out', async () => {
    const run = await running(async () => { throw new Error('no handle today'); });
    run.post({ type: 'progress', stage: 'airports', done: 1, total: 2 });
    await quiet(60);
    expect((await getJob())?.state).toBe('running');
    run.post({ type: 'done', result: buildFor(run.req) });
    expect((await settled()).state).toBe('succeeded');
  });

  it('does not fail the import when a write-out or the close of the handle fails', async () => {
    const run = await running(async () => ({
      async sync() { throw new Error('io error'); },
      async close() { throw new Error('close failed'); },
    }));
    run.post({ type: 'progress', stage: 'airports', done: 1, total: 2 });
    await quiet(60);
    run.post({ type: 'done', result: buildFor(run.req) });
    expect((await settled()).state).toBe('succeeded');
  });
});

describe('shutdown', () => {
  it('ends a running job failed LNM_INTERRUPTED, cancels the runner without waiting and removes the files', async () => {
    const { runner, runs } = fakeRunner();
    await start({ runner });
    expect((await upload(goodBytes)).status).toBe(202);
    fs.writeFileSync(runs[0].req.incomingPath, 'partial');
    cancelLnmImportForShutdown();
    expect(runs[0].cancelCalls).toBe(1);
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_INTERRUPTED' } });
    expect(leftovers()).toEqual([]);
    // a second call, and the runner exiting later, change nothing
    cancelLnmImportForShutdown();
    runs[0].exit();
    expect(runs[0].cancelCalls).toBe(1);
  });

  it('destroys an upload still arriving and removes its spool', async () => {
    await start();
    const { closed } = partialUpload(8000);
    await until(async () => (await getJob())?.state === 'receiving' && leftovers().length > 0, 'a receiving upload');
    cancelLnmImportForShutdown();
    expect(await getJob()).toMatchObject({ state: 'failed', error: { code: 'LNM_INTERRUPTED' } });
    await closed;
    await until(() => leftovers().length === 0, 'the spool to be removed');
    expect((await getJob())?.error?.code).toBe('LNM_INTERRUPTED');
  });

  it('does nothing when there is no job', async () => {
    await start();
    expect(() => cancelLnmImportForShutdown()).not.toThrow();
    expect(await getJob()).toBeNull();
  });
});

// ── Who may call it ──────────────────────────────────────────────────────────

describe('access', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/api/navdata/lnm-import'],
    ['GET', '/api/navdata/lnm-import/files'],
    ['POST', '/api/navdata/lnm-import/upload'],
    ['POST', '/api/navdata/lnm-import/path'],
    ['DELETE', '/api/navdata/lnm-import'],
  ];

  it('is not on the ingest token allowlist, so the token alone never reaches any of these routes', () => {
    for (const [method, route] of ROUTES) expect(isIngestScopedRoute(method, route), `${method} ${route}`).toBe(false);
  });

  it('answers 401 behind the session gate to a request with only an ingest token, and runs nothing', async () => {
    placeFile('little.sqlite', goodBytes);
    const { runner, runs } = fakeRunner();
    await start({ runner }, requireAuth);
    for (const [method, route] of ROUTES) {
      const r = await fetch(`${base}${route}`, {
        method,
        headers: { 'x-ingest-token': 'some-token', 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ fileName: 'little.sqlite' }) : undefined,
      });
      expect(r.status, `${method} ${route}`).toBe(401);
    }
    expect(runs).toHaveLength(0);
  });
});
