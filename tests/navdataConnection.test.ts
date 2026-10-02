import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { applyNavdataSchema } from '../src/navdata/schema';
import {
  openNavdata, getNavDb, swapInReplica, closeNavDb, resolveNavdataPath, incomingNavdataPath,
} from '../src/navdata/connection';
import { scratchDbRoot } from './helpers/scratchRoot';
import {
  effectiveNavdataSource, getActiveNavDb, getLnmNavDb, getSelectedNavdataSource, lnmUploadSpoolPath,
  isNavdataBusy, navdataImportDir, resolveLnmNavdataPath, setSelectedNavdataSource, swapInLnmReplica,
} from '../src/navdata/connection';

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

  it('creates a missing navdata directory, logging once, and then opens and sweeps in it as usual', () => {
    const d = scratch();
    const dir = path.join(d, 'not', 'yet', 'there');
    process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    openNavdata();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(getNavDb()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(`navdata: created the navdata directory ${path.basename(dir)}`);
    expect(String(log.mock.calls[0][0])).not.toContain(d);

    build(resolveNavdataPath(), 'epoch-1');
    fs.writeFileSync(path.join(dir, 'navdata.db.incoming-1-2'), 'x');
    openNavdata();
    expect(snapshotOf()).toBe('epoch-1');
    expect(fs.readdirSync(dir).filter(n => n.includes('.incoming-'))).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('keeps starting when the navdata directory cannot be created, and logs the reason code', () => {
    const d = scratch();
    const dir = path.join(d, 'denied');
    process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${dir}'`), { code: 'EACCES', syscall: 'mkdir' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => openNavdata()).not.toThrow();
    expect(getNavDb()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`navdata: cannot create the navdata directory ${path.basename(dir)}: EACCES`);
    expect(String(warn.mock.calls[0][0])).not.toContain(d);
    expect(fs.existsSync(dir)).toBe(false);
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

describe('two replicas', () => {
  const lnmFile = () => resolveLnmNavdataPath();
  const snapshotOfDb = (db: Database.Database | null) =>
    (db!.prepare('SELECT snapshot_id AS s FROM nav_meta').get() as { s: string }).s;
  const logged = (spy: unknown): string =>
    (spy as { mock: { calls: unknown[][] } }).mock.calls.map(c => c.join(' ')).join('\n');

  afterEach(() => {
    setSelectedNavdataSource('mcdu');
  });

  it('derives the Little Navmap paths from the simulator replica path', () => {
    const d = scratch();
    expect(lnmFile()).toBe(`${resolveNavdataPath()}.lnm`);
    expect(navdataImportDir()).toBe(d);
    const spool = lnmUploadSpoolPath();
    expect(path.dirname(spool)).toBe(d);
    expect(path.basename(spool)).toMatch(/^navdata\.db\.lnm\.upload-\d+-\d+$/);
    expect(incomingNavdataPath(lnmFile())).toMatch(/navdata\.db\.lnm\.incoming-\d+-\d+$/);
  });

  it('opens both files as separate handles, getNavDb staying the simulator replica', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-1');
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-1');
    // Selecting the other source never changes what getNavDb() means.
    setSelectedNavdataSource('lnm');
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-1');
    expect(snapshotOfDb(getActiveNavDb())).toBe('lnm-1');
  });

  it('serves the selected source, and the simulator replica when the selected one is absent', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    openNavdata();
    expect(getLnmNavDb()).toBeNull();
    expect(getSelectedNavdataSource()).toBe('mcdu');
    setSelectedNavdataSource('lnm');
    expect(getSelectedNavdataSource()).toBe('lnm');
    expect(effectiveNavdataSource()).toBe('mcdu');
    expect(getActiveNavDb()).toBe(getNavDb());

    build(lnmFile(), 'lnm-1');
    openNavdata();
    expect(effectiveNavdataSource()).toBe('lnm');
    expect(getActiveNavDb()).toBe(getLnmNavDb());
    setSelectedNavdataSource('mcdu');
    expect(effectiveNavdataSource()).toBe('mcdu');
    expect(getActiveNavDb()).toBe(getNavDb());
  });

  it('treats an unusable Little Navmap file as absent while the simulator replica still opens', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    const db = new Database(lnmFile());
    db.exec('UPDATE nav_meta SET schema_version = 1');
    db.close();
    openNavdata();
    expect(getLnmNavDb()).toBeNull();
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-1');
    setSelectedNavdataSource('lnm');
    expect(effectiveNavdataSource()).toBe('mcdu');
  });

  it('clears stale incoming and upload files of both replicas and nothing else', () => {
    const d = scratch();
    const stale = [
      'navdata.db.incoming-1-2', 'navdata.db.incoming-1-2-wal',
      'navdata.db.lnm.incoming-1-2', 'navdata.db.lnm.incoming-1-2-journal',
      'navdata.db.lnm.incoming-1-2-wal', 'navdata.db.lnm.incoming-1-2-shm',
      'navdata.db.lnm.upload-1-2',
    ];
    const kept = ['little_navmap_msfs.sqlite', 'flights.db', 'navdata.db.lnm.upload', 'notes.txt'];
    for (const name of [...stale, ...kept]) fs.writeFileSync(path.join(d, name), 'x');
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    expect(fs.readdirSync(d).sort()).toEqual(
      [...kept, 'navdata.db', 'navdata.db.lnm', 'navdata.db.lnm-shm', 'navdata.db.lnm-wal', 'navdata.db-shm', 'navdata.db-wal'].sort(),
    );
  });

  it('closeNavDb closes both handles', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    const mcdu = getNavDb()!;
    const lnm = getLnmNavDb()!;
    closeNavDb();
    expect(mcdu.open).toBe(false);
    expect(lnm.open).toBe(false);
    expect(getNavDb()).toBeNull();
    expect(getLnmNavDb()).toBeNull();
  });

  it('swapInLnmReplica replaces only the Little Navmap file', () => {
    const d = scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    const mcdu = getNavDb()!;
    const incoming = incomingNavdataPath(lnmFile());
    build(incoming, 'lnm-2');
    let verified = '';
    swapInLnmReplica(incoming, (check) => { verified = snapshotOfDb(check); });
    expect(verified).toBe('lnm-2');
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-2');
    expect(getNavDb()).toBe(mcdu);
    expect(mcdu.open).toBe(true);
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-1');
    expect(fs.readdirSync(d).filter(n => n.includes('.incoming-'))).toEqual([]);
  });

  it('swapInReplica replaces only the simulator file', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    const lnm = getLnmNavDb()!;
    const incoming = incomingNavdataPath();
    build(incoming, 'mcdu-2');
    swapInReplica(incoming);
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-2');
    expect(getLnmNavDb()).toBe(lnm);
    expect(snapshotOfDb(lnm)).toBe('lnm-1');
  });

  it('swapInLnmReplica creates the file when there was none, and a failed verify keeps the old one', () => {
    scratch();
    openNavdata();
    expect(getLnmNavDb()).toBeNull();
    const first = incomingNavdataPath(lnmFile());
    build(first, 'lnm-1');
    swapInLnmReplica(first);
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-1');

    const second = incomingNavdataPath(lnmFile());
    build(second, 'lnm-2');
    expect(() => swapInLnmReplica(second, () => { throw new Error('bad footer'); })).toThrow('bad footer');
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-1');
    expect(fs.existsSync(second)).toBe(false);
  });

  const failRename = (incoming: string) =>
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${incoming}'`), { code: 'EPERM' });
    });

  it('a rename that fails during an LNM swap keeps serving the old file', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-1');
    build(lnmFile(), 'lnm-old');
    openNavdata();
    const mcdu = getNavDb()!;
    const incoming = incomingNavdataPath(lnmFile());
    build(incoming, 'lnm-new');
    failRename(incoming);
    expect(() => swapInLnmReplica(incoming)).toThrow(/EPERM/);
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-old');
    expect(getNavDb()).toBe(mcdu);
    expect(fs.existsSync(incoming)).toBe(false);
    expect(isNavdataBusy()).toBe(false);
    // The file on disk is still the old one, so a later open sees it too.
    openNavdata();
    expect(snapshotOfDb(getLnmNavDb())).toBe('lnm-old');
  });

  it('a rename that fails during a simulator swap keeps serving the old file', () => {
    scratch();
    build(resolveNavdataPath(), 'mcdu-old');
    build(lnmFile(), 'lnm-1');
    openNavdata();
    const lnm = getLnmNavDb()!;
    const incoming = incomingNavdataPath();
    build(incoming, 'mcdu-new');
    failRename(incoming);
    expect(() => swapInReplica(incoming)).toThrow(/EPERM/);
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-old');
    expect(getLnmNavDb()).toBe(lnm);
    expect(fs.existsSync(incoming)).toBe(false);
    openNavdata();
    expect(snapshotOfDb(getNavDb())).toBe('mcdu-old');
  });

  it('a rename that fails when there was no file leaves the slot empty', () => {
    scratch();
    openNavdata();
    const incoming = incomingNavdataPath(lnmFile());
    build(incoming, 'lnm-new');
    failRename(incoming);
    expect(() => swapInLnmReplica(incoming)).toThrow(/EPERM/);
    expect(getLnmNavDb()).toBeNull();
    expect(fs.existsSync(incoming)).toBe(false);
  });

  it('log lines name the file by its base name, never an absolute path', () => {
    const d = scratch();
    // A wrong schema version, a file that is not a database, and a failed swap.
    build(resolveNavdataPath(), 'mcdu-1');
    const db = new Database(resolveNavdataPath());
    db.exec('UPDATE nav_meta SET schema_version = 1');
    db.close();
    fs.writeFileSync(lnmFile(), 'this is not a database');
    fs.writeFileSync(path.join(d, 'navdata.db.lnm.upload-1-2'), 'x');
    openNavdata();
    const incoming = incomingNavdataPath(lnmFile());
    build(incoming, 'lnm-new');
    failRename(incoming);
    expect(() => swapInLnmReplica(incoming)).toThrow();

    const lines = logged(console.warn) + '\n' + logged(console.error);
    expect(lines).toContain('navdata.db has schema_version 1');
    expect(lines).toContain('cannot open navdata.db.lnm:');
    expect(lines).toContain('navdata.db.lnm was not replaced');
    expect(lines).not.toContain(d);
    expect(lines).not.toContain(path.dirname(d));
  });
});
