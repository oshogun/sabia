#!/usr/bin/env node
// Guards the print/PDF-export island: it must stay a small, Carbon-free,
// app-free bundle. A stray import that re-links it into the dashboard chunk
// changes the exported PDF's layout (fonts, resets) without failing any
// functional test — the only thing that reliably catches it is the build
// output and the source import graph, which is what this script checks.
//
// Usage:
//   node scripts/check-print-chunk.mjs [distDir] [entrySrcPath]
//
//   distDir       - a client/ build output directory containing
//                   .vite/manifest.json (produced by `vite build --manifest
//                   --outDir <distDir>`). Default: "dist".
//   entrySrcPath  - the print entry module to start the source import-graph
//                   walk from, relative to client/. Default:
//                   "src/print/entry.tsx". Point this at a scratch copy to
//                   negative-test the graph check without touching the real
//                   src/print/entry.tsx (the CSS/manifest checks below still
//                   run against distDir, which must come from a build of
//                   whatever entry file is under test).
//
// Exits 0 if every check passes, 1 otherwise, printing a PASS/FAIL line per
// check either way.

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const clientRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.resolve(clientRoot, process.argv[2] ?? 'dist');
const entrySrcPath = path.resolve(clientRoot, process.argv[3] ?? 'src/print/entry.tsx');

let failed = false;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failed = true;
}

// ---------------------------------------------------------------------------
// Part A/C: manifest-driven checks against a real build (distDir).
// ---------------------------------------------------------------------------

const manifestPath = path.join(distDir, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  report(
    'manifest present',
    false,
    `no ${manifestPath} - run 'vite build --manifest --outDir ${path.relative(clientRoot, distDir)}' first`,
  );
} else {
  report('manifest present', true, manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Find the manifest entry for the print entry module (matched by its src
  // path relative to client/, not by the current entrySrcPath argument -
  // that argument only controls the source-graph walk in Part B; the build
  // itself must have been produced from whichever entry.tsx is under test).
  const entryKey = Object.keys(manifest).find(
    (k) => manifest[k].src === 'src/print/entry.tsx' || k === 'src/print/entry.tsx',
  );

  if (!entryKey) {
    report('print entry chunk found in manifest', false, 'no src/print/entry.tsx entry in manifest');
    report('shared-chunk CSS is leaflet-only', false, 'no print entry chunk to walk the import graph from');
  } else {
    report('print entry chunk found in manifest', true, entryKey);
    const entryChunk = manifest[entryKey];
    const css = entryChunk.css ?? [];

    report('print entry emits exactly one CSS file', css.length === 1, `got ${css.length}: ${css.join(', ')}`);

    if (css.length >= 1) {
      const cssPath = path.join(distDir, css[0]);
      const size = statSync(cssPath).size;
      report('print entry CSS is under 5 kB', size < 5 * 1024, `${size} bytes (${cssPath})`);

      const cssText = readFileSync(cssPath, 'utf8');
      const forbidden = ['cds--', '@font-face', '#161616'];
      const found = forbidden.filter((needle) => cssText.includes(needle));
      report(
        'print entry CSS contains no Carbon markers',
        found.length === 0,
        found.length ? `found: ${found.join(', ')}` : 'clean',
      );
    }

    // Import graph at the chunk level: the print entry's own chunk must
    // never statically or dynamically pull in the appEntry chunk.
    const reachesAppEntry = (entryChunk.imports ?? []).some((k) => manifest[k]?.src === 'src/appEntry.tsx');
    report('print entry chunk does not import the appEntry chunk', !reachesAppEntry);

    // Chunks reachable from the print entry, walked transitively through the
    // manifest's `imports` and `dynamicImports` - the only ones the print
    // island can actually load at runtime. Route-level code splitting
    // (React.lazy) means the manifest also holds chunks shared between app
    // *routes* (e.g. a chunk several pages import) that carry their own CSS;
    // those are never reachable from the print entry and must not be flagged
    // just for existing. Only a chunk both the print entry and the app can
    // reach - leaflet is the only one expected - may carry CSS here.
    const reachable = new Set();
    const queue = [entryKey];
    while (queue.length) {
      const key = queue.shift();
      if (reachable.has(key) || !manifest[key]) continue;
      reachable.add(key);
      for (const next of [...(manifest[key].imports ?? []), ...(manifest[key].dynamicImports ?? [])]) {
        if (!reachable.has(next)) queue.push(next);
      }
    }

    const reachableCssFiles = new Set();
    for (const key of reachable) {
      if (key === entryKey) continue; // the entry's own CSS is checked above, not here
      const v = manifest[key];
      if (key.endsWith('.css')) {
        reachableCssFiles.add(v.file); // a CSS-only manifest key reached directly
        continue;
      }
      if (v.isEntry || v.isDynamicEntry) continue; // only shared, non-entry chunks count here
      for (const f of v.css ?? []) reachableCssFiles.add(f);
    }

    const nonLeaflet = [...reachableCssFiles].filter((f) => !f.toLowerCase().includes('leaflet'));
    report(
      'shared-chunk CSS is leaflet-only',
      nonLeaflet.length === 0,
      nonLeaflet.length
        ? nonLeaflet.join(', ')
        : `${reachableCssFiles.size} shared CSS file(s) reachable from the print entry, all leaflet`,
    );
  }
}

// ---------------------------------------------------------------------------
// Part B: source-level static+dynamic import graph walk, starting at
// entrySrcPath. Does not require a build - safe to point at a scratch copy.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  { label: 'appEntry', test: (abs) => abs.endsWith(path.join('src', 'appEntry.tsx')) },
  { label: 'App', test: (abs) => abs.endsWith(path.join('src', 'App.tsx')) },
  { label: 'styles', test: (abs) => abs.includes(path.join('src', 'styles') + path.sep) || abs.includes(path.join('src', 'styles.')) },
  { label: 'src/api (domain layer)', test: (abs) => abs.includes(path.join('src', 'api') + path.sep) },
];

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare specifier (react, leaflet, ...) - not our source graph
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.css`,
    `${base}.scss`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function walk(file, visited, violations) {
  const abs = path.resolve(file);
  if (visited.has(abs)) return;
  visited.add(abs);

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(abs)) {
      violations.push({ file: abs, reason: pattern.label });
      return; // don't descend further into a forbidden module
    }
  }

  if (!existsSync(abs) || !statSync(abs).isFile()) return;
  if (/\.(css|scss)$/.test(abs)) return; // stylesheets don't import JS modules we care about here

  const text = readFileSync(abs, 'utf8');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1] ?? m[2];
    const resolved = resolveModule(abs, spec);
    if (resolved) walk(resolved, visited, violations);
  }
}

if (!existsSync(entrySrcPath)) {
  report('source import-graph walk', false, `entry source not found: ${entrySrcPath}`);
} else {
  const violations = [];
  walk(entrySrcPath, new Set(), violations);
  report(
    'print entry source import graph never reaches appEntry/App/styles/src-api',
    violations.length === 0,
    violations.length
      ? violations.map((v) => `${path.relative(clientRoot, v.file)} (${v.reason})`).join('; ')
      : `walked from ${path.relative(clientRoot, entrySrcPath)}, clean`,
  );
}

process.exit(failed ? 1 : 0);
