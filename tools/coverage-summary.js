'use strict';
// Markdown coverage report from coverage/lcov.info: one row per file, a total, and what is not covered.
// usage: node tools/coverage-summary.js [lcov file] >> "$GITHUB_STEP_SUMMARY"
// Exits 1 when the lcov file is missing or empty, so a broken collection never reads as "0 %".
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const file = process.argv[2] || path.join(root, 'coverage', 'lcov.info');
if (!fs.existsSync(file) || !fs.statSync(file).size) {
  console.error(`no coverage data at ${file}`);
  process.exit(1);
}

const files = [];
let cur = null;
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const [tag, value = ''] = line.split(/:(.*)/s);
  if (tag === 'SF') {
    // lcov paths are absolute and differ per runner: keep the part inside the repository
    const rel = value.replace(/\\/g, '/').replace(/^.*?\/(lib|nodes)\//, '$1/');
    cur = { file: rel, lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0, missing: [] };
    files.push(cur);
  } else if (cur && ['LF', 'LH', 'BRF', 'BRH', 'FNF', 'FNH'].includes(tag)) {
    cur[tag.toLowerCase()] = Number(value);
  } else if (cur && tag === 'DA') {
    const [ln, hits] = value.split(',');
    if (hits === '0') cur.missing.push(`line ${ln}`);
  } else if (cur && tag === 'BRDA') {
    const [ln, , , hits] = value.split(',');
    if (hits === '0' || hits === '-') cur.missing.push(`branch at ${ln}`);
  }
}
if (!files.length) {
  console.error(`no source files in ${file}`);
  process.exit(1);
}

const pct = (hit, found) => (found ? (100 * hit) / found : 100);
const cell = (hit, found) => {
  const p = pct(hit, found);
  return `${p === 100 ? '' : '**'}${p.toFixed(2)} %${p === 100 ? '' : '**'} (${hit}/${found})`;
};
const sum = (k) => files.reduce((n, f) => n + f[k], 0);

const out = [];
out.push('## Coverage', '');
out.push('| File | Lines | Branches | Functions |', '|---|---|---|---|');
for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) out.push(`| \`${f.file}\` | ${cell(f.lh, f.lf)} | ${cell(f.brh, f.brf)} | ${cell(f.fnh, f.fnf)} |`);
out.push(`| **Total** | ${cell(sum('lh'), sum('lf'))} | ${cell(sum('brh'), sum('brf'))} | ${cell(sum('fnh'), sum('fnf'))} |`, '');

const gaps = files.filter((f) => f.missing.length || f.fnh < f.fnf);
if (gaps.length) {
  out.push('### Not covered', '');
  for (const f of gaps) out.push(`- \`${f.file}\`: ${[...new Set(f.missing)].join(', ') || `${f.fnf - f.fnh} function(s)`}`);
} else {
  out.push('Every line, branch and function of `lib/` and `nodes/` is run by a test.');
}
console.log(out.join('\n'));
