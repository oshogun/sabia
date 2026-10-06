// The Little Navmap import pipeline end to end on the synthetic atools
// fixtures: both presets are imported through the in-process runner and the
// result is read back with the browser-facing queries; then the failure,
// cancel and worker-runner paths, the pragmas of both connections, the
// verification rules and the command line inspector. Invented idents only;
// no real navigation database is opened.

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/inspect-lnm-import';
import { createWorkerRunner, inProcessRunner, WORKER_MAX_OLD_GENERATION_MB, type WorkerHandle } from '../src/navdata/lnm';
import {
  INCOMING_FLUSH_BYTES, LnmCancelledError, openIncoming, openSource, removeIncomingFiles, runLnmPipeline,
  runLnmPipelineToMessages, toLnmWorkerError, verifyReplica, type LnmProgressMessage,
} from '../src/navdata/lnm/pipeline';
import { navaidsConverter } from '../src/navdata/lnm/navaids';
import {
  LnmImportError, type ConverterStats, type LnmConverter, type LnmImportResult, type LnmStage, type LnmWorkerMessage,
  type LnmWorkerRequest,
} from '../src/navdata/lnm/types';
import { buildRouteGeometry } from '../src/navdata/routeGeometry';
import { queryFeatures, readAirportDetail, readStatus } from '../src/navdata/query';
import { makePlannedLegWithChildren } from './helpers';
import {
  buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type LnmFixtureOverrides, type LnmFixtureSpec,
} from './helpers/lnmFixture';

// ── Scaffolding ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 1, 12);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = makeLnmFixtureDir();
  dirs.push(d);
  return d;
}

function request(source: string, incomingPath: string): LnmWorkerRequest {
  return {
    sourcePath: source, sourceFileName: path.basename(source), sourceBytes: fs.statSync(source).size,
    incomingPath, now: NOW,
  };
}

/** Every line the code under test logged since the test started (setup.ts mocks the console). */
function logged(): string[] {
  return [console.log, console.warn, console.error].flatMap(fn => vi.mocked(fn).mock.calls.map(c => c.join(' ')));
}

/** Files that exist at an incoming path, journal siblings included. */
const leftovers = (incoming: string): string[] =>
  ['', '-journal', '-wal', '-shm'].map(s => incoming + s).filter(f => fs.existsSync(f)).map(f => path.basename(f));

/** Bytes 18 and 19 of a SQLite file's header: 2 and 2 in WAL mode, 1 and 1 in a rollback-journal mode. */
function journalHeader(fd: number): number[] {
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 18);
  return [...head];
}

interface Built {
  dir: string;
  source: string;
  replica: string;
  messages: LnmWorkerMessage[];
  result: LnmImportResult;
  logs: string[];
  /** The directory as the build left it, read before anything opened the replica. */
  filesAtDone: string[];
}

/** Imports a fixture through the in-process runner, as the server's job would, and moves the replica to its final name. */
async function importFixture(spec: LnmFixtureSpec): Promise<Built> {
  const dir = freshDir();
  const source = buildLnmFixture(dir, spec);
  const incoming = path.join(dir, 'replica.db.incoming-1');
  const messages: LnmWorkerMessage[] = [];
  const logs: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); }));
  try {
    // handed the whole path on purpose: only the name may reach the replica and the logs
    await inProcessRunner.start({ ...request(source, incoming), sourceFileName: source }, m => messages.push(m)).done;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const last = messages[messages.length - 1];
  if (last?.type !== 'done') throw new Error(`the fixture import did not finish: ${JSON.stringify(last)}`);
  const filesAtDone = fs.readdirSync(dir).sort();
  const replica = path.join(dir, 'replica.db');
  fs.renameSync(incoming, replica);
  return { dir, source, replica, messages, result: last.result, logs, filesAtDone };
}

/**
 * One import per preset for the whole file: every full import writes the 777,600-cell
 * coverage grid, which is CPU-bound (about 1.8 s alone, several times that while the
 * full suite saturates the machine), so the hooks that wait for one get a longer limit
 * than the global one.
 */
const imports = new Map<string, Promise<Built>>();
const importOnce = (name: string, make: () => LnmFixtureSpec): Promise<Built> => {
  let built = imports.get(name);
  if (!built) {
    built = importFixture(make());
    imports.set(name, built);
  }
  return built;
};

const plan = (over: Parameters<typeof makePlannedLegWithChildren>[0]) => makePlannedLegWithChildren({
  departure_ident: 'ZZAA', departure_lat: 12, departure_lon: -165, departure_is_airport: 1,
  destination_ident: 'ZZAA', destination_lat: 12, destination_lon: -165, destination_is_airport: 1,
  waypoints: [], ...over,
});

// ── End to end, both flavours ────────────────────────────────────────────────

const FLAVOURS = [
  {
    name: 'Navigraph', make: (): LnmFixtureSpec => navigraph(),
    label: 'Navigraph AIRAC 2610', provider: 'NAVIGRAPH', airac: '2610', validThrough: '2026-10-28', navigraphUpdate: null,
    expiredAtNow: false,
    counts: {
      airports: 3, runways: 4, frequencies: 9, navaids: 5, waypoints: 8, airwayLegs: 5, procedures: 4, transitions: 13,
      legs: 28, coverageCells: 777_600,
    },
    airports: ['ZZAA', 'ZZAB'], frequenciesAtZzaa: 5,
  },
  {
    name: 'MSFS', make: (): LnmFixtureSpec => msfs(),
    label: 'MSFS 2020 scenery with Navigraph update, compiled 2026-09-27', provider: 'MSFS', airac: null, validThrough: null,
    navigraphUpdate: true, expiredAtNow: null,
    counts: {
      airports: 2, runways: 3, frequencies: 6, navaids: 5, waypoints: 11, airwayLegs: 5, procedures: 4, transitions: 13,
      legs: 28, coverageCells: 777_600,
    },
    airports: ['ZZAA', 'ZZAB'], frequenciesAtZzaa: 5,
  },
];

