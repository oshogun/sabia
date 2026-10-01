#!/usr/bin/env ts-node
// ── Little Navmap import inspector ────────────────────────────────────────────
//
// Converts a Little Navmap (atools) SQLite database into a Sabia replica file
// and reports what came out: row counts, the dataset label and validity, the
// completeness flags a map client reads, and the counters of what the
// converters skipped or could not resolve. It is how the importer is exercised
// against a real file without a server, a browser or a swap. The source is
// opened read-only; the only file written is the output path.
//
//   npx ts-node src/inspect-lnm-import.ts <atools.sqlite> <out.db>
//   npx ts-node src/inspect-lnm-import.ts <atools.sqlite> <out.db> --worker --force
//
// --worker runs the build in the same worker thread the server uses (no
// per-stage counters then, they do not cross the thread); --force replaces an
// existing output file. Exit status is 0 when the import succeeded, 1 when it
// failed (one line naming the code and its reason, never a stack trace), 2 for
// a usage error.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { readNavdataDataset } from './navdata/dataset';
import { workerRunner } from './navdata/lnm';
import { runLnmPipelineToMessages } from './navdata/lnm/pipeline';
import type { ConverterStats, LnmImportResult, LnmStage, LnmWorkerMessage } from './navdata/lnm/types';

const USAGE = 'usage: inspect-lnm-import <atools.sqlite> <out.db> [--worker] [--force]';

const nullable = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '-' : String(v));
const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0);

interface Args { source: string; out: string; worker: boolean; force: boolean }

function parseArgs(argv: string[]): Args | null {
  const flags = argv.filter(a => a.startsWith('--'));
  const paths = argv.filter(a => !a.startsWith('--'));
  if (paths.length !== 2 || flags.some(f => f !== '--worker' && f !== '--force')) return null;
  return { source: path.resolve(paths[0]), out: path.resolve(paths[1]), worker: flags.includes('--worker'), force: flags.includes('--force') };
}

/** Size and modification time, to show afterwards that the source was not touched. */
const fingerprint = (file: string): string => {
  const s = fs.statSync(file);
  return `${s.size}:${s.mtimeMs}`;
};

// ── Reading the built replica ────────────────────────────────────────────────

function completeness(out: string): string[] {
  const db = new Database(out, { readonly: true, fileMustExist: true });
  try {
    const one = (sql: string): number => db.prepare(sql).pluck().get() as number;
    const airports = one('SELECT COUNT(*) FROM nav_airport');
    const detail = one("SELECT COUNT(*) FROM nav_airport WHERE detail_state = 'detail'");
    const navaids = one('SELECT COUNT(*) FROM nav_navaid');
    const navaidsDetail = one("SELECT COUNT(*) FROM nav_navaid WHERE detail_state = 'detail'");
    const waypoints = one('SELECT COUNT(*) FROM nav_waypoint');
    const waypointsFetched = one("SELECT COUNT(*) FROM nav_waypoint WHERE routes_state = 'fetched'");
    const onAirways = one('SELECT COUNT(*) FROM nav_waypoint WHERE n_routes > 0');
    const grid = db.prepare(
      'SELECT kind, COUNT(*) AS cells, MIN(harvested_at) AS oldest, MAX(harvested_at) AS newest FROM nav_coverage_cell GROUP BY kind ORDER BY kind',
    ).all() as { kind: string; cells: number; oldest: number; newest: number }[];
    const meta = db.prepare('SELECT bulk_completed_at, sim_id FROM nav_meta WHERE id = 1').get() as
      { bulk_completed_at: number | null; sim_id: string } | undefined;
    const absent = one('SELECT COUNT(*) FROM nav_absent');
    const fullGrid = grid.length === 3 && grid.every(g => g.cells === 259_200 && g.oldest === g.newest);
    return [
      `airports with detail   ${detail} of ${airports}`,
      `navaids with detail    ${navaidsDetail} of ${navaids}`,
      `waypoints routes done  ${waypointsFetched} of ${waypoints} (${onAirways} on an airway)`,
      `coverage grid          ${grid.map(g => `${g.kind} ${g.cells}`).join(', ')}; full and uniform: ${fullGrid ? 'yes' : 'NO'}`,
      `bulk completed         ${meta?.bulk_completed_at != null ? 'yes' : 'NO'}`,
      `absent rows            ${absent}`,
    ];
  } finally {
    db.close();
  }
}

function describeDataset(out: string): string[] {
  const db = new Database(out, { readonly: true, fileMustExist: true });
  try {
    const d = readNavdataDataset(db, 'lnm', Date.now());
    if (!d) return ['dataset                none (no header)'];
    return [
      `label                  ${d.label}`,
      `provider               ${nullable(d.provider)}   AIRAC ${nullable(d.airacCycle)}   navigraph update ${nullable(d.navigraphUpdate)}`,
      `valid                  ${nullable(d.validFrom)} .. ${nullable(d.validThrough)}   expired ${nullable(d.expired)}`,
      `compiled               ${nullable(d.compiledAt)}`,
    ];
  } finally {
    db.close();
  }
}

