// The navdata status contract: which source answered, what the dataset is, and
// whether it has expired. Synthetic cycles, dates and labels only.

import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavdataRouter } from '../src/routes/navdata';
import { LNM_DATASET_DDL } from '../src/navdata/dataset';
import { closeNavDb, openNavdata, resolveLnmNavdataPath, resolveNavdataPath, setSelectedNavdataSource } from '../src/navdata/connection';
import { readStatus } from '../src/navdata/query';
import { SidecarStateStore } from '../src/navdata/sidecarState';
import { applyNavdataSchema } from '../src/navdata/schema';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';
import { scratchDbRoot } from './helpers/scratchRoot';

interface MetaOpts { snapshotId?: string; simAppName?: string | null; simAppVersion?: string | null; createdAt?: number }

function replica(opts: MetaOpts = {}, file = ':memory:'): Database.Database {
  const db = new Database(file);
  applyNavdataSchema(db);
  db.prepare(
    `INSERT INTO nav_meta (id, schema_version, snapshot_id, rev, sim_id, sim_app_name, sim_app_version, created_at, updated_at)
     VALUES (1, 2, ?, 9, '2024', ?, ?, ?, 2)`,
  ).run(opts.snapshotId ?? 'snap-1', opts.simAppName ?? null, opts.simAppVersion ?? null, opts.createdAt ?? 1_700_000_000_000);
  db.prepare("INSERT INTO nav_airport (ident, lat, lon, detail_state, rev) VALUES ('ZZAA', 1, 2, 'detail', 1)").run();
  return db;
}

function addDataset(db: Database.Database, over: Record<string, string | number | null> = {}): void {
  db.exec(LNM_DATASET_DDL);
  const row = {
    id: 1, snapshot_id: 'snap-1', data_source: 'NAVIGRAPH', airac_cycle: '3003', valid_from: '2030-03-07',
    valid_through: '2030-04-03', compiled_at: '2030-03-01T10:20:30.123', navigraph_update: null,
    atools_db_version: '1.2', source_file_name: 'synthetic.sqlite', source_bytes: 10, imported_at: 1_800_000_000_000,
    label: 'Synthetic AIRAC 3003', ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO lnm_dataset (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(row);
}

const MCDU = { source: 'mcdu', selectedSource: 'mcdu' } as const;
const LNM = { source: 'lnm', selectedSource: 'lnm' } as const;

describe('readStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a simulator replica with its label and no validity', () => {
    const db = replica({ simAppName: 'Synth Sim', simAppVersion: '3.4', createdAt: 42 });
    const status = readStatus(db, null, null);
    expect(status).toMatchObject({
      present: true, schemaVersion: 2, snapshotId: 'snap-1', rev: 9, simId: '2024',
      simAppName: 'Synth Sim', simAppVersion: '3.4', snapshotAppliedAt: 42,
      counts: { airports: 1, airportsWithDetail: 1 },
      source: 'mcdu', selectedSource: 'mcdu', sourceFallback: null,
      dataset: {
        source: 'mcdu', label: 'Simulator (Synth Sim 3.4)', provider: null, airacCycle: null,
        validFrom: null, validThrough: null, expired: null, importedAt: 42,
      },
    });
  });

  it('reports a Little Navmap replica with its stored label, cycle and validity', () => {
    const db = replica({ simAppName: 'Little Navmap', simAppVersion: 'Synthetic AIRAC 3003' });
    addDataset(db);
    const status = readStatus(db, null, null, LNM, Date.UTC(2030, 2, 20));
    expect(status).toMatchObject({
      present: true, simAppName: 'Little Navmap', source: 'lnm', selectedSource: 'lnm', sourceFallback: null,
      dataset: {
        source: 'lnm', label: 'Synthetic AIRAC 3003', provider: 'NAVIGRAPH', airacCycle: '3003',
        validFrom: '2030-03-07', validThrough: '2030-04-03', expired: false, compiledAt: '2030-03-01T10:20:30.123',
        navigraphUpdate: null, importedAt: 1_800_000_000_000,
      },
    });
  });

  it('is expired once the valid-through day is over, against the system clock', () => {
    const db = replica();
    addDataset(db);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-04-03T23:59:59.000Z'));
    expect(readStatus(db, null, null, LNM).dataset?.expired).toBe(false);
    vi.setSystemTime(new Date('2030-04-04T00:00:00.000Z'));
    expect(readStatus(db, null, null, LNM).dataset?.expired).toBe(true);
    // An explicit clock wins over the system one.
    expect(readStatus(db, null, null, LNM, Date.UTC(2030, 0, 1)).dataset?.expired).toBe(false);
  });

  it('reports a scenery dataset with no validity as not knowable', () => {
    const db = replica();
    addDataset(db, {
      data_source: 'MSFS', airac_cycle: null, valid_from: null, valid_through: null, navigraph_update: 1,
      label: 'Synthetic scenery with Navigraph update',
    });
    expect(readStatus(db, null, null, LNM).dataset).toMatchObject({
      provider: 'MSFS', airacCycle: null, validThrough: null, expired: null, navigraphUpdate: true,
    });
  });

  it('names the fallback when Little Navmap data is selected but the simulator replica answers', () => {
    const db = replica({ simAppName: 'Synth Sim' });
    const status = readStatus(db, null, null, { source: 'mcdu', selectedSource: 'lnm' });
    expect(status).toMatchObject({
      source: 'mcdu', selectedSource: 'lnm', sourceFallback: 'lnm-unavailable',
      dataset: { source: 'mcdu', label: 'Simulator (Synth Sim)' },
    });
    expect(readStatus(db, null, null, { source: 'lnm', selectedSource: 'mcdu' }).sourceFallback).toBeNull();
  });

  it('fills the source fields and no dataset when there is no replica or no header', () => {
    const sidecar = { state: 'nav.ready', reason: null, snapshotId: null, rev: null, sentAt: 1, receivedAt: 2 } as any;
    expect(readStatus(null, sidecar, 5)).toMatchObject({
      present: false, counts: null, lastRowsAt: null, sidecar: { state: 'nav.ready', reason: null },
      source: 'mcdu', selectedSource: 'mcdu', sourceFallback: null, dataset: null,
    });
    expect(readStatus(null, null, null, { source: 'mcdu', selectedSource: 'lnm' })).toMatchObject({
      present: false, source: 'mcdu', selectedSource: 'lnm', sourceFallback: 'lnm-unavailable', dataset: null,
    });
    const headless = new Database(':memory:');
    applyNavdataSchema(headless);
    expect(readStatus(headless, null, null, LNM)).toMatchObject({ present: false, source: 'lnm', dataset: null });
  });

  it('answers as it did before for a caller that passes no source', () => {
    const db = replica();
    expect(readStatus(db, null, 11)).toEqual(readStatus(db, null, 11, MCDU, Date.now()));
    expect(readStatus(db, null, 11).lastRowsAt).toBe(11);
  });
});

