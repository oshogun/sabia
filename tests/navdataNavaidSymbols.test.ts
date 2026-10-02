// The three new navaid-symbol fields (isNav, isTacan, magvar) on
// /api/navdata/features, against a real scratch replica.

import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNavdataRouter } from '../src/routes/navdata';
import { requireSameOrigin } from '../src/auth/middleware';
import { SidecarStateStore } from '../src/navdata/sidecarState';
import { applyNavdataSchema } from '../src/navdata/schema';
import { closeNavDb, openNavdata } from '../src/navdata/connection';
import { scratchDbRoot } from './helpers/scratchRoot';

let dir: string;
let server: Server;
let base: string;
let state: SidecarStateStore;

type Row = Record<string, string | number | null>;

function insert(db: Database.Database, table: string, r: Row): void {
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(r));
}

function buildReplica(fill: (db: Database.Database) => void): void {
  const file = process.env.NAVDATA_DB_PATH!;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyNavdataSchema(db);
  insert(db, 'nav_meta', {
    id: 1, schema_version: 2, snapshot_id: 'epoch-1', rev: 7, sim_id: '2024',
    bulk_completed_at: 5, created_at: 1, updated_at: 2,
  });
  fill(db);
  db.close();
  openNavdata();
}

const nav = (kind: string, ident: string, extra: Row = {}): Row =>
  ({ kind, ident, region: 'XX', lat: 10, lon: 20, detail_state: 'index', rev: 1, ...extra });

const get = (p: string) => fetch(`${base}${p}`);
const features = async (q: string) => (await (await get(`/api/navdata/features?${q}`)).json()) as any;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-navaid-symbols-'));
  process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
  closeNavDb();
  openNavdata();
  state = new SidecarStateStore();
  const app = express();
  app.use(express.json());
  app.use(requireSameOrigin);
  app.use('/api', createNavdataRouter(state));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeNavDb();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NAVDATA_DB_PATH;
});

describe('navaid-symbol truth table', () => {
  it('case a: is_nav=1, is_tacan=1, magvar=346.5 -> isNav:true, isTacan:true, magvar:346.5', async () => {
    buildReplica(db => {
      insert(db, 'nav_navaid', nav('V', 'VOR', { is_nav: 1, is_tacan: 1, magvar: 346.5 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=8');
    expect(body.navaids).toEqual([
      expect.objectContaining({
        kind: 'V', ident: 'VOR', isNav: true, isTacan: true, magvar: 346.5,
      }),
    ]);
  });

  it('case b: is_nav=0, is_tacan=1, magvar=0 -> isNav:false, isTacan:true, magvar:0', async () => {
    buildReplica(db => {
      insert(db, 'nav_navaid', nav('V', 'TCN', { is_nav: 0, is_tacan: 1, magvar: 0 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=8');
    expect(body.navaids).toEqual([
      expect.objectContaining({
        kind: 'V', ident: 'TCN', isNav: false, isTacan: true, magvar: 0,
      }),
    ]);
  });

  it('case c: index-only row with all three columns NULL -> isNav:null, isTacan:null, magvar:null', async () => {
    buildReplica(db => {
      insert(db, 'nav_navaid', nav('V', 'IDX', { is_nav: null, is_tacan: null, magvar: null }));
    });
    const body = await features('bbox=19,9,21,11&zoom=8');
    expect(body.navaids).toEqual([
      expect.objectContaining({
        kind: 'V', ident: 'IDX', isNav: null, isTacan: null, magvar: null,
      }),
    ]);
  });

  it('case d: an N row with magvar=3 and NULL flags -> isNav:null, isTacan:null, magvar:3', async () => {
    buildReplica(db => {
      insert(db, 'nav_navaid', nav('N', 'NDB', { is_nav: null, is_tacan: null, magvar: 3 }));
    });
    const body = await features('bbox=19,9,21,11&zoom=8');
    expect(body.navaids).toEqual([
      expect.objectContaining({
        kind: 'N', ident: 'NDB', isNav: null, isTacan: null, magvar: 3,
      }),
    ]);
  });

  it('case e: existing fields (kind, ident, region, lat, lon, frequencyHz, name, navType, isDme) are unchanged', async () => {
    buildReplica(db => {
      insert(db, 'nav_navaid', nav('V', 'VOR', {
        lat: 10.5, lon: 20.5, frequency_hz: 114500000, name: 'Test VOR', nav_type: 1, is_dme: 1, is_nav: 1, is_tacan: 1, magvar: 346.5,
      }));
    });
    const body = await features('bbox=19,9,21,11&zoom=8');
    expect(body.navaids[0]).toMatchObject({
      kind: 'V', ident: 'VOR', region: 'XX', lat: 10.5, lon: 20.5,
      frequencyHz: 114500000, name: 'Test VOR', navType: 1, isDme: true,
    });
  });
});
