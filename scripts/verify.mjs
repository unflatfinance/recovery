// Rebuilds the page from this source and compares it, byte for byte, with the
// page served at a URL (default: the published GitHub Pages copy).
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = process.argv[2] ?? 'https://unflatfinance.github.io/recovery/';
execSync('node build.mjs', { stdio: 'ignore' });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const local = sha(readFileSync('dist/index.html'));
const res = await fetch(url, { cache: 'no-store' });
if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
const remote = sha(Buffer.from(await res.arrayBuffer()));
console.log(`local  ${local}\nremote ${remote}  (${url})`);
if (local !== remote) {
  console.error('DIFFERENT: the published page is not the one built from this source.');
  process.exit(1);
}
console.log('IDENTICAL: the published page is exactly this source.');