describe('GET /api/navdata/status', () => {
  const savedEnv = process.env.NAVDATA_DB_PATH;
  let scratch: ScratchDb;
  let dir: string;
  let server: Server;
  let base: string;

  const status = async (): Promise<any> => (await fetch(`${base}/api/navdata/status`)).json();

  beforeEach(async () => {
    scratch = createScratchDb();
    dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-status-'));
    process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
    replica({ snapshotId: 'mcdu-snap', simAppName: 'Synth Sim', simAppVersion: '3.4' }, resolveNavdataPath()).close();
    const lnm = replica({ snapshotId: 'lnm-snap', simAppName: 'Little Navmap', simAppVersion: 'Synthetic AIRAC 3003' }, resolveLnmNavdataPath());
    addDataset(lnm, { snapshot_id: 'lnm-snap', valid_through: '2001-01-31' });
    lnm.close();
    openNavdata();
    const app = express();
    app.use(express.json());
    app.use('/api', createNavdataRouter(new SidecarStateStore()));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    setSelectedNavdataSource('mcdu');
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeNavDb();
    destroyScratchDb(scratch);
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
    else process.env.NAVDATA_DB_PATH = savedEnv;
  });

  it('answers for the simulator replica by default, with the four new fields', async () => {
    expect(await status()).toMatchObject({
      present: true, snapshotId: 'mcdu-snap', source: 'mcdu', selectedSource: 'mcdu', sourceFallback: null,
      dataset: { source: 'mcdu', label: 'Simulator (Synth Sim 3.4)', expired: null },
    });
  });

  it('answers for the selected Little Navmap replica, expired by its stored validity', async () => {
    setSelectedNavdataSource('lnm');
    expect(await status()).toMatchObject({
      present: true, snapshotId: 'lnm-snap', source: 'lnm', selectedSource: 'lnm', sourceFallback: null,
      dataset: { source: 'lnm', label: 'Synthetic AIRAC 3003', validThrough: '2001-01-31', expired: true },
    });
  });

  it('falls back to the simulator replica, naming why, when the selected replica is gone', async () => {
    setSelectedNavdataSource('lnm');
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(resolveLnmNavdataPath() + suffix, { force: true });
    openNavdata();
    expect(await status()).toMatchObject({
      present: true, snapshotId: 'mcdu-snap', source: 'mcdu', selectedSource: 'lnm', sourceFallback: 'lnm-unavailable',
      dataset: { source: 'mcdu' },
    });
  });
});
