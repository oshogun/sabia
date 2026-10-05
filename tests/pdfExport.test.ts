// tests/pdfExport.test.ts
//
// Covers only the subset of src/pdfExport.ts reachable with no browser and no
// network: appendPdfs (pure fs + pdf-lib), baseUrl (env + config derivation),
// and closeBrowser's early-return when no browser was ever launched.
// renderPdf/renderOnce/getBrowser and friends launch Chromium and are
// deliberately out of scope — nothing here imports or calls puppeteer beyond
// the module's own top-level import.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PDFDocument } from 'pdf-lib';
import { appendPdfs, baseUrl, closeBrowser } from '../src/pdfExport';
import { loadConfig } from '../src/config';

describe('closeBrowser — no browser ever launched', () => {
  it('resolves with no launch and no timer to clear', async () => {
    await expect(closeBrowser(2500)).resolves.toBeUndefined();
  });
});

describe('baseUrl', () => {
  const savedExportBaseUrl = process.env.EXPORT_BASE_URL;
  const savedPort = process.env.PORT;
  let scratchDir: string;
  let certPath: string;
  let keyPath: string;

  beforeAll(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msfslogger-pdfexport-test-'));
    certPath = path.join(scratchDir, 'cert.pem');
    keyPath = path.join(scratchDir, 'key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=msfslogger',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ]);
  });

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.EXPORT_BASE_URL;
    delete process.env.PORT;
    loadConfig({ INGEST_TOKEN: 'x'.repeat(20), BIND_HOST: '127.0.0.1' } as NodeJS.ProcessEnv);
  });

  afterEach(() => {
    if (savedExportBaseUrl === undefined) delete process.env.EXPORT_BASE_URL;
    else process.env.EXPORT_BASE_URL = savedExportBaseUrl;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it('EXPORT_BASE_URL wins over any derived default', () => {
    process.env.EXPORT_BASE_URL = 'http://dev.example:5173';
    expect(baseUrl()).toBe('http://dev.example:5173');
  });

  it('derives http from getConfig().tls.enabled === false, default port 3000', () => {
    expect(baseUrl()).toBe('http://127.0.0.1:3000');
  });

  it('derives http with an explicit PORT', () => {
    process.env.PORT = '3100';
    expect(baseUrl()).toBe('http://127.0.0.1:3100');
  });

  it('derives https from getConfig().tls.enabled === true', () => {
    loadConfig({
      INGEST_TOKEN: 'x'.repeat(20),
      TLS_CERT_FILE: certPath,
      TLS_KEY_FILE: keyPath,
    } as NodeJS.ProcessEnv);

    expect(baseUrl()).toBe('https://127.0.0.1:3000');
  });

  it('is read fresh per call, not cached — a later loadConfig() flips the scheme', () => {
    expect(baseUrl()).toBe('http://127.0.0.1:3000');

    loadConfig({
      INGEST_TOKEN: 'x'.repeat(20),
      TLS_CERT_FILE: certPath,
      TLS_KEY_FILE: keyPath,
    } as NodeJS.ProcessEnv);

    expect(baseUrl()).toBe('https://127.0.0.1:3000');
  });
});

describe('appendPdfs', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msfslogger-test-appendpdfs-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  async function makePdf(pageCount: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) doc.addPage();
    return Buffer.from(await doc.save());
  }

  it('with no attachment paths at all, returns the same Buffer object unchanged', async () => {
    const base = await makePdf(1);
    const result = await appendPdfs(base, []);
    expect(result).toBe(base);
  });

  it('when every attachment path is missing, returns the same Buffer object unchanged', async () => {
    const base = await makePdf(1);
    const result = await appendPdfs(base, [path.join(scratchDir, 'nope.pdf')]);
    expect(result).toBe(base);
  });

  it('appends a good attachment and skips a corrupt one, degrading rather than failing', async () => {
    const base = await makePdf(1);
    const goodPath = path.join(scratchDir, 'good.pdf');
    fs.writeFileSync(goodPath, await makePdf(2));
    const corruptPath = path.join(scratchDir, 'corrupt.pdf');
    fs.writeFileSync(corruptPath, Buffer.from('not a pdf at all'));

    const result = await appendPdfs(base, [goodPath, corruptPath]);

    // Read back with updateMetadata: false — PDFDocument.load() otherwise
    // rewrites Producer/ModDate on load and would clobber the very value
    // this test asserts on.
    const merged = await PDFDocument.load(result, { updateMetadata: false });
    expect(merged.getPageCount()).toBe(3); // 1 base page + 2 good pages, corrupt skipped
    expect(merged.getProducer()).toBe('msfslogger');
  });
});
