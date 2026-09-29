import express from 'express';
import * as http from 'http';
import type { Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import zlib from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsMiddleware } from '../src/staticAssets';

// See tests/ingestCors.test.ts for the same app.listen(0, ...) pattern. Plain
// fetch() isn't used for the request side here: undici's fetch transparently
// decompresses a gzip/br Content-Encoding, which is exactly the byte-level
// behaviour these tests need to see through, so requests go over a raw
// http.request that hands back the wire bytes untouched.

const FIXTURE_DIST = path.join(__dirname, 'fixtures', 'static-dist');
const JS_FILE = 'app.3f9a1c.js';
const CSS_FILE = 'app.3f9a1c.css';
const WOFF2_FILE = 'font.3f9a1c.woff2';
// Untouched by any other test, so the compressed-asset cache is guaranteed
// cold the first time either caching test below requests it.
const CACHE_CHECK_FILE = 'cache-check.9f1e2b.js';
const JS_BYTES = fs.readFileSync(path.join(FIXTURE_DIST, 'assets', JS_FILE));
const WOFF2_BYTES = fs.readFileSync(path.join(FIXTURE_DIST, 'assets', WOFF2_FILE));

const INDEX_HTML_BODY = '<!doctype html><html><body>fixture index</body></html>';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// `rawPath` is sent on the wire exactly as given — no URL normalisation, no
// automatic decoding — which is what a traversal attempt needs to actually
// reach the server, and what a Content-Length assertion needs to see the
// real (possibly compressed) byte count rather than a browser's decoded one.
function rawRequest(
  baseUrl: string, rawPath: string, opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: rawPath,
      method: opts.method ?? 'GET',
      headers: opts.headers,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'br') return zlib.brotliDecompressSync(body);
  if (encoding === 'gzip') return zlib.gunzipSync(body);
  return body;
}

function createTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/assets', createAssetsMiddleware(FIXTURE_DIST));
  // Proves a miss under /assets never falls through to this: a real SPA
  // catch-all would otherwise mask a 404 as a 200 text/html response. `use`
  // rather than `get` so a non-GET/HEAD request's next() also lands here.
  app.use((_req, res) => res.status(200).type('html').send(INDEX_HTML_BODY));

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Test server did not bind to a TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close(error => error ? closeReject(error) : closeResolve());
        }),
      });
    });
    server.on('error', reject);
  });
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close => close()));
});

async function startServer() {
  const server = await createTestServer();
  openServers.push(server.close);
  return server;
}

