// ── Little Navmap coverage grid ──────────────────────────────────────────────
//
// nav_coverage_cell says "this 0.5 degree cell was harvested for this kind of
// fact". The client calls a kind complete only when every cell in view is
// marked, so a replica built in one go from a full database must mark all of
// them, oceans included: for each kind (V, N, W) every cell 0..259,199, with
// row_count the number of built rows in the cell (zero where there are none).

import type Database from 'better-sqlite3';

const CELL_ROWS = 360;
const CELL_COLS = 720;

/** Cells per kind. */
export const COVERAGE_CELLS_PER_KIND = CELL_ROWS * CELL_COLS;

const KINDS = ['V', 'N', 'W'] as const;
type Kind = (typeof KINDS)[number];

/** Rows per transaction, and rows per multi-row INSERT inside one. */
const TRANSACTION_CELLS = 50_000;
const INSERT_CELLS = 200;

/**
 * The 0.5 degree cell of a position, clamped to the grid: latitude 90 belongs
 * to the northernmost row and longitude 180 to the easternmost column. The
 * unclamped keys.cellId would put latitude 90 past the last cell (the table's
 * CHECK rejects it) and longitude 180 into the first column of the next row.
 */
export function coverageCellId(lat: number, lon: number): number {
  const row = Math.min(CELL_ROWS - 1, Math.max(0, Math.floor((lat + 90) * 2)));
  const col = Math.min(CELL_COLS - 1, Math.max(0, Math.floor((lon + 180) * 2)));
  return row * CELL_COLS + col;
}

/** Built rows per cell, counted from the replica's own tables rather than the source. */
function countBuiltRows(out: Database.Database): Record<Kind, Int32Array> {
  const counts: Record<Kind, Int32Array> = {
    V: new Int32Array(COVERAGE_CELLS_PER_KIND),
    N: new Int32Array(COVERAGE_CELLS_PER_KIND),
    W: new Int32Array(COVERAGE_CELLS_PER_KIND),
  };
  const navaids = out.prepare('SELECT kind, lat, lon FROM nav_navaid WHERE lat IS NOT NULL AND lon IS NOT NULL');
  for (const r of navaids.iterate() as IterableIterator<{ kind: 'V' | 'N'; lat: number; lon: number }>) {
    counts[r.kind][coverageCellId(r.lat, r.lon)]++;
  }
  const waypoints = out.prepare('SELECT lat, lon FROM nav_waypoint');
  for (const r of waypoints.iterate() as IterableIterator<{ lat: number; lon: number }>) {
    counts.W[coverageCellId(r.lat, r.lon)]++;
  }
  return counts;
}

/**
 * Writes the full grid, three kinds of 259,200 cells, in transactions of at
 * most 50,000 rows. Run after the navaid and waypoint tables are complete.
 * `progress` is called between transactions (and may throw to stop the build).
 * Returns the rows written.
 */
export function writeCoverageGrid(
  out: Database.Database,
  now: number,
  progress?: (done: number, total: number) => void,
): number {
  const counts = countBuiltRows(out);
  const total = KINDS.length * COVERAGE_CELLS_PER_KIND;

  const statements = new Map<number, Database.Statement>();
  const insert = (cells: number): Database.Statement => {
    let stmt = statements.get(cells);
    if (!stmt) {
      stmt = out.prepare(
        'INSERT INTO nav_coverage_cell (kind, cell_id, harvested_at, harvest_count, row_count, rev) VALUES '
        + Array(cells).fill('(?, ?, ?, 1, ?, 1)').join(', '),
      );
      statements.set(cells, stmt);
    }
    return stmt;
  };

  const writeRange = out.transaction((kind: Kind, from: number, to: number) => {
    for (let at = from; at < to; at += INSERT_CELLS) {
      const n = Math.min(INSERT_CELLS, to - at);
      const args: (string | number)[] = [];
      for (let cell = at; cell < at + n; cell++) args.push(kind, cell, now, counts[kind][cell]);
      insert(n).run(args);
    }
  });

  let done = 0;
  for (const kind of KINDS) {
    for (let from = 0; from < COVERAGE_CELLS_PER_KIND; from += TRANSACTION_CELLS) {
      const to = Math.min(COVERAGE_CELLS_PER_KIND, from + TRANSACTION_CELLS);
      writeRange(kind, from, to);
      done += to - from;
      progress?.(done, total);
    }
  }
  return done;
}
