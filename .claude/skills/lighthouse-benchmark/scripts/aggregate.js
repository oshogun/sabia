// Medians of the Lighthouse runs per build/page/preset, before vs after.
// Reads raw Lighthouse 13 JSON reports named <tag>-<page>-<preset>-<n>.json.
const fs = require('fs');
const dir = process.argv[2];
if (!dir) { console.error('usage: node aggregate.js <scratch-dir>/results'); process.exit(1); }
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function extract(r) {
  const a = r.audits;
  const reqs = a['network-requests'].details.items || [];
  const assets = reqs.filter(x => x.resourceType === 'Script' || x.resourceType === 'Stylesheet');
  return {
    score: r.categories.performance.score,
    fcp: a['first-contentful-paint'].numericValue,
    lcp: a['largest-contentful-paint'].numericValue,
    tbt: a['total-blocking-time'].numericValue,
    cls: a['cumulative-layout-shift'].numericValue,
    bytes: reqs.reduce((s, x) => s + (x.transferSize || 0), 0),
    assetTransfer: assets.reduce((s, x) => s + (x.transferSize || 0), 0),
    assetResource: assets.reduce((s, x) => s + (x.resourceSize || 0), 0),
    unusedJs: a['unused-javascript']?.details?.overallSavingsBytes || 0,
    unusedCss: a['unused-css-rules']?.details?.overallSavingsBytes || 0,
    error: r.runtimeError?.code,
  };
}

const rows = {}; const tags = new Set(); const pages = new Set();
for (const f of fs.readdirSync(dir).filter(f => /^[a-z0-9]+-[a-z0-9]+-(desktop|mobile)-\d+\.json$/.test(f))) {
  const [tag, page, preset] = f.split('-');
  const r = extract(JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
  if (r.error) { console.error(`skipping ${f}: ${r.error}`); continue; }
  tags.add(tag); pages.add(page);
  ((rows[`${preset}|${page}`] ??= {})[tag] ??= []).push(r);
}
const order = ['before', 'after'].filter(t => tags.has(t)).concat([...tags].filter(t => t !== 'before' && t !== 'after'));
const ms = v => (v / 1000).toFixed(2) + ' s';
const kb = v => Math.round(v / 1024) + ' KB';
for (const preset of ['desktop', 'mobile'].filter(p => Object.keys(rows).some(k => k.startsWith(p + '|')))) {
  console.log(`\n### ${preset} (median of runs; ${order.join(' → ')})\n`);
  console.log('| page | runs | score | FCP | LCP | TBT | CLS | transfer | JS+CSS sent / unpacked | unused JS |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const page of [...pages]) {
    const g = rows[`${preset}|${page}`] || {};
    const col = (k, fmt) => order.map(t => g[t] ? fmt(med(g[t].map(r => r[k]))) : '—').join(' → ');
    const n = order.map(t => g[t]?.length ?? 0).join('/');
    console.log(`| ${page} | ${n} | ${col('score', v => Math.round(v * 100))} | ${col('fcp', ms)} | ${col('lcp', ms)} | ${col('tbt', v => Math.round(v) + ' ms')} | ${col('cls', v => v.toFixed(3))} | ${col('bytes', kb)} | ${order.map(t => g[t] ? `${kb(med(g[t].map(r => r.assetTransfer)))} / ${kb(med(g[t].map(r => r.assetResource)))}` : '—').join(' → ')} | ${col('unusedJs', kb)} |`);
  }
}
