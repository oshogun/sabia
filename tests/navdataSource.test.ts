// The selected navdata source: its stored setting, and the dataset label and
// validity read from a replica. Synthetic cycles, dates and labels only.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../src/db';
import { getSetting, setSetting } from '../src/db/settings';
import {
  closeNavDb, effectiveNavdataSource, getSelectedNavdataSource, openNavdata, setSelectedNavdataSource,
} from '../src/navdata/connection';
import { isExpired, LNM_DATASET_DDL, readNavdataDataset } from '../src/navdata/dataset';
import { applyNavdataSchema } from '../src/navdata/schema';
import {
  NAVDATA_SOURCE_SETTING, navdataSourceState, readNavdataSourceSetting, writeNavdataSourceSetting,
} from '../src/navdata/source';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';
import { scratchDbRoot } from './helpers/scratchRoot';

const savedEnv = process.env.NAVDATA_DB_PATH;
let scratch: ScratchDb;
let dir: string;

beforeEach(() => {
  scratch = createScratchDb();
  dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-source-'));
  process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
});

afterEach(() => {
  setSelectedNavdataSource('mcdu');
  closeNavDb();
  destroyScratchDb(scratch);
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

interface MetaOpts { snapshotId?: string; simAppName?: string | null; simAppVersion?: string | null; createdAt?: number }

function memoryReplica(opts: MetaOpts = {}, withMeta = true): Database.Database {
  const db = new Database(':memory:');
  applyNavdataSchema(db);
  if (withMeta) {
    db.prepare(
      `INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, sim_app_name, sim_app_version, created_at, updated_at)
       VALUES (1, 2, ?, '2024', ?, ?, ?, 2)`,
    ).run(opts.snapshotId ?? 'snap-1', opts.simAppName ?? null, opts.simAppVersion ?? null, opts.createdAt ?? 1_700_000_000_000);
  }
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

describe('stored navdata source', () => {
  it('reads as the simulator source when no row exists', () => {
    expect(getSetting(NAVDATA_SOURCE_SETTING)).toBeNull();
    expect(readNavdataSourceSetting()).toBe('mcdu');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reads back what was written, one app_setting row named navdata_source', () => {
    writeNavdataSourceSetting('lnm');
    expect(NAVDATA_SOURCE_SETTING).toBe('navdata_source');
    expect(readNavdataSourceSetting()).toBe('lnm');
    const rows = scratch.db.prepare("SELECT name, value FROM app_setting WHERE name = 'navdata_source'").all();
    expect(rows).toEqual([{ name: 'navdata_source', value: 'lnm' }]);
    writeNavdataSourceSetting('mcdu');
    expect(readNavdataSourceSetting()).toBe('mcdu');
  });

  it('survives closing and reopening flights.db', () => {
    writeNavdataSourceSetting('lnm');
    closeDb();
    initDb(scratch.file);
    expect(readNavdataSourceSetting()).toBe('lnm');
  });

  it('reads an unrecognised value as the simulator source and says so', () => {
    for (const value of ['LNM', 'garbage', ' lnm']) {
      vi.mocked(console.warn).mockClear();
      setSetting(NAVDATA_SOURCE_SETTING, value);
      expect(readNavdataSourceSetting()).toBe('mcdu');
      expect(console.warn).toHaveBeenCalledTimes(1);
    }
    // The stored value is never rewritten by a read.
    expect(getSetting(NAVDATA_SOURCE_SETTING)).toBe(' lnm');
  });

  it('a restart restores the selection, and a missing replica still falls back at read time', () => {
    for (const [file, id] of [[process.env.NAVDATA_DB_PATH!, 'mcdu-1'], [`${process.env.NAVDATA_DB_PATH}.lnm`, 'lnm-1']]) {
      const db = new Database(file);
      applyNavdataSchema(db);
      db.prepare(
        "INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at) VALUES (1, 2, ?, '2024', 1, 1)",
      ).run(id);
      db.close();
    }
    writeNavdataSourceSetting('lnm');

    // A fresh process starts from the default and reads the stored choice.
    setSelectedNavdataSource('mcdu');
    openNavdata();
    setSelectedNavdataSource(readNavdataSourceSetting());
    expect(getSelectedNavdataSource()).toBe('lnm');
    expect(navdataSourceState()).toEqual({ selected: 'lnm', effective: 'lnm', fallback: null });

    fs.rmSync(`${process.env.NAVDATA_DB_PATH}.lnm`);
    fs.rmSync(`${process.env.NAVDATA_DB_PATH}.lnm-wal`, { force: true });
    fs.rmSync(`${process.env.NAVDATA_DB_PATH}.lnm-shm`, { force: true });
    openNavdata();
    expect(effectiveNavdataSource()).toBe('mcdu');
    expect(navdataSourceState()).toEqual({ selected: 'lnm', effective: 'mcdu', fallback: 'lnm-unavailable' });
    expect(getSetting(NAVDATA_SOURCE_SETTING)).toBe('lnm');
  });
});

describe('isExpired', () => {
  it('expires at 00:00Z of the day after the last valid day', () => {
    expect(isExpired('2030-04-03', Date.UTC(2030, 3, 3, 23, 59, 59, 999))).toBe(false);
    expect(isExpired('2030-04-03', Date.UTC(2030, 3, 4, 0, 0, 0, 0))).toBe(true);
    expect(isExpired('2030-04-03', Date.UTC(2030, 0, 1))).toBe(false);
  });

  it('rolls over month and year ends', () => {
    expect(isExpired('2030-12-31', Date.UTC(2030, 11, 31, 23, 59, 59))).toBe(false);
    expect(isExpired('2030-12-31', Date.UTC(2031, 0, 1))).toBe(true);
    expect(isExpired('2032-02-29', Date.UTC(2032, 2, 1) - 1)).toBe(false);
    expect(isExpired('2032-02-29', Date.UTC(2032, 2, 1))).toBe(true);
  });

  it('is unknown without a usable date', () => {
    expect(isExpired(null, Date.now())).toBeNull();
    expect(isExpired('', Date.now())).toBeNull();
    expect(isExpired('2030-4-3', Date.now())).toBeNull();
    expect(isExpired('soon', Date.now())).toBeNull();
  });
});

describe('readNavdataDataset', () => {
  const NOW = Date.UTC(2030, 3, 1, 12);

  it('is null for no handle and for a replica with no nav_meta row', () => {
    expect(readNavdataDataset(null, 'mcdu', NOW)).toBeNull();
    expect(readNavdataDataset(null, 'lnm', NOW)).toBeNull();
    expect(readNavdataDataset(memoryReplica({}, false), 'mcdu', NOW)).toBeNull();
    expect(readNavdataDataset(memoryReplica({}, false), 'lnm', NOW)).toBeNull();
  });

  it('labels a simulator replica from its app name and version', () => {
    const db = memoryReplica({ simAppName: 'Synth Sim', simAppVersion: '3.4', createdAt: 42 });
    expect(readNavdataDataset(db, 'mcdu', NOW)).toEqual({
      source: 'mcdu', label: 'Simulator (Synth Sim 3.4)', provider: null, airacCycle: null, validFrom: null,
      validThrough: null, expired: null, compiledAt: null, navigraphUpdate: null, importedAt: 42,
    });
    expect(readNavdataDataset(memoryReplica({ simAppName: 'Synth Sim' }), 'mcdu', NOW)!.label).toBe('Simulator (Synth Sim)');
    expect(readNavdataDataset(memoryReplica({ simAppName: 'Synth Sim', simAppVersion: '' }), 'mcdu', NOW)!.label)
      .toBe('Simulator (Synth Sim)');
    expect(readNavdataDataset(memoryReplica(), 'mcdu', NOW)!.label).toBe('Simulator');
  });

  it('reports every stored field of a Little Navmap dataset, expired against the injected clock', () => {
    const db = memoryReplica();
    addDataset(db);
    const live = readNavdataDataset(db, 'lnm', NOW)!;
    expect(live).toEqual({
      source: 'lnm', label: 'Synthetic AIRAC 3003', provider: 'NAVIGRAPH', airacCycle: '3003',
      validFrom: '2030-03-07', validThrough: '2030-04-03', expired: false,
      compiledAt: '2030-03-01T10:20:30.123', navigraphUpdate: null, importedAt: 1_800_000_000_000,
    });
    expect(readNavdataDataset(db, 'lnm', Date.UTC(2030, 3, 4))!.expired).toBe(true);
  });

  it('reports a dataset with no validity as not knowable, and maps the Navigraph-update flag', () => {
    for (const [stored, expected] of [[0, false], [1, true], [null, null]] as const) {
      const db = memoryReplica();
      addDataset(db, {
        data_source: 'MSFS', airac_cycle: null, valid_from: null, valid_through: null,
        navigraph_update: stored, label: 'Synthetic scenery',
      });
      expect(readNavdataDataset(db, 'lnm', NOW)).toMatchObject({
        provider: 'MSFS', airacCycle: null, validFrom: null, validThrough: null, expired: null,
        navigraphUpdate: expected, label: 'Synthetic scenery',
      });
    }
  });

  it('falls back to the nav_meta text when the file has no matching lnm_dataset row', () => {
    const noTable = memoryReplica({ simAppVersion: 'Synthetic text', createdAt: 7 });
    expect(readNavdataDataset(noTable, 'lnm', NOW)).toEqual({
      source: 'lnm', label: 'Synthetic text', provider: null, airacCycle: null, validFrom: null,
      validThrough: null, expired: null, compiledAt: null, navigraphUpdate: null, importedAt: 7,
    });
    expect(readNavdataDataset(memoryReplica(), 'lnm', NOW)!.label).toBe('Little Navmap import');

    const stale = memoryReplica({ snapshotId: 'snap-new' });
    addDataset(stale, { snapshot_id: 'snap-old' });
    expect(readNavdataDataset(stale, 'lnm', NOW)).toMatchObject({ label: 'Little Navmap import', airacCycle: null });
  });

  it('never reads lnm_dataset for the simulator source', () => {
    const db = memoryReplica({ simAppName: 'Synth Sim' });
    addDataset(db);
    expect(readNavdataDataset(db, 'mcdu', NOW)).toMatchObject({ source: 'mcdu', label: 'Simulator (Synth Sim)', airacCycle: null });
  });
});

describe('LNM_DATASET_DDL', () => {
  it('is idempotent and constrains the single row and the data source', () => {
    const db = memoryReplica();
    db.exec(LNM_DATASET_DDL);
    db.exec(LNM_DATASET_DDL);
    addDataset(db);
    expect(() => addDataset(db, { id: 2 })).toThrow();
    const other = memoryReplica();
    expect(() => addDataset(other, { data_source: 'OTHER' })).toThrow();
    expect(() => addDataset(memoryReplica(), { navigraph_update: 2 })).toThrow();
  });
});