describe.each(FLAVOURS)('importing the $name fixture', flavour => {
  let built: Built;
  let db: Database.Database;
  const lnm = { source: 'lnm', selectedSource: 'lnm' } as const;

  beforeAll(async () => {
    built = await importOnce(flavour.name, flavour.make);
    db = new Database(built.replica, { readonly: true });
    // A full import of the fixture took over 30 s while the machine was saturated, so this hook gets 120 s.
  }, 120_000);
  afterAll(() => {
    db?.close();
  });

  it('reports every stage in order, each ending at done = total, and finishes with one done message', () => {
    const progress = built.messages.filter((m): m is LnmProgressMessage => m.type === 'progress');
    const stages = [...new Set(progress.map(m => m.stage))];
    expect(stages).toEqual([
      'validating', 'indexing', 'airports', 'navaids', 'waypoints', 'airways', 'procedures', 'finalising', 'coverage',
      'verifying',
    ]);
    for (const stage of stages) {
      const own = progress.filter(m => m.stage === stage);
      expect(own[0]).toMatchObject({ done: 0 });
      expect(own[own.length - 1].done).toBe(own[own.length - 1].total);
      expect(own[own.length - 1].total).toBeGreaterThan(0);
    }
    // a stage's messages are contiguous: no stage resumes after the next began
    expect(progress.map(m => m.stage)).toEqual([...progress.map(m => m.stage)].sort((a, b) => stages.indexOf(a) - stages.indexOf(b)));
    expect(built.messages.filter(m => m.type === 'done')).toHaveLength(1);
    expect(built.messages.filter(m => m.type === 'error')).toHaveLength(0);
    expect(built.messages[built.messages.length - 1].type).toBe('done');
  });

  it('returns the dataset and the row counts of the file it wrote', () => {
    const { result } = built;
    expect(result.counts).toEqual(flavour.counts);
    expect(result.dataset).toMatchObject({
      source: 'lnm', label: flavour.label, provider: flavour.provider, airacCycle: flavour.airac,
      validThrough: flavour.validThrough, navigraphUpdate: flavour.navigraphUpdate,
    });
    expect(result.snapshotId).toMatch(new RegExp(`^lnm-${flavour.provider.toLowerCase()}-${NOW}-[0-9a-f]{8}$`));
    expect(result.warnings).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stores the source file name without any directory', () => {
    expect(db.prepare('SELECT source_file_name FROM lnm_dataset').pluck().get()).toBe(path.basename(built.source));
  });

  it('leaves a WAL-mode file with no siblings beside it', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(built.filesAtDone).toEqual([path.basename(built.source), 'replica.db.incoming-1'].sort());
    const fd = fs.openSync(built.replica, 'r');
    try {
      expect(journalHeader(fd)).toEqual([2, 2]);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('is complete for readStatus: detail on every airport, a full coverage grid, nothing absent', () => {
    const status = readStatus(db, null, null, lnm, NOW);
    expect(status).toMatchObject({
      present: true, schemaVersion: 2, snapshotId: built.result.snapshotId, rev: 1, simAppName: 'Little Navmap',
      simAppVersion: flavour.label, source: 'lnm', selectedSource: 'lnm', sourceFallback: null,
      dataset: { source: 'lnm', label: flavour.label, expired: flavour.expiredAtNow },
    });
    expect(status.counts!.airports).toBe(flavour.counts.airports);
    expect(status.counts!.airportsWithDetail).toBe(status.counts!.airports);
    expect(status.counts!.coverageCells).toBe(777_600);
    expect(status.counts!.absent).toBe(0);
    expect(status.counts).toMatchObject({
      navaids: flavour.counts.navaids, waypoints: flavour.counts.waypoints, airwayLegs: flavour.counts.airwayLegs,
      runways: flavour.counts.runways, procedures: flavour.counts.procedures,
    });
  });

  it('marks every airport, navaid and waypoint as fully fetched, and the header as a completed bulk', () => {
    const one = (sql: string): unknown => db.prepare(sql).pluck().get();
    expect(one("SELECT COUNT(*) FROM nav_airport WHERE detail_state <> 'detail'")).toBe(0);
    expect(one("SELECT COUNT(*) FROM nav_navaid WHERE detail_state <> 'detail'")).toBe(0);
    expect(one("SELECT COUNT(*) FROM nav_waypoint WHERE routes_state <> 'fetched'")).toBe(0);
    expect(one('SELECT COUNT(*) FROM nav_meta WHERE bulk_completed_at IS NOT NULL AND bulk_completed_at >= bulk_started_at')).toBe(1);
    expect(one('SELECT bulk_row_count FROM nav_meta')).toBe(flavour.counts.airports);
    expect(one('SELECT snapshot_id FROM lnm_dataset')).toBe(built.result.snapshotId);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('finalises the counters from the finished tables', () => {
    const row = (ident: string): Record<string, number> =>
      db.prepare(
        'SELECT n_runways, detail_runways, n_approaches, n_departures, n_arrivals, detail_procedures FROM nav_airport WHERE ident = ?',
      ).get(ident) as Record<string, number>;
    expect(row('ZZAA')).toEqual({
      n_runways: 2, detail_runways: 2, n_approaches: 2, n_departures: 1, n_arrivals: 1, detail_procedures: 4,
    });
    expect(row('ZZAB')).toMatchObject({ n_runways: 1, n_approaches: 0, detail_procedures: 0 });
    // the number of distinct airways through a fix, not of leg rows: ZZW01 is on ZZ1, ZZ2 and ZZ3
    const routes = db.prepare("SELECT ident, n_routes FROM nav_waypoint WHERE ident LIKE 'ZZW0%' ORDER BY ident").all();
    expect(routes).toContainEqual({ ident: 'ZZW01', n_routes: 3 });
    expect(routes).toContainEqual({ ident: 'ZZW02', n_routes: 1 });
    expect(routes).toContainEqual({ ident: 'ZZW04', n_routes: 0 });
  });

  it('answers queryFeatures with the fixture airports, runways and a complete coverage', () => {
    const features = queryFeatures(db, {
      bbox: [-166, 11, -164, 13], zoom: 12, kinds: ['airports', 'navaids', 'waypoints', 'airways', 'runways'], limit: 100,
    });
    expect(features.gated).toEqual([]);
    expect(features.airports.map(a => a.ident).sort()).toEqual(flavour.airports);
    expect(features.airports.find(a => a.ident === 'ZZAA')).toMatchObject({ hasDetail: true, runways: 2, procedures: 4 });
    expect(features.runways.length).toBeGreaterThanOrEqual(3);
    expect(features.navaids.map(n => n.ident)).toContain('ZZV');
    expect(features.coverage.airportsComplete).toBe(true);
    for (const kind of ['V', 'N', 'W'] as const) {
      expect(features.coverage.byKind[kind].fraction).toBe(1);
      expect(features.coverage.byKind[kind].harvestedCells).toBe(features.coverage.totalCells);
    }
  });

  it('answers readAirportDetail with runways, frequencies and the procedures that were imported', () => {
    const detail = readAirportDetail(db, 'zzaa')!;
    expect(detail).toMatchObject({ ident: 'ZZAA', detailState: 'detail', name: 'Zed Alpha Intl' });
    expect(detail.runways).toHaveLength(2);
    expect(detail.frequencies).toHaveLength(flavour.frequenciesAtZzaa);
    expect(detail.procedures.map(p => `${p.kind} ${p.name}`).sort()).toEqual([
      'APPROACH 4-27R', 'APPROACH 4-27R', 'SID ZZ1D', 'STAR ZZ2A',
    ]);
    expect(readAirportDetail(db, 'ZZNONE')).toBeNull();
  });

  it('resolves a SID, a STAR and an approach through buildRouteGeometry with every point placed', () => {
    const r = buildRouteGeometry(plan({
      sid_name: 'ZZ1D', sid_runway: '09L', sid_transition: 'ZZW04',
      star_name: 'ZZ2A', star_runway: '27R', star_transition: 'ZZW06',
      approach_name: 'ZZW02', approach_runway: '27R', approach_type: 'ILS', approach_arinc: 'I27R', approach_transition: 'ZZV',
    }), db);
    expect(r.unresolved).toEqual([]);
    expect(r.sid.source).toBe('ZZAA|SID|ZZ1D|||');
    expect(r.sid.points.map(p => p.ident)).toEqual(['ZZW01', 'ZZW02', 'ZZW03', 'ZZW04']);
    expect(r.star.points.map(p => p.ident)).toEqual(['ZZW06', 'ZZW03', 'ZZW02', 'ZZW01', 'ZZT01']);
    expect(r.approach.source).toBe('ZZAA|APPROACH|4-27R|27|2|0');
    // the DME-arc transition from ZZV first, then the final: IF, the arc's end, the runway fix
    expect(r.approach.points.map(p => p.ident)).toEqual(['ZZV', 'ZZW01', 'ZZW02', 'ZZW01', 'ZZW02', 'RW27R']);
    expect(r.approach.arcs).toHaveLength(1);
    expect(r.approach.arcs[0]).toMatchObject({ fromIndex: 0, toIndex: 1, turn: 'L' });
    expect(Number.isFinite(r.approach.arcs[0].centerLat) && Number.isFinite(r.approach.arcs[0].centerLon)).toBe(true);
    // both presets name the VOR with its region, so the arc centre is the VOR and not a localiser of the same ident
    expect(r.approach.arcs[0]).toMatchObject({ centerLat: 12.5, centerLon: -166 });
    for (const p of [...r.sid.points, ...r.star.points, ...r.approach.points]) {
      expect(Number.isFinite(p.lat) && Number.isFinite(p.lon)).toBe(true);
    }
    // the runway fix is where the final ends: the threshold of 27R, displaced 300 ft from its end
    const threshold = r.approach.points[5];
    expect(threshold.lat).toBeCloseTo(12, 3);
    expect(threshold.lon).toBeCloseTo(-164.97, 2);
  });

  it('writes nothing the logs could not show to a stranger: no ident, name or frequency of the source', () => {
    expect(built.logs.length).toBeGreaterThan(0);
    for (const line of built.logs) {
      expect(line).toMatch(/^\[Navdata\] LNM import: /);
      expect(line).not.toContain(built.dir);
      expect(line).not.toMatch(/ZZ|XZ|Zed|\b1[0-9]{2}[.,]?[0-9]{2,}/);
    }
    expect(built.logs.some(l => l.includes(`${path.basename(built.source)} is ${flavour.provider} data`))).toBe(true);
  });
});

// ── Refusals and failures leave nothing behind ───────────────────────────────

describe('a failed import', () => {
  /** A converter list that writes the airports, then stops in `stage` with `thrown`. */
  function failingAfterAirports(stage: LnmStage, thrown: () => unknown, mid?: () => void): readonly LnmConverter[] {
    const writeNothing: LnmConverter = { stage: 'airports', run: () => ({ written: {}, skipped: {} }) };
    return [writeNothing, { stage, run: () => { mid?.(); throw thrown(); } }];
  }

  function setup(spec: LnmFixtureSpec = navigraph()): { dir: string; source: string; incoming: string; req: LnmWorkerRequest } {
    const dir = freshDir();
    const source = buildLnmFixture(dir, spec);
    const incoming = path.join(dir, 'replica.db.incoming-2');
    return { dir, source, incoming, req: request(source, incoming) };
  }

  it('after a converter throws mid-build leaves no incoming file, no journal and no replica', () => {
    const { dir, source, incoming, req } = setup();
    let existedMidBuild = false;
    const messages: LnmWorkerMessage[] = [];
    runLnmPipelineToMessages(req, m => messages.push(m), {
      converters: failingAfterAirports('navaids', () => new Error('row ZZAA lat 12.5'), () => {
        existedMidBuild = fs.existsSync(incoming);
      }),
    });
    expect(existedMidBuild).toBe(true);
    expect(messages[messages.length - 1]).toEqual({
      type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage navaids',
    });
    expect(leftovers(incoming)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([path.basename(source)]);
  });

  it('through the in-process runner too: the converter text reaches neither the message nor the log', async () => {
    const { dir, source, incoming, req } = setup();
    vi.spyOn(navaidsConverter, 'run').mockImplementation(() => { throw new Error('row ZZAA freq 118.325 at -165.02'); });
    const messages: LnmWorkerMessage[] = [];
    await inProcessRunner.start(req, m => messages.push(m)).done;
    expect(messages[messages.length - 1]).toEqual({
      type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage navaids',
    });
    expect(messages.filter(m => m.type === 'done')).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toMatch(/ZZAA|118|165/);
    expect(logged().join('\n')).not.toMatch(/ZZAA|118|165/);
    expect(logged()).toContain('[Navdata] LNM import: Error in stage navaids');
    expect(leftovers(incoming)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([path.basename(source)]);
  });

  it('names the stage it stopped in, whatever stage that was', () => {
    for (const stage of ['waypoints', 'airways', 'procedures'] as const) {
      const { incoming, req } = setup();
      const messages: LnmWorkerMessage[] = [];
      runLnmPipelineToMessages(req, m => messages.push(m), { converters: failingAfterAirports(stage, () => new TypeError('x')) });
      expect(messages[messages.length - 1]).toEqual({ type: 'error', code: 'LNM_BUILD_FAILED', message: `import failed in stage ${stage}` });
      expect(leftovers(incoming)).toEqual([]);
    }
  });

  it('stops when a source is not a SQLite database, is missing, or is not Little Navmap data', () => {
    const { dir, incoming, req } = setup();
    const junk = path.join(dir, 'junk.sqlite');
    fs.writeFileSync(junk, 'this is not a database, just text');
    const run = (r: LnmWorkerRequest): LnmWorkerMessage => {
      const messages: LnmWorkerMessage[] = [];
      runLnmPipelineToMessages(r, m => messages.push(m));
      return messages[messages.length - 1];
    };
    expect(run({ ...req, sourcePath: junk })).toEqual({
      type: 'error', code: 'LNM_OPEN_FAILED', message: 'the file could not be read as a SQLite database',
    });
    expect(run({ ...req, sourcePath: path.join(dir, 'missing.sqlite') })).toMatchObject({ type: 'error', code: 'LNM_OPEN_FAILED' });

    const other = buildLnmFixture(dir, navigraph({ metadata: { data_source: 'XP12' }, fileName: 'other.sqlite' }));
    expect(run({ ...req, sourcePath: other })).toEqual({
      type: 'error', code: 'LNM_UNSUPPORTED_SOURCE',
      message: "unsupported Little Navmap data source 'XP12'; only NAVIGRAPH, MSFS and MSFS24 are supported",
    });
    expect(leftovers(incoming)).toEqual([]);
  });

  it('does not touch the source file', () => {
    const { source, incoming, req } = setup();
    const before = fs.readFileSync(source);
    runLnmPipelineToMessages(req, () => {}, { converters: failingAfterAirports('navaids', () => new Error('x')) });
    expect(fs.readFileSync(source).equals(before)).toBe(true);
    expect(leftovers(incoming)).toEqual([]);
  });
});

describe('toLnmWorkerError', () => {
  it('passes an LnmImportError through with its own code and message', () => {
    const err = new LnmImportError('LNM_FLAVOUR_MISMATCH', 'data source MSFS does not match the file: com.frequency is not in Hz');
    expect(toLnmWorkerError(err, 'validating')).toEqual({
      type: 'error', code: 'LNM_FLAVOUR_MISMATCH', message: 'data source MSFS does not match the file: com.frequency is not in Hz',
    });
    expect(logged()).toEqual(['[Navdata] LNM import: LNM_FLAVOUR_MISMATCH in stage validating']);
  });

  it('maps any other Error to LNM_BUILD_FAILED with a fixed message and logs only its name', () => {
    const msg = toLnmWorkerError(new RangeError('ident ZZAA at /home/someone/atools.sqlite'), 'navaids');
    expect(msg).toEqual({ type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage navaids' });
    expect(logged()).toEqual(['[Navdata] LNM import: RangeError in stage navaids']);
  });

  it('maps SQLITE_FULL to LNM_DISK_FULL and logs the name and code', () => {
    const err = Object.assign(new Error('database or disk is full'), { name: 'SqliteError', code: 'SQLITE_FULL' });
    expect(toLnmWorkerError(err, 'procedures')).toEqual({ type: 'error', code: 'LNM_DISK_FULL', message: 'disk full in stage procedures' });
    expect(logged()).toEqual(['[Navdata] LNM import: SqliteError SQLITE_FULL in stage procedures']);
  });

  it('treats a thrown non-Error like any other failure and never echoes it', () => {
    expect(toLnmWorkerError('ZZAA exploded', 'airways')).toEqual({
      type: 'error', code: 'LNM_BUILD_FAILED', message: 'import failed in stage airways',
    });
    expect(logged().join('\n')).not.toContain('ZZAA');
  });

  it('strips everything but identifier characters from the name and code it logs', () => {
    const err = Object.assign(new Error('x'), { name: 'ZZAA\nforged line', code: 'AB CD/../etc' });
    toLnmWorkerError(err, 'indexing');
    const [line] = logged();
    expect(line).not.toContain('\n');
    expect(line).toMatch(/^\[Navdata\] LNM import: [A-Za-z0-9_.-]+ [A-Za-z0-9_.-]+ in stage indexing$/);
  });
});

// ── Progress reporting ───────────────────────────────────────────────────────

describe('progress messages', () => {
  it('send one per stage start, at most one per 250 ms while it runs, and one at done = total', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    let t = 1_000_000;
    const reporting: LnmConverter = {
      stage: 'airports',
      run(ctx) {
        for (let i = 1; i <= 100; i++) {
          t += 10;
          ctx.progress(i, 100);
        }
        return { written: {}, skipped: {} };
      },
    };
    const stopping: LnmConverter = { stage: 'navaids', run: () => { throw new Error('stop here'); } };
    const seen: LnmProgressMessage[] = [];
    expect(() => runLnmPipeline(request(source, path.join(dir, 'p.incoming')), m => seen.push(m), {
      converters: [reporting, stopping], clock: () => t,
    })).toThrow('stop here');
    const airports = seen.filter(m => m.stage === 'airports');
    // 10 ms per call: a message every 25 calls (250 ms), then the final one at 100 of 100
    expect(airports.map(m => m.done)).toEqual([0, 25, 50, 75, 100]);
    expect(airports.map(m => m.total)).toEqual([1, 100, 100, 100, 100]);
    expect(seen.filter(m => m.stage === 'validating').map(m => [m.done, m.total])).toEqual([[0, 1], [1, 1]]);
    expect(seen[seen.length - 1]).toEqual({ type: 'progress', stage: 'navaids', done: 0, total: 1 });
  });

  it('report a stage with nothing to do as complete, once', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const empty: LnmConverter = { stage: 'airports', run: ctx => { ctx.progress(0, 0); ctx.progress(0, 0); return { written: {}, skipped: {} }; } };
    const stopping: LnmConverter = { stage: 'navaids', run: () => { throw new Error('stop here'); } };
    const seen: LnmProgressMessage[] = [];
    expect(() => runLnmPipeline(request(source, path.join(dir, 'p.incoming')), m => seen.push(m), { converters: [empty, stopping] })).toThrow();
    expect(seen.filter(m => m.stage === 'airports').map(m => [m.done, m.total])).toEqual([[0, 1], [1, 1]]);
  });

  it('hand each converter its counters through onStats', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const stats: ConverterStats = { written: { rows: 3 }, skipped: { 'unresolved.approach.W': 2 } };
    const reporting: LnmConverter = { stage: 'airports', run: () => stats };
    const stopping: LnmConverter = { stage: 'navaids', run: () => { throw new Error('stop here'); } };
    const got: [LnmStage, ConverterStats][] = [];
    expect(() => runLnmPipeline(request(source, path.join(dir, 'p.incoming')), () => {}, {
      converters: [reporting, stopping], onStats: (stage, s) => got.push([stage, s]),
    })).toThrow();
    expect(got).toEqual([['airports', stats]]);
  });
});

// ── Write-out of the incoming file ───────────────────────────────────────────

describe('write-out of the incoming replica', () => {
  const MIB = 1024 ** 2;

  /**
   * A converter that commits `count` transactions, each adding about `bytes` to the
   * file, and reports progress after each one, the way the real converters do.
   */
  function growing(count: number, bytes: number, hooks: { start: () => void; step: () => void }): LnmConverter {
    return {
      stage: 'airports',
      run(ctx) {
        hooks.start();
        ctx.out.exec('CREATE TABLE growth (data BLOB)');
        const insert = ctx.out.prepare('INSERT INTO growth VALUES (?)');
        const blob = Buffer.alloc(bytes, 0x5a);
        const commit = ctx.out.transaction(() => { insert.run(blob); });
        for (let i = 1; i <= count; i++) {
          commit();
          ctx.progress(i, count);
          hooks.step();
        }
        return { written: {}, skipped: {} };
      },
    };
  }
  const stopping: LnmConverter = { stage: 'navaids', run: () => { throw new Error('stop here'); } };

  /** Runs `growing` against a fresh incoming file and returns the file size at each write-out and after each commit. */
  function runGrowing(count: number, bytes: number, options: { flushThresholdBytes?: number; flush: boolean }) {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'w.incoming');
    const sizeNow = (): number => fs.statSync(incoming).size;
    const synced: number[] = [];
    const unwritten: number[] = [];
    let baseline = -1;
    const writer = growing(count, bytes, {
      start: () => { baseline = sizeNow(); },
      step: () => { unwritten.push(sizeNow() - (synced.length > 0 ? synced[synced.length - 1] : baseline)); },
    });
    expect(() => runLnmPipeline(request(source, incoming), () => {}, {
      converters: [writer, stopping],
      flushThresholdBytes: options.flushThresholdBytes,
      syncIncoming: fd => {
        synced.push(fs.fstatSync(fd).size);
        if (options.flush) fs.fdatasyncSync(fd);
      },
    })).toThrow('stop here');
    return { synced, unwritten, baseline };
  }

  it('happens each time the file has grown by the threshold, so the unwritten growth stays below it', () => {
    const threshold = MIB;
    const { synced, unwritten, baseline } = runGrowing(64, 64 * 1024, { flushThresholdBytes: threshold, flush: true });
    // 64 commits of about 68 KiB: one write-out per 16 commits
    expect(synced.length).toBeGreaterThanOrEqual(3);
    // checked after every commit's progress call
    expect(unwritten).toHaveLength(64);
    expect(Math.max(...unwritten)).toBeLessThan(threshold);
    // and never earlier than the threshold says
    synced.forEach((size, i) => {
      expect(size - (i === 0 ? baseline : synced[i - 1])).toBeGreaterThanOrEqual(threshold);
    });
  });

  it('is every 32 MiB of growth unless the caller says otherwise', () => {
    expect(INCOMING_FLUSH_BYTES).toBe(32 * MIB);
    const { synced, baseline } = runGrowing(36, MIB, { flush: false });
    expect(synced).toHaveLength(1);
    expect(synced[0] - baseline).toBeGreaterThanOrEqual(32 * MIB);
    expect(synced[0] - baseline).toBeLessThan(33 * MIB);
  });

  // Builds a full replica, including the 777,600-cell coverage grid: 25-29 s on a busy machine, so 120 s.
  it('covers the whole build: the last one comes after the last write and before done, on a descriptor closed afterwards', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'w.incoming');
    const events: string[] = [];
    const synced: number[] = [];
    let fd = -1;
    runLnmPipelineToMessages(request(source, incoming), m => events.push(m.type), {
      flushThresholdBytes: 4 * MIB,
      syncIncoming: f => {
        fd = f;
        events.push('sync');
        synced.push(fs.fstatSync(f).size);
        fs.fdatasyncSync(f);
      },
    });
    expect(events[events.length - 1]).toBe('done');
    expect(events.lastIndexOf('sync')).toBeLessThan(events.indexOf('done'));
    // the replica is about 36 MB: a write-out per 4 MiB of coverage grid plus the three unconditional ones
    expect(synced.length).toBeGreaterThanOrEqual(5);
    expect(synced[synced.length - 1]).toBe(fs.statSync(incoming).size);
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
  }, 120_000);

  // Builds a full replica, including the 777,600-cell coverage grid: 25-29 s on a busy machine, so 120 s.
  it('makes the last one after the switch to WAL and the close: nothing is left to write and no -wal or -shm remains', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'w.incoming');
    const events: string[] = [];
    const seen: { header: number[]; files: string[] }[] = [];
    runLnmPipelineToMessages(request(source, incoming), m => events.push(m.type), {
      flushThresholdBytes: 64 * MIB,
      syncIncoming: fd => {
        events.push('sync');
        seen.push({ header: journalHeader(fd), files: leftovers(incoming) });
        fs.fdatasyncSync(fd);
      },
    });
    expect(events[events.length - 1]).toBe('done');
    expect(events.lastIndexOf('sync')).toBeLessThan(events.indexOf('done'));
    // every earlier write-out happens while the build still runs in rollback-journal mode
    expect(seen.slice(0, -1).map(s => s.header)).toEqual(seen.slice(0, -1).map(() => [1, 1]));
    expect(seen[seen.length - 1]).toEqual({ header: [2, 2], files: ['w.incoming'] });
    expect(leftovers(incoming)).toEqual(['w.incoming']);
    const db = new Database(incoming, { readonly: true });
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  }, 120_000);

  it.each([
    ['ENOSPC', 'LNM_DISK_FULL', 'disk full in stage finalising'],
    ['EIO', 'LNM_BUILD_FAILED', 'import failed in stage finalising'],
  ])('fails the import when the write-out fails with %s, and leaves no file behind', (code, errorCode, message) => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'w.incoming');
    const messages: LnmWorkerMessage[] = [];
    let fd = -1;
    // a threshold the fixture never reaches: the first write-out is the unconditional one after the counters
    runLnmPipelineToMessages(request(source, incoming), m => messages.push(m), {
      flushThresholdBytes: 64 * MIB,
      syncIncoming: f => {
        fd = f;
        throw Object.assign(new Error(`${code}: write-out failed for ${incoming}`), { code });
      },
    });
    expect(messages[messages.length - 1]).toEqual({ type: 'error', code: errorCode, message });
    expect(messages.filter(m => m.type === 'done')).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain(dir);
    expect(logged().join('\n')).not.toContain(dir);
    expect(leftovers(incoming)).toEqual([]);
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────────

describe('inProcessRunner', () => {
  it('starts after the caller returns, never inside start()', async () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'replica.db.incoming-3');
    const messages: LnmWorkerMessage[] = [];
    const run = inProcessRunner.start(request(source, incoming), m => messages.push(m));
    expect(messages).toEqual([]);
    run.cancel();
    await run.done;
  });

  it('sends nothing at all when cancelled before it starts', async () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'replica.db.incoming-3');
    const messages: LnmWorkerMessage[] = [];
    const run = inProcessRunner.start(request(source, incoming), m => messages.push(m));
    run.cancel();
    await run.done;
    expect(messages).toEqual([]);
    expect(leftovers(incoming)).toEqual([]);
  });

  it('latches a cancel made from inside a message: nothing follows, no error is invented, the file is gone', async () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'replica.db.incoming-4');
    const messages: LnmWorkerMessage[] = [];
    let cancel: () => void = () => {};
    let midBuildFile = false;
    const run = inProcessRunner.start(request(source, incoming), m => {
      messages.push(m);
      if (m.type === 'progress' && m.stage === 'airports' && m.done === 0) {
        midBuildFile = fs.existsSync(incoming);
        cancel();
      }
    });
    cancel = run.cancel;
    await run.done;
    expect(midBuildFile).toBe(true);
    expect(messages[messages.length - 1]).toEqual({ type: 'progress', stage: 'airports', done: 0, total: 1 });
    expect(messages.filter(m => m.type !== 'progress')).toEqual([]);
    expect(logged().filter(l => /LNM_|failed/.test(l))).toEqual([]);
    expect(leftovers(incoming)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([path.basename(source)]);
  });

  it('stops the pipeline itself with LnmCancelledError, which is not an import failure', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const incoming = path.join(dir, 'replica.db.incoming-5');
    let cancelled = false;
    expect(() => runLnmPipeline(request(source, incoming), m => { if (m.stage === 'indexing') cancelled = true; }, {
      isCancelled: () => cancelled,
    })).toThrow(LnmCancelledError);
    expect(leftovers(incoming)).toEqual([]);
  });
});

