// The rejection log of the sync routes: what a refused request leaves in
// server.log, and what it must never leave there. Scratch replica only.

import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavdataSyncRouter, createRejectionLogger } from '../src/routes/navdataSync';
import { SidecarStateStore } from '../src/navdata/sidecarState';
import { closeNavDb, openNavdata } from '../src/navdata/connection';
import { createScratchDb, destroyScratchDb, type ScratchDb } from './helpers/db';
import { scratchDbRoot } from './helpers/scratchRoot';

const TOKEN = 'sync-log-secret-token';
const savedEnv = process.env.NAVDATA_DB_PATH;

describe('createRejectionLogger', () => {
  const setup = () => {
    let t = 1_000_000;
    const lines: string[] = [];
    const log = createRejectionLogger(() => t, l => lines.push(l));
    return { lines, log, advance: (ms: number) => { t += ms; } };
  };

  it('collapses identical consecutive rejections inside 60 s and counts them', () => {
    const { lines, log, advance } = setup();
    log('/rows', 400, 'NAVDATA_BAD_BATCH', 'boom');
    advance(1000); log('/rows', 400, 'NAVDATA_BAD_BATCH', 'boom');
    advance(30_000); log('/rows', 400, 'NAVDATA_BAD_BATCH', 'boom');
    expect(lines).toHaveLength(1);
    advance(60_000); log('/rows', 400, 'NAVDATA_BAD_BATCH', 'boom');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('(repeated 2 times)');
    expect(lines[0]).not.toContain('repeated');
  });

  it('logs a different route, status, code or message at once', () => {
    const { lines, log } = setup();
    log('/rows', 400, 'A', 'm');
    log('/rows', 400, 'A', 'other');
    log('/rows', 409, 'A', 'other');
    log('/rows', 409, 'B', 'other');
    log('/state', 409, 'B', 'other');
    expect(lines).toHaveLength(5);
  });

  it('does not carry a count across a different rejection in between', () => {
    const { lines, log } = setup();
    log('/rows', 400, 'A', 'm');
    log('/rows', 400, 'A', 'm');
    log('/rows', 400, 'A', 'x');
    log('/rows', 400, 'A', 'm');
    expect(lines).toHaveLength(3);
    expect(lines[2]).not.toContain('repeated');
  });

  it('drops the text a JSON parser quotes and bounds the length', () => {
    const { lines, log } = setup();
    log('/snapshot', 400, 'A', 'line 3 is not JSON: Unexpected token \'ZZSECRET\'');
    log('/snapshot', 400, 'A', 'x'.repeat(5000));
    expect(lines[0]).not.toContain('ZZSECRET');
    expect(lines[1].length).toBeLessThan(400);
  });
});

describe('sync routes rejection log', () => {
  let scratch: ScratchDb;
  let dir: string;
  let server: Server;
  let base: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let clock = 5_000_000;

  const post = (p: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-ingest-token': token } : {}) },
      body: JSON.stringify(body),
    });
  const lines = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));

  const badBatch = (marker: string) => ({
    v: 1, schemaVersion: 2, snapshotId: 's1', fromRev: 5, toRev: 6, more: false,
    rows: [{ t: 'airport', r: { ident: marker, secretColumnValue: marker, rev: 6 } }],
  });

  beforeEach(async () => {
    scratch = createScratchDb();
    dir = fs.mkdtempSync(path.join(scratchDbRoot(), 'navdata-synclog-'));
    process.env.NAVDATA_DB_PATH = path.join(dir, 'navdata.db');
    openNavdata();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clock = 5_000_000;
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/navdata', createNavdataSyncRouter(
      { token: TOKEN, allowUnauthenticated: false }, new SidecarStateStore(), () => clock,
    ));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeNavDb();
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    destroyScratchDb(scratch);
    if (savedEnv === undefined) delete process.env.NAVDATA_DB_PATH; else process.env.NAVDATA_DB_PATH = savedEnv;
  });

  it('logs a rejected /rows batch once, with route, status, code and message only', async () => {
    const res = await post('/api/navdata/rows', badBatch('ZZROWVALUE'));
    expect(res.status).toBe(409);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('/rows');
    expect(out[0]).toContain('409');
    expect(out[0]).toContain('NAVDATA_SNAPSHOT_MISMATCH');
    expect(out[0]).toContain('no navdata replica is present');
    expect(out[0]).not.toContain('ZZROWVALUE');
    expect(out[0]).not.toContain(TOKEN);
  });

  it('collapses identical repeats, logs a different message again, and stays quiet on success', async () => {
    await post('/api/navdata/rows', badBatch('ZZONE'));
    await post('/api/navdata/rows', badBatch('ZZTWO'));
    await post('/api/navdata/rows', badBatch('ZZTHREE'));
    expect(lines()).toHaveLength(1);

    const other = await post('/api/navdata/rows', { ...badBatch('ZZFOUR'), v: 7 });
    expect(other.status).toBe(409);
    expect(lines()).toHaveLength(2);

    await post('/api/navdata/rows', { ...badBatch('ZZFIVE'), v: 7 });
    expect(lines()).toHaveLength(2);

    clock += 61_000;
    await post('/api/navdata/rows', { ...badBatch('ZZSIX'), v: 7 });
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).toContain('(repeated 1 times)');
    expect(lines().join('\n')).not.toMatch(/ZZ(ONE|TWO|THREE|FOUR|FIVE|SIX)/);

    const demand = await fetch(`${base}/api/navdata/demand`, { headers: { 'x-ingest-token': TOKEN } });
    expect(demand.status).toBe(200);
    expect(lines()).toHaveLength(3);
  });

  it('logs a wrong token by route and status, never the token', async () => {
    const res = await post('/api/navdata/rows', badBatch('ZZROW'), 'wrong-token-value');
    expect(res.status).toBe(401);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('/rows');
    expect(out[0]).toContain('401');
    expect(out[0]).not.toContain('wrong-token-value');
    expect(out[0]).not.toContain(TOKEN);
  });
});
