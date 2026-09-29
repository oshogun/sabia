import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import zlib from 'zlib';

// Extensions worth spending CPU compressing. Fonts and images are already
// compressed formats — brotli/gzip on top of them wastes time and rarely
// shrinks a byte, so they go out as-is.
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.svg', '.json', '.map', '.txt', '.html',
]);

// Called through the zlib module object at request time (not bound to a
// captured function reference at import time) so a test can
// `vi.spyOn(zlib, 'brotliCompress')` and see every call; cache hits skip it
// entirely.
function compressBrotli(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.brotliCompress(
      input,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

function compressGzip(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(input, { level: 9 }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

type ChosenEncoding = 'br' | 'gzip' | null;

// A minimal Accept-Encoding parser: enough to honour q=0 exclusions and pick
// the best of br/gzip, not a full RFC 7231 implementation (no wildcard
// weighting beyond what real browsers actually send).
function chooseEncoding(header: string | undefined): ChosenEncoding {
  if (!header) return null;
  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const [codingRaw, ...params] = part.split(';');
    const coding = codingRaw.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q' && value !== undefined) {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    weights.set(coding, q);
  }
  const wildcard = weights.get('*') ?? 0;
  const brQ = weights.get('br') ?? wildcard;
  const gzipQ = weights.get('gzip') ?? wildcard;
  if (brQ > 0) return 'br';
  if (gzipQ > 0) return 'gzip';
  return null;
}

// Compressed bytes, keyed by absolute path + mtimeMs + size + encoding so a
// rebuilt file (new hash-named asset, but even a same-named one changing
// under a dev rebuild) never serves stale compressed output. In-flight
// compressions are shared so concurrent first requests for the same asset
// don't each pay for their own brotli pass.
const compressedCache = new Map<string, Buffer>();
const pendingCompression = new Map<string, Promise<Buffer>>();

function cacheKey(absPath: string, stat: fs.Stats, encoding: 'br' | 'gzip'): string {
  return `${absPath}:${stat.mtimeMs}:${stat.size}:${encoding}`;
}

// `loadOriginal` is only invoked on an actual cache miss — a cache hit or an
// already in-flight compression for the same key never reads the file again.
async function getCompressed(
  absPath: string, stat: fs.Stats, encoding: 'br' | 'gzip', loadOriginal: () => Promise<Buffer>,
): Promise<Buffer> {
  const key = cacheKey(absPath, stat, encoding);
  const cached = compressedCache.get(key);
  if (cached) return cached;
  const inFlight = pendingCompression.get(key);
  if (inFlight) return inFlight;
  const promise = loadOriginal()
    .then(original => (encoding === 'br' ? compressBrotli(original) : compressGzip(original)))
    .then(compressed => {
      compressedCache.set(key, compressed);
      pendingCompression.delete(key);
      return compressed;
    })
    .catch(err => {
      pendingCompression.delete(key);
      throw err;
    });
  pendingCompression.set(key, promise);
  return promise;
}

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Filesystem errors that mean "there is nothing to serve at this path" —
// a plain 404, same as ENOENT. ENOTDIR: a path segment treats a file as a
// directory (`<js file>/x`). ENAMETOOLONG: a component past the filesystem's
// limit. EISDIR: the resolved path is a directory, not a file (stat already
// filters most of these via isFile(), but a directory can still fail this way
// on a raw read).
const NOT_FOUND_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR']);

// Resolves a decoded request sub-path strictly inside `root`, behind two
// independent layers: the dot-segment check below rejects `..` itself (and
// any dotfile/dotdir, matching express.static's default `dotfiles: 'ignore'`)
// first, then the containment check after path.resolve() rejects anything
// that still lands outside `root` — an encoded separator decodes to a plain
// `/` or `..` by the time either check runs, so there's no separate case for
// it. The second layer stands on its own: it still holds even if the first
// were ever weakened or removed. Null for either rejection or a NUL byte, all
// handled as 404 by the caller.
function resolveInsideRoot(root: string, decodedSubPath: string): string | null {
  if (decodedSubPath.includes('\0')) return null;
  if (decodedSubPath.split('/').some(segment => segment.startsWith('.'))) return null;
  const target = path.resolve(root, `.${decodedSubPath}`);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Serves hashed client assets (`/assets/*`) compressed and cached as
 * immutable: brotli when the client accepts it, gzip otherwise, identity
 * only when neither is offered. Non-compressible files (fonts, images) are
 * sent as-is with the same long cache lifetime. A missing or out-of-root
 * file is a plain 404 — it never falls through to the SPA's index.html.
 */
export function createAssetsMiddleware(distDir: string): express.RequestHandler {
  const assetsRoot = path.join(distDir, 'assets');

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }

    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      res.status(404).end();
      return;
    }

    const targetPath = resolveInsideRoot(assetsRoot, decoded);
    if (!targetPath) { res.status(404).end(); return; }

    fs.promises.stat(targetPath)
      .then(async stat => {
        if (!stat.isFile()) { res.status(404).end(); return; }

        const ext = path.extname(targetPath).toLowerCase();
        res.set('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        res.type(ext);

        if (!COMPRESSIBLE_EXTENSIONS.has(ext)) {
          if (req.method === 'HEAD') {
            res.set('Content-Length', String(stat.size));
            res.status(200).end();
            return;
          }
          res.sendFile(path.relative(assetsRoot, targetPath), { root: assetsRoot }, err => {
            if (err && !res.headersSent) res.status(404).end();
          });
          return;
        }

        res.set('Vary', 'Accept-Encoding');
        const encoding = chooseEncoding(req.headers['accept-encoding'] as string | undefined);
        // The file is only actually read on a compression cache miss (or for
        // identity, which has no cache to hit) — a cached compressed asset
        // never touches disk again.
        const body = encoding
          ? await getCompressed(targetPath, stat, encoding, () => fs.promises.readFile(targetPath))
          : await fs.promises.readFile(targetPath);

        if (encoding) res.set('Content-Encoding', encoding);
        res.set('Content-Length', String(body.length));
        if (req.method === 'HEAD') { res.status(200).end(); return; }
        res.status(200).end(body);
      })
      .catch(err => {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code && NOT_FOUND_ERROR_CODES.has(code)) { res.status(404).end(); return; }
        // Never next(err): past this point the request is inside a public,
        // unauthenticated static handler, and Express's default error
        // handler would answer with a stack trace and the install path.
        console.error('[Assets] request failed:', (err as Error).message);
        if (!res.headersSent) res.status(500).end();
      });
  };
}

// Fire-and-forget: primes the compressed-asset cache right after the server
// starts listening so the first real request for each JS/CSS asset doesn't
// pay for its own brotli pass. Never awaited by the caller and never lets a
// read/compress failure reach it — startup must not depend on this.
export async function warmAssets(distDir: string): Promise<void> {
  const assetsRoot = path.join(distDir, 'assets');
  let entries: string[];
  try {
    entries = await fs.promises.readdir(assetsRoot);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter(name => ['.js', '.css'].includes(path.extname(name).toLowerCase()))
    .map(async name => {
      const absPath = path.join(assetsRoot, name);
      try {
        const stat = await fs.promises.stat(absPath);
        // Read once, shared by both encodings — a loader that just returns
        // the same already-resolved buffer each time it's called.
        const original = await fs.promises.readFile(absPath);
        const loadOriginal = () => Promise.resolve(original);
        await Promise.all([
          getCompressed(absPath, stat, 'br', loadOriginal),
          getCompressed(absPath, stat, 'gzip', loadOriginal),
        ]);
      } catch (err) {
        console.warn(`[Assets] Precompress warm-up failed for ${name}:`, (err as Error).message);
      }
    }));
}