describe('static assets middleware', () => {
  it('chooses br when the client accepts it', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to gzip when br is absent', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('falls back to gzip when br has q=0', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'br;q=0, gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('sends identity when Accept-Encoding is empty', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': '' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.equals(JS_BYTES)).toBe(true);
  });

  it('the decompressed body equals the original file bytes, for br and gzip alike', async () => {
    const { baseUrl } = await startServer();

    const brResponse = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    expect(decompress(brResponse.body, brResponse.headers['content-encoding']).equals(JS_BYTES)).toBe(true);

    const gzipResponse = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(decompress(gzipResponse.body, gzipResponse.headers['content-encoding']).equals(JS_BYTES)).toBe(true);
  });

  it('HEAD has no body but reports the true (compressed) Content-Length', async () => {
    const { baseUrl } = await startServer();
    const getResponse = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const getLength = getResponse.headers['content-length'];
    expect(Number(getLength)).toBe(getResponse.body.length);

    const headResponse = await rawRequest(baseUrl, `/assets/${JS_FILE}`, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers['content-encoding']).toBe('gzip');
    expect(headResponse.headers['content-length']).toBe(getLength);
    expect(headResponse.body.length).toBe(0);
  });

  it('a missing file is a plain 404, not the SPA index.html', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, '/assets/does-not-exist.js');
    expect(response.status).toBe(404);
    expect(response.body.toString('utf8')).not.toContain('fixture index');
  });

  it('rejects a literal dot-dot traversal attempt with 404, even though the target file is real', async () => {
    const { baseUrl } = await startServer();
    // outside.json sits one level above assets/ (a sibling of it under
    // static-dist/), and is a compressible extension — the same code path
    // (readFile + getCompressed, no `send` module underneath) a non-fixture
    // file like package.json would take, so this exercises this middleware's
    // own guard rather than `send`'s built-in `..` rejection on the
    // non-compressible branch.
    const response = await rawRequest(baseUrl, '/assets/../outside.json');
    expect(response.status).toBe(404);
    expect(response.body.toString('utf8')).not.toContain('lives outside');
  });

  it('rejects an encoded-separator traversal attempt with 404, even though the target file is real', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, '/assets/%2e%2e%2foutside.json');
    expect(response.status).toBe(404);
    expect(response.body.toString('utf8')).not.toContain('lives outside');
  });

  it('rejects a malformed percent-encoding with 404', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, '/assets/%E0%A4%A');
    expect(response.status).toBe(404);
  });

  it('rejects a dotfile/dotdir segment with 404, matching express.static\'s default', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, '/assets/.env');
    expect(response.status).toBe(404);
    const nested = await rawRequest(baseUrl, `/assets/.hidden/${JS_FILE}`);
    expect(nested.status).toBe(404);
  });

  it('a path that treats a file as a directory (ENOTDIR) is a 404 with an empty body', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}/x`);
    expect(response.status).toBe(404);
    expect(response.body.length).toBe(0);
  });

  it('a 300-character filename (ENAMETOOLONG) is a 404', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${'a'.repeat(300)}.js`);
    expect(response.status).toBe(404);
    expect(response.body.length).toBe(0);
  });

  it('serves a .woff2 uncompressed but with the immutable Cache-Control', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${WOFF2_FILE}`, {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.body.equals(WOFF2_BYTES)).toBe(true);
  });

  it('sets Vary: Accept-Encoding on a compressible response', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${CSS_FILE}`, {
      headers: { 'Accept-Encoding': 'br' },
    });
    expect(response.headers.vary).toBe('Accept-Encoding');
  });

  it('compresses a given file only once across repeated requests', async () => {
    const brotliSpy = vi.spyOn(zlib, 'brotliCompress');
    const { baseUrl } = await startServer();

    const first = await rawRequest(baseUrl, `/assets/${CACHE_CHECK_FILE}`, { headers: { 'Accept-Encoding': 'br' } });
    expect(first.status).toBe(200);
    expect(brotliSpy.mock.calls.length).toBe(1);

    const second = await rawRequest(baseUrl, `/assets/${CACHE_CHECK_FILE}`, { headers: { 'Accept-Encoding': 'br' } });
    expect(second.status).toBe(200);
    expect(brotliSpy.mock.calls.length).toBe(1);
  });

  it('does not read the file from disk again on a compressed-cache hit', async () => {
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const { baseUrl } = await startServer();

    const first = await rawRequest(baseUrl, `/assets/${CSS_FILE}`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(first.status).toBe(200);
    const readsAfterFirst = readFileSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await rawRequest(baseUrl, `/assets/${CSS_FILE}`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(second.status).toBe(200);
    expect(readFileSpy.mock.calls.length).toBe(readsAfterFirst);
  });

  it('shares one in-flight compression across concurrent first requests', async () => {
    // CACHE_CHECK_FILE's br encoding was cached by the previous test; its
    // gzip encoding is still cold, so this is the first request to compress it.
    const gzipSpy = vi.spyOn(zlib, 'gzip');
    const { baseUrl } = await startServer();

    const [a, b] = await Promise.all([
      rawRequest(baseUrl, `/assets/${CACHE_CHECK_FILE}`, { headers: { 'Accept-Encoding': 'gzip' } }),
      rawRequest(baseUrl, `/assets/${CACHE_CHECK_FILE}`, { headers: { 'Accept-Encoding': 'gzip' } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(gzipSpy.mock.calls.length).toBe(1);
  });

  it('leaves other HTTP methods alone', async () => {
    const { baseUrl } = await startServer();
    const response = await rawRequest(baseUrl, `/assets/${JS_FILE}`, { method: 'POST' });
    // No POST handler anywhere: falls through to the catch-all fixture body.
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe(INDEX_HTML_BODY);
  });
});