/**
 * What each converter skipped or could not resolve, grouped by stage. The procedures stage always lists
 * its fix-resolution counters, zero included: legs left without a position per source table and fix type,
 * and the legs resolved by the region-relaxed and airport-owned steps.
 */
function counterLines(stats: Map<LnmStage, ConverterStats>): string[] {
  const lines: string[] = [];
  for (const [stage, s] of stats) {
    const skipped: Record<string, number> = { ...s.skipped };
    if (stage === 'procedures') {
      for (const table of ['approach', 'transition']) {
        if (!Object.keys(skipped).some(k => k.startsWith(`unresolved.${table}.`))) skipped[`unresolved.${table}.*`] = 0;
        skipped[`regionRelaxed.${table}`] ??= 0;
        skipped[`airportOwned.${table}`] ??= 0;
      }
    }
    const shown = Object.entries(skipped).filter(([, n]) => n > 0 || stage === 'procedures').sort(([a], [b]) => a.localeCompare(b));
    if (shown.length === 0) continue;
    lines.push(`  ${stage}`);
    for (const [name, n] of shown) lines.push(`    ${name.padEnd(36)} ${n}`);
  }
  return lines.length ? lines : ['  none'];
}

// ── The run ──────────────────────────────────────────────────────────────────

function run(req: Parameters<typeof runLnmPipelineToMessages>[0], worker: boolean, stats: Map<LnmStage, ConverterStats>, post: (m: LnmWorkerMessage) => void): Promise<void> {
  if (worker) return workerRunner.start(req, post).done;
  runLnmPipelineToMessages(req, post, { onStats: (stage, s) => stats.set(stage, s) });
  return Promise.resolve();
}

async function inspect(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  let sourceBefore: string;
  try {
    if (!fs.statSync(args.source).isFile()) throw new Error('not a file');
    sourceBefore = fingerprint(args.source);
  } catch {
    console.error(`error: cannot read ${path.basename(args.source)}`);
    return 1;
  }
  if (args.out === args.source) {
    console.error('error: the output path is the source file');
    return 1;
  }
  if (fs.existsSync(args.out) && !args.force) {
    console.error(`error: ${path.basename(args.out)} already exists (use --force to replace it)`);
    return 1;
  }

  const started = Date.now();
  const incomingPath = `${args.out}.incoming-${process.pid}-${started}`;
  const stats = new Map<LnmStage, ConverterStats>();
  const stageSeconds = new Map<LnmStage, { first: number; last: number }>();
  const outcome: { result: LnmImportResult | null; failure: { code: string; message: string } | null } = {
    result: null, failure: null,
  };

  await run(
    { sourcePath: args.source, sourceFileName: path.basename(args.source), sourceBytes: fs.statSync(args.source).size, incomingPath, now: started },
    args.worker,
    stats,
    message => {
      if (message.type === 'progress') {
        const at = Date.now();
        const t = stageSeconds.get(message.stage) ?? { first: at, last: at };
        t.last = at;
        stageSeconds.set(message.stage, t);
      } else if (message.type === 'done') {
        outcome.result = message.result;
      } else {
        outcome.failure = { code: message.code, message: message.message };
      }
    },
  );

  const { result: done, failure } = outcome;
  if (failure || !done) {
    console.error(`error: ${failure ? `${failure.code}: ${failure.message}` : 'the import ended without a result'}`);
    return 1;
  }

  try {
    fs.renameSync(incomingPath, args.out);
  } catch {
    fs.rmSync(incomingPath, { force: true });
    console.error(`error: could not move the replica to ${path.basename(args.out)}`);
    return 1;
  }

  const wall = (Date.now() - started) / 1000;
  const counts = Object.entries(done.counts).map(([k, n]) => `  ${k.padEnd(14)} ${n}`);
  console.log('');
  console.log(`source       ${path.basename(args.source)} (${mib(fs.statSync(args.source).size)} MiB), ${fingerprint(args.source) === sourceBefore ? 'unchanged' : 'CHANGED'}`);
  console.log(`output       ${args.out} (${mib(fs.statSync(args.out).size)} MiB)`);
  console.log(`mode         ${args.worker ? 'worker thread' : 'in process'}`);
  for (const line of describeDataset(args.out)) console.log(line);
  console.log('counts');
  for (const line of counts) console.log(line);
  console.log('completeness');
  for (const line of completeness(args.out)) console.log(`  ${line}`);
  if (args.worker) {
    console.log('skipped and unresolved counters: not available in --worker mode');
  } else {
    console.log('skipped and unresolved counters');
    for (const line of counterLines(stats)) console.log(line);
  }
  console.log('stages (seconds)');
  console.log(`  ${[...stageSeconds].map(([s, t]) => `${s} ${((t.last - t.first) / 1000).toFixed(1)}`).join('   ')}`);
  console.log(`warnings     ${done.warnings}`);
  console.log(`wall time    ${wall.toFixed(1)} s   peak RSS ${mib(process.resourceUsage().maxRSS * 1024)} MiB`);
  return 0;
}

/** Never throws: whatever goes wrong is one line and exit status 1. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await inspect(argv);
  } catch (err) {
    console.error(`error: unexpected ${err instanceof Error ? err.name : 'failure'} while inspecting the import`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
