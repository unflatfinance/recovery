// The page must never offer a place to type a key or a seed, and must never
// ask the wallet for anything but account, network and a transaction.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'node-html-parser';
import { walletRequest, ALLOWED_METHODS } from '../src/wallet.js';
import { ADDR } from '../src/core.js';

let html;
beforeAll(() => {
  execSync('node build.mjs', { stdio: 'ignore' });
  html = readFileSync('dist/index.html', 'utf8');
});

const SECRET_WORDS = /priv|seed|mnemonic|phrase|secret|passw|chiave|parol/i;

describe('built page', () => {
  it('ships no form field at all in the static HTML (fields are built by the script)', () => {
    const doc = parse(html);
    expect(doc.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(0);
  });

  it('loads nothing from outside and talks only to the public Base RPC', () => {
    const doc = parse(html);
    expect(doc.querySelectorAll('script[src], link, img[src], iframe')).toHaveLength(0);
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('connect-src https://mainnet.base.org;');
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
});

describe('page source', () => {
  const src = Object.fromEntries(readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(`src/${f}`, 'utf8')]));

  it('creates only one text field (the destination) and checkboxes, never textarea or password', () => {
    const inputs = [...src['app.js'].matchAll(/el\('input', \{([^}]*)/g)].map((m) => m[1]);
    const types = inputs.map((a) => a.match(/type: '(\w+)'/)?.[1]);
    expect(types.filter((x) => x === 'text')).toHaveLength(1);
    expect(types.every((x) => x === 'text' || x === 'checkbox')).toBe(true);
    expect(inputs.find((a) => a.includes("type: 'text'"))).toContain("id: 'dest'");
    for (const f of Object.values(src)) {
      expect(f).not.toMatch(/el\('(textarea|select)'|contenteditable|type: 'password'/);
    }
  });

  it('uses no label, id or placeholder that invites to paste a key or a seed', () => {
    const ids = [...src['app.js'].matchAll(/(?:id|name|placeholder|autocomplete): '([^']*)'/g)].map((m) => m[1]);
    expect(ids.filter((x) => SECRET_WORDS.test(x))).toEqual([]);
  });

  it('reaches the wallet only through walletRequest', () => {
    for (const [name, f] of Object.entries(src)) {
      if (name === 'wallet.js') continue;
      expect(f, name).not.toMatch(/\.request\(\s*\{/);
    }
  });
});

describe('walletRequest', () => {
  const provider = { request: async ({ method }) => method };
  it.each(['personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'wallet_requestPermissions', 'eth_getEncryptionPublicKey', 'eth_decrypt', 'wallet_sendCalls'])(
    'refuses %s',
    async (m) => { await expect(walletRequest(provider, m, [])).rejects.toThrow('not allowed'); },
  );
  it('allows only account, network and send-transaction methods', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'eth_sendTransaction', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
  });
});

// This repo is public: only protocol contracts and made-up examples, never a
// real user's account, key, balance or transaction.
describe('no real accounts in the repo', () => {
  const SKIP = new Set(['node_modules', '.git', 'dist']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const p = `${dir}/${d.name}`;
    return d.isDirectory() ? walk(p) : [p];
  });
  const files = walk('.').filter((p) => !p.endsWith('package-lock.json') && !p.endsWith('.DS_Store'));
  const text = Object.fromEntries(files.map((p) => [p, readFileSync(p, 'utf8')]));

  const contracts = new Set();
  (function collect(x) {
    if (typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x)) contracts.add(x.toLowerCase());
    else if (x && typeof x === 'object') Object.values(x).forEach(collect);
  })(ADDR);
  // made-up addresses are almost all zeros, so they cannot be mistaken for a real one
  const madeUp = (hex) => hex.slice(2).match(/^0*/)[0].length >= 28;
  const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

  it('every address is a protocol contract or a made-up example', () => {
    const bad = [];
    for (const [p, t] of Object.entries(text)) {
      for (const [a] of t.matchAll(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
        if (!contracts.has(a.toLowerCase()) && !madeUp(a)) bad.push(`${p}: ${a}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('contains no transaction hash', () => {
    const bad = [];
    for (const [p, t] of Object.entries(text)) {
      for (const [h] of t.matchAll(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
        if (h.toLowerCase() !== ERC1967_SLOT && (h.match(/0/g) ?? []).length < 48) bad.push(`${p}: ${h}`);
      }
    }
    expect(bad).toEqual([]);
    expect(Object.entries(text).filter(([, t]) => /basescan\.org\/(tx|address)\//.test(t)).map(([p]) => p)).toEqual([]);
  });

  // With the private fixtures at hand, also look for their values anywhere,
  // inside calldata and in the built page too.
  it.skipIf(!process.env.RECOVERY_LIVE_FIXTURES)('none of the private fixture values appears anywhere, built page included', () => {
    const live = JSON.parse(readFileSync(process.env.RECOVERY_LIVE_FIXTURES, 'utf8'));
    const values = new Set();
    (function collect(x) {
      if (typeof x === 'string' && /^0x[0-9a-fA-F]{40,}$/.test(x)) values.add(x.slice(2).toLowerCase());
      else if (typeof x === 'string' && /^\d{7,}$/.test(x)) values.add(x);
      else if (x && typeof x === 'object') Object.values(x).forEach(collect);
    })(live);
    const everything = { ...text, 'dist/index.html': html, 'package-lock.json': readFileSync('package-lock.json', 'utf8') };
    const hits = [];
    for (const [p, t] of Object.entries(everything)) {
      const low = t.toLowerCase();
      for (const v of values) if (low.includes(v)) hits.push(`${p}: ${v}`);
    }
    expect(values.size).toBeGreaterThan(5);
    expect(hits).toEqual([]);
  });
});