// ── workerRunner with a stand-in worker ──────────────────────────────────────

class FakeWorker extends EventEmitter implements WorkerHandle {
  terminated = 0;
  constructor(readonly file: string, readonly options: Record<string, unknown>) {
    super();
  }
  terminate(): Promise<number> {
    this.terminated++;
    return Promise.resolve(1);
  }
}

describe('workerRunner', () => {
  const DONE: LnmWorkerMessage = {
    type: 'done',
    result: {
      snapshotId: 's', warnings: 0, durationMs: 1,
      dataset: {
        source: 'lnm', label: 'x', provider: 'MSFS', airacCycle: null, validFrom: null, validThrough: null, expired: null,
        compiledAt: null, navigraphUpdate: null, importedAt: 1,
      },
      counts: {
        airports: 1, runways: 0, frequencies: 0, navaids: 0, waypoints: 0, airwayLegs: 0, procedures: 0, transitions: 0,
        legs: 0, coverageCells: 0,
      },
    },
  };

  function start() {
    const dir = freshDir();
    const incomingPath = path.join(dir, 'replica.db.incoming-6');
    fs.writeFileSync(incomingPath, 'partial replica');
    const workers: FakeWorker[] = [];
    const runner = createWorkerRunner((file, options) => {
      const w = new FakeWorker(file, options as Record<string, unknown>);
      workers.push(w);
      return w;
    });
    const messages: LnmWorkerMessage[] = [];
    const req: LnmWorkerRequest = { sourcePath: '/x/atools.sqlite', sourceFileName: 'atools.sqlite', sourceBytes: 5, incomingPath, now: NOW };
    const run = runner.start(req, m => messages.push(m));
    return { run, worker: workers[0], workers, messages, req, incomingPath };
  }

  it('creates the worker with the request, a 1024 MiB old-space limit and the worker entry file', () => {
    const { worker, req } = start();
    expect(WORKER_MAX_OLD_GENERATION_MB).toBe(1024);
    expect(worker.options.workerData).toEqual(req);
    expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 1024 });
    // under vitest this module is a .ts file, so the worker is the .ts entry compiled by ts-node
    expect(path.basename(worker.file)).toBe('worker.ts');
    expect(worker.options.execArgv).toEqual(['--require', 'ts-node/register']);
    expect(path.dirname(worker.file)).toBe(path.resolve(__dirname, '../src/navdata/lnm'));
  });

  it('forwards the worker messages in order and resolves done only after the worker exits', async () => {
    const { run, worker, messages, incomingPath } = start();
    let resolved = false;
    void run.done.then(() => { resolved = true; });
    const progress: LnmWorkerMessage = { type: 'progress', stage: 'indexing', done: 1, total: 2 };
    worker.emit('message', progress);
    worker.emit('message', DONE);
    await Promise.resolve();
    expect(resolved).toBe(false);
    worker.emit('exit', 0);
    await run.done;
    expect(messages).toEqual([progress, DONE]);
    // a finished build is the swap's to take: the file stays
    expect(fs.existsSync(incomingPath)).toBe(true);
  });

  it('turns a worker error followed by a non-zero exit into exactly one LNM_WORKER_FAILED, without its text', async () => {
    const { run, worker, messages, incomingPath } = start();
    worker.emit('error', new Error('row ZZAA at /home/someone/atools.sqlite'));
    worker.emit('exit', 1);
    await run.done;
    expect(messages).toEqual([{ type: 'error', code: 'LNM_WORKER_FAILED', message: 'import worker stopped unexpectedly' }]);
    expect(logged().join('\n')).not.toMatch(/ZZAA|someone/);
    expect(fs.existsSync(incomingPath)).toBe(false);
  });

  it('maps a worker out-of-memory error to LNM_OUT_OF_MEMORY', async () => {
    const { run, worker, messages } = start();
    worker.emit('error', Object.assign(new Error('Worker terminated due to reaching memory limit'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
    worker.emit('exit', 1);
    await run.done;
    expect(messages).toEqual([{ type: 'error', code: 'LNM_OUT_OF_MEMORY', message: 'import ran out of memory' }]);
  });

  it('reports a worker that exits without a message, and one that exits cleanly without a result', async () => {
    for (const code of [1, 0]) {
      const { run, worker, messages, incomingPath } = start();
      worker.emit('message', { type: 'progress', stage: 'airports', done: 0, total: 1 });
      worker.emit('exit', code);
      await run.done;
      expect(messages.map(m => m.type)).toEqual(['progress', 'error']);
      expect(messages[1]).toMatchObject({ code: 'LNM_WORKER_FAILED' });
      expect(fs.existsSync(incomingPath)).toBe(false);
    }
  });

  it('adds no error after the worker has posted its own', async () => {
    const { run, worker, messages } = start();
    const error: LnmWorkerMessage = { type: 'error', code: 'LNM_NOT_ATOOLS', message: 'not a Little Navmap database: missing table airway' };
    worker.emit('message', error);
    worker.emit('exit', 0);
    await run.done;
    expect(messages).toEqual([error]);
  });

  it('latches cancel: terminates the worker, forwards a late done, invents no error, and removes the file', async () => {
    const { run, worker, messages, incomingPath } = start();
    worker.emit('message', { type: 'progress', stage: 'airports', done: 0, total: 1 });
    run.cancel();
    expect(worker.terminated).toBe(1);
    // Node still delivers a done the worker posted before terminate()
    worker.emit('message', DONE);
    worker.emit('message', { type: 'progress', stage: 'procedures', done: 1, total: 2 });
    worker.emit('error', new Error('terminated'));
    worker.emit('exit', 1);
    await run.done;
    expect(messages).toEqual([{ type: 'progress', stage: 'airports', done: 0, total: 1 }]);
    expect(fs.existsSync(incomingPath)).toBe(false);
    run.cancel();
    expect(worker.terminated).toBe(2);
  });

  it('survives a message handler that throws', async () => {
    const dir = freshDir();
    const worker = new FakeWorker('w', {});
    const runner = createWorkerRunner(() => worker);
    const run = runner.start({ sourcePath: 'a', sourceFileName: 'a', sourceBytes: 1, incomingPath: path.join(dir, 'x'), now: NOW }, () => {
      throw new Error('handler bug ZZAA');
    });
    expect(() => worker.emit('message', DONE)).not.toThrow();
    worker.emit('exit', 0);
    await run.done;
    expect(logged()).toContain('[Navdata] LNM import: the message handler failed: Error');
  });

  it('reports a worker that cannot be created, once', async () => {
    const dir = freshDir();
    const runner = createWorkerRunner(() => { throw new Error('bad options ZZAA'); });
    const messages: LnmWorkerMessage[] = [];
    const run = runner.start({ sourcePath: 'a', sourceFileName: 'a', sourceBytes: 1, incomingPath: path.join(dir, 'x'), now: NOW }, m => messages.push(m));
    run.cancel();
    await run.done;
    // cancelled before the failure was reported: nothing is sent
    expect(messages).toEqual([]);

    const again: LnmWorkerMessage[] = [];
    await runner.start({ sourcePath: 'a', sourceFileName: 'a', sourceBytes: 1, incomingPath: path.join(dir, 'x'), now: NOW }, m => again.push(m)).done;
    expect(again).toEqual([{ type: 'error', code: 'LNM_WORKER_FAILED', message: 'import worker stopped unexpectedly' }]);
    expect(logged().join('\n')).not.toContain('ZZAA');
  });
});

// ── The two connections ──────────────────────────────────────────────────────

describe('the connections', () => {
  it('open the source read-only with a 64 MiB cache and sorts in memory', () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const src = openSource(source);
    try {
      expect(src.readonly).toBe(true);
      expect(src.pragma('cache_size', { simple: true })).toBe(-65536);
      expect(src.pragma('temp_store', { simple: true })).toBe(2);
    } finally {
      src.close();
    }
  });

  it('open the incoming replica with a 64 MiB cache, in memory sorts, foreign keys, no WAL and no sync', () => {
    const dir = freshDir();
    const incoming = path.join(dir, 'replica.db.incoming-7');
    const out = openIncoming(incoming);
    try {
      expect(out.pragma('cache_size', { simple: true })).toBe(-65536);
      expect(out.pragma('temp_store', { simple: true })).toBe(2);
      expect(out.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(out.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(out.pragma('synchronous', { simple: true })).toBe(0);
      const tables = out.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('nav_airport', 'lnm_dataset')").all();
      expect(tables).toHaveLength(2);
    } finally {
      out.close();
    }
  });

  it('replace an incoming file left by an earlier run at the same path', () => {
    const dir = freshDir();
    const incoming = path.join(dir, 'replica.db.incoming-8');
    fs.writeFileSync(incoming, 'stale');
    fs.writeFileSync(incoming + '-journal', 'stale');
    const out = openIncoming(incoming);
    out.close();
    expect(out.open).toBe(false);
    expect(fs.existsSync(incoming + '-journal')).toBe(false);
  });

  it('removeIncomingFiles clears the file and its siblings and ignores ones that are not there', () => {
    const dir = freshDir();
    const incoming = path.join(dir, 'replica.db.incoming-9');
    for (const s of ['', '-journal', '-wal']) fs.writeFileSync(incoming + s, 'x');
    removeIncomingFiles(incoming);
    removeIncomingFiles(incoming);
    expect(leftovers(incoming)).toEqual([]);
  });
});

// ── Verification ─────────────────────────────────────────────────────────────

describe('verification of a finished replica', () => {
  let built: Built;
  let workDir: string;
  let copies = 0;
  // Builds a full replica, including the 777,600-cell coverage grid: 25-29 s on a busy machine, so 120 s.
  beforeAll(async () => {
    workDir = freshDir();
    built = await importOnce('Navigraph', () => navigraph());
  }, 120_000);

  /** A writable copy of the imported replica for one test to damage. */
  function damaged(change: (db: Database.Database) => void): Database.Database {
    const file = path.join(workDir, `copy-${copies++}.db`);
    fs.copyFileSync(built.replica, file);
    const db = new Database(file);
    db.pragma('foreign_keys = OFF');
    change(db);
    return db;
  }

  const fails = (db: Database.Database, text: RegExp): void => {
    try {
      expect(() => verifyReplica(db, built.result.snapshotId)).toThrow(LnmImportError);
      try {
        verifyReplica(db, built.result.snapshotId);
      } catch (err) {
        expect((err as LnmImportError).code).toBe('LNM_VERIFY_FAILED');
        expect((err as LnmImportError).message).toMatch(text);
      }
    } finally {
      db.close();
    }
  };

  it('accepts the replica as imported', () => {
    const db = damaged(() => {});
    try {
      expect(() => verifyReplica(db, built.result.snapshotId)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a dangling foreign key', () => {
    fails(damaged(db => db.exec(
      "INSERT INTO nav_runway (rwy_key, airport_ident, rev) VALUES ('ZZNONE|9|0', 'ZZNONE', 1)")),
    /^verification failed: a row of nav_runway refers to a missing nav_airport row$/);
  });

  it('refuses a replica without airports', () => {
    fails(damaged(db => db.exec('PRAGMA foreign_keys = OFF; DELETE FROM nav_procedure_leg; DELETE FROM nav_procedure_transition; DELETE FROM nav_procedure; DELETE FROM nav_runway; DELETE FROM nav_airport_frequency; DELETE FROM nav_airport')),
    /^verification failed: no airports were imported$/);
  });

  it('refuses a grid that is not 777,600 cells', () => {
    fails(damaged(db => db.exec("DELETE FROM nav_coverage_cell WHERE kind = 'W' AND cell_id = 0")),
      /^verification failed: the coverage grid has 777599 cells$/);
  });

  it('refuses a header and a dataset row that disagree', () => {
    fails(damaged(db => db.exec("UPDATE lnm_dataset SET snapshot_id = 'other'")),
      /^verification failed: the header and the dataset row disagree$/);
    fails(damaged(db => db.exec("UPDATE nav_meta SET snapshot_id = 'other'")),
      /^verification failed: the header and the dataset row disagree$/);
  });

  it('refuses a table whose columns differ from the replica schema', () => {
    fails(damaged(db => db.exec('ALTER TABLE nav_absent ADD COLUMN extra TEXT')),
      /^verification failed: the replica tables differ from the schema$/);
  });
});

// ── The inspector ────────────────────────────────────────────────────────────

describe('inspect-lnm-import', () => {
  /** Rows that make the procedures stage count each kind of fix it could not place exactly. */
  const COUNTER_ROWS: LnmFixtureOverrides = {
    fileName: 'inspect-msfs.sqlite',
    extra: {
      waypoint: [
        { waypoint_id: 3601, ident: 'ZZQ01', type: 'WN', region: 'ZY', mag_var: 0, lonx: -165.2, laty: 12.1, airport_id: 1, airport_ident: 'ZZAA' },
        { waypoint_id: 3602, ident: 'ZZQ02', type: 'WN', region: 'ZZ', mag_var: 0, lonx: -165.5, laty: 12.5 },
      ],
      approach: [{
        approach_id: 1700, airport_id: 1, airport_ident: 'ZZAA', type: 'GPS', has_gps_overlay: 1, suffix: 'A', fix_ident: 'ZZ3A',
        fix_type: 'W', fix_region: 'ZZ', runway_name: '09L', runway_end_id: 11, arinc_name: 'RW09L',
      }],
      approach_leg: [
        { approach_id: 1700, type: 'TF', fix_type: 'TW', fix_ident: 'ZZQ01', fix_region: 'ZX', fix_airport_ident: 'ZZAA' },
        { approach_id: 1700, type: 'TF', fix_type: 'W', fix_ident: 'ZZQ02', fix_region: 'ZX' },
        { approach_id: 1700, type: 'TF', fix_type: 'W', fix_ident: 'ZZNONE', fix_region: 'ZZ' },
      ],
    },
  };

  const lines = (fn: typeof console.log): string[] => vi.mocked(fn).mock.calls.map(c => c.join(' '));

  // Builds a full replica, including the 777,600-cell coverage grid: 25-29 s on a busy machine, so 120 s.
  it('imports a synthetic fixture, prints counts, label, completeness and the fix-resolution counters, and exits 0', async () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, msfs(COUNTER_ROWS));
    const out = path.join(dir, 'out.db');
    const before = fs.readFileSync(source);

    const status = await main([source, out]);

    expect(status).toBe(0);
    const printed = lines(console.log).join('\n');
    expect(printed).toContain('label                  MSFS 2020 scenery with Navigraph update, compiled 2026-09-27');
    expect(printed).toMatch(/airports\s+2\n/);
    expect(printed).toMatch(/coverageCells\s+777600/);
    expect(printed).toContain('airports with detail   2 of 2');
    expect(printed).toContain('full and uniform: yes');
    expect(printed).toContain('bulk completed         yes');
    expect(printed).toMatch(/unchanged/);
    expect(printed).toMatch(/peak RSS \d+ MiB/);
    expect(printed).toMatch(/unresolved\.approach\.W\s+1\n/);
    expect(printed).toMatch(/regionRelaxed\.approach\s+1\n/);
    expect(printed).toMatch(/airportOwned\.approach\s+1\n/);
    // the counters of a table with nothing to report are listed as zero, not left out
    expect(printed).toMatch(/unresolved\.transition\.\*\s+0\n/);
    expect(printed).toMatch(/regionRelaxed\.transition\s+0\n/);
    expect(printed).toMatch(/airportOwned\.transition\s+0\n/);
    expect(lines(console.error)).toEqual([]);
    expect(fs.readFileSync(source).equals(before)).toBe(true);
    // the output is a WAL database; the inspector's read-only reports remove the -wal and -shm they create
    expect(fs.readdirSync(dir).sort()).toEqual(['inspect-msfs.sqlite', 'out.db']);

    const db = new Database(out, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) FROM nav_airport').pluck().get()).toBe(2);
    db.close();
  }, 120_000);

  it('exits 1 with one line and no stack trace on a file that is not a database', async () => {
    const dir = freshDir();
    const junk = path.join(dir, 'junk.sqlite');
    fs.writeFileSync(junk, 'this is not a database');
    const out = path.join(dir, 'out.db');

    expect(await main([junk, out])).toBe(1);
    const errors = lines(console.error).filter(l => l.startsWith('error:'));
    expect(errors).toEqual(['error: LNM_OPEN_FAILED: the file could not be read as a SQLite database']);
    expect(lines(console.error).join('\n')).not.toMatch(/\n\s+at /);
    expect(fs.readdirSync(dir).sort()).toEqual(['junk.sqlite']);
  });

  it('exits 1 on a file that is not Little Navmap data, naming the missing structure', async () => {
    const dir = freshDir();
    const other = path.join(dir, 'other.sqlite');
    const db = new Database(other);
    db.exec('CREATE TABLE unrelated (id INTEGER)');
    db.close();
    expect(await main([other, path.join(dir, 'out.db')])).toBe(1);
    expect(lines(console.error)).toContain('error: LNM_NOT_ATOOLS: not a Little Navmap database: missing table metadata');
  });

  it('exits 1 for a missing source, 1 for an existing output without --force, and 2 for a usage error', async () => {
    const dir = freshDir();
    const source = buildLnmFixture(dir, navigraph());
    const out = path.join(dir, 'out.db');
    expect(await main([path.join(dir, 'missing.sqlite'), out])).toBe(1);
    expect(lines(console.error)).toContain('error: cannot read missing.sqlite');

    fs.writeFileSync(out, 'precious');
    expect(await main([source, out])).toBe(1);
    expect(fs.readFileSync(out, 'utf8')).toBe('precious');
    expect(lines(console.error)).toContain('error: out.db already exists (use --force to replace it)');
    expect(await main([source, source])).toBe(1);

    expect(await main([])).toBe(2);
    expect(await main([source])).toBe(2);
    expect(await main([source, out, '--bogus'])).toBe(2);
    expect(lines(console.error).some(l => l.startsWith('usage:'))).toBe(true);
  });
});
