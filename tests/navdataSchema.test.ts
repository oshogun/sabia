import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { NAVDATA_DDL, applyNavdataSchema } from '../src/navdata/schema';

function fresh(): Database.Database {
  const db = new Database(':memory:');
  applyNavdataSchema(db);
  return db;
}

describe('NAVDATA_DDL', () => {
  it('creates 13 tables, 30 indexes, all STRICT', () => {
    const db = fresh();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    expect(tables).toHaveLength(13);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all();
    expect(indexes).toHaveLength(30);
    const strict = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' AND strict=1").get() as { n: number };
    expect(strict.n).toBe(13);
  });

  it('enforces STRICT typing', () => {
    const db = fresh();
    expect(() =>
      db.prepare("INSERT INTO nav_meta (id, schema_version, snapshot_id, sim_id, created_at, updated_at) VALUES (1, 'abc', 's', '2024', 1, 1)").run(),
    ).toThrow(/cannot store TEXT/);
  });

  it('runs on SQLite 3.37 or newer', () => {
    const v = (new Database(':memory:').prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const [maj, min] = v.split('.').map(Number);
    expect(maj > 3 || (maj === 3 && min >= 37)).toBe(true);
  });

  it('is idempotent', () => {
    const db = fresh();
    expect(() => db.exec(NAVDATA_DDL)).not.toThrow();
  });

  it('is the sidecar canonical schema, byte for byte', () => {
    const bytes = Buffer.from(NAVDATA_DDL, 'utf8');
    expect(bytes.length).toBe(32356);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '4720fc0cae7ce84ed7057efcccb558d9319f1bc55a7832e557162052dd306eb2',
    );
  });
});
