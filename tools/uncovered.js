'use strict';
// Lists uncovered branches and functions from coverage/lcov.info with their source lines.
// usage: npm run coverage:report  (after npm run coverage:lcov)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lcov = fs.readFileSync(path.join(root, 'coverage', 'lcov.info'), 'utf8');
let file = null;
const found = new Set();
for (const line of lcov.split(/\r?\n/)) {
  if (line.startsWith('SF:')) file = path.relative(root, line.slice(3)).replace(/\\/g, '/');
  else if (line.startsWith('BRDA:')) {
    const [ln, , , hits] = line.slice(5).split(',');
    if (hits === '0' || hits === '-') found.add(`${file}:${ln}`);
  } else if (line.startsWith('FNDA:0,')) found.add(`${file} function ${line.slice(7)}`);
}
for (const entry of [...found].sort()) {
  const m = /^(.+):(\d+)$/.exec(entry);
  if (!m) {
    console.log(entry);
    continue;
  }
  const src = fs.readFileSync(path.join(root, m[1]), 'utf8').split(/\r?\n/)[Number(m[2]) - 1].trim();
  console.log(`${entry.padEnd(28)} ${src.slice(0, 150)}`);
}
if (!found.size) console.log('everything covered');
