import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { applyNavdataSchema } from '../src/navdata/schema';
import {
  openNavdata, getNavDb, swapInReplica, closeNavDb, resolveNavdataPath, incomingNavdataPath,
} from '../src/navdata/connection';
import { scratchDbRoot } from './helpers/scratchRoot';

const dirs: string[] = [];
const savedEnv = process.env.NAVDATA_DB_PATH;

function scratch(): string {
  const d = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-test-'));
  dirs.push(d);
  process.env.NAVDATA_DB_PATH = path.join(d, 'navdata.db');
  return d;
}

function build(file: string, snapshotId: string): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  applyNavdataSchema(db);
  db.prepare(
    "INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at) VALUES (1, 2, ?, '2024', 1, 1)",
  ).run(snapshotId);
  db.close();
}

const snapshotOf = () => (getNavDb()!.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string }).s;

afterEach(() => {
  closeNavDb();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH;
  else process.env.NAVDATA_DB_PATH = savedEnv;
});

describe('navdata connection', () => {
  it('resolves the env override and the cwd default', () => {
    process.env.NAVDATA_DB_PATH = '/x/y.db';
    expect(resolveNavdataPath()).toBe('/x/y.db');
    delete process.env.NAVDATA_DB_PATH;
    expect(resolveNavdataPath()).toBe(path.join(process.cwd(), 'navdata.db'));
  });

  it('opens absent when there is no file, and clears stale incoming files', () => {
    const d = scratch();
    fs.writeFileSync(path.join(d, 'navdata.db.incoming-1-2'), 'x');
    openNavdata();
    expect(getNavDb()).toBeNull();
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it('swaps in a new epoch: old handle closed and stale -wal/-shm gone before the rename', () => {
    const d = scratch();
    build(resolveNavdataPath(), 'epoch-1');
    openNavdata();
    const old = getNavDb()!;
    old.exec('CREATE TABLE scratch_t (x)'); // keep the live WAL non-empty
    const wal = `${resolveNavdataPath()}-wal`;
    expect(fs.existsSync(wal)).toBe(true);

    const incoming = incomingNavdataPath();
    build(incoming, 'epoch-2');

    const realUnlink = fs.unlinkSync;
    const openAtUnlink: boolean[] = [];
    vi.spyOn(fs, 'unlinkSync').mockImplementation((f) => {
      if (String(f).endsWith('-wal')) openAtUnlink.push(old.open);
      realUnlink(f);
    });
    const realRename = fs.renameSync;
    let atRename: { oldOpen: boolean; wal: boolean; shm: boolean } | null = null;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      atRename = {
        oldOpen: old.open,
        wal: fs.existsSync(`${resolveNavdataPath()}-wal`),
        shm: fs.existsSync(`${resolveNavdataPath()}-shm`),
      };
      realRename(from, to);
    });
    swapInReplica(incoming);

    expect(openAtUnlink).toEqual([false]);
    expect(atRename).toEqual({ oldOpen: false, wal: false, shm: false });
    expect(old.open).toBe(false);
    expect(snapshotOf()).toBe('epoch-2');
    const fresh = new Database(resolveNavdataPath(), { readonly: true });
    expect((fresh.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string }).s).toBe('epoch-2');
    fresh.close();
    closeNavDb();
    expect(fs.readdirSync(d)).toEqual(['navdata.db']);
  });

  it('swaps into a directory with no prior navdata.db', () => {
    scratch();
    openNavdata();
    const incoming = incomingNavdataPath();
    build(incoming, 'epoch-1');
    swapInReplica(incoming);
    expect(snapshotOf()).toBe('epoch-1');
  });

  it('leaves no incoming -wal/-shm orphans after a successful swap with a verify', () => {
    const d = scratch();
    build(resolveNavdataPath(), 'epoch-1');
    openNavdata();
    const incoming = incomingNavdataPath();
    build(incoming, 'epoch-2');
    let verified = false;
    swapInReplica(incoming, (check) => {
      verified = (check.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string }).s === 'epoch-2';
    });
    expect(verified).toBe(true);
    expect(snapshotOf()).toBe('epoch-2');
    expect(fs.readdirSync(d).filter(n => n.includes('.incoming-'))).toEqual([]);
  });

  it('a failed verify leaves the live replica untouched and drops the temp', () => {
    const d = scratch();
    build(resolveNavdataPath(), 'epoch-1');
    openNavdata();
    const incoming = incomingNavdataPath();
    build(incoming, 'epoch-2');
    expect(() => swapInReplica(incoming, () => { throw new Error('bad footer'); })).toThrow('bad footer');
    expect(snapshotOf()).toBe('epoch-1');
    expect(fs.existsSync(incoming)).toBe(false);
    expect(fs.readdirSync(d)).toContain('navdata.db');
  });

  it('treats a wrong schema_version as absent', () => {
    scratch();
    build(resolveNavdataPath(), 'epoch-1');
    const db = new Database(resolveNavdataPath());
    db.exec('UPDATE nav_meta SET schema_version = 1');
    db.close();
    openNavdata();
    expect(getNavDb()).toBeNull();
  });
});
