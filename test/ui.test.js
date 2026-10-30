// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:8787/"}
// The real page module against the real Base chain, with a fake wallet that
// records what the page asks of it. Keys are random and made up; when a test
// needs money on one, it exists only in the RPC answers (state overrides added
// to eth_call / eth_simulateV1 on the way out). Real unflat accounts are used
// only with RECOVERY_LIVE_FIXTURES (see chain.test.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, encodeAbiParameters, toHex } from 'viem';

const live = process.env.RECOVERY_LIVE_FIXTURES ? JSON.parse(readFileSync(process.env.RECOVERY_LIVE_FIXTURES, 'utf8')) : null;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEST = '0x0000000000000000000000000000000000C0FFEE'; // never used: no key exists
const randomAddress = () => getAddress(`0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`);

// Give `key` some ETH and USDC, only in what the RPC answers to the page.
const realFetch = globalThis.fetch;
function fundInRpc(key, { eth, usdc }) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, 9n])); // USDC balances: slot 9
  const overrides = { [USDC]: { stateDiff: { [slot]: toHex(usdc, { size: 32 }) } }, [key]: { balance: toHex(eth) } };
  const rewrite = (m) => {
    if (m.method === 'eth_call') return { ...m, params: [m.params[0], m.params[1] ?? 'latest', overrides] };
    if (m.method === 'eth_simulateV1') {
      const [opts, ...rest] = m.params;
      return { ...m, params: [{ ...opts, blockStateCalls: opts.blockStateCalls.map((b) => ({ ...b, stateOverrides: { ...overrides, ...b.stateOverrides } })) }, ...rest] };
    }
    return m;
  };
  const patched = async (url, init) => {
    const body = JSON.parse(init.body);
    const single = !Array.isArray(body);
    const msgs = single ? [body] : body;
    const balanceIds = new Set(msgs.filter((m) => m.method === 'eth_getBalance' && getAddress(m.params[0]) === key).map((m) => m.id));
    const res = await realFetch(url, { ...init, body: JSON.stringify(single ? rewrite(body) : msgs.map(rewrite)) });
    if (!balanceIds.size) return res;
    const out = await res.json();
    const fix = (r) => (balanceIds.has(r.id) ? { ...r, result: toHex(eth) } : r);
    return new Response(JSON.stringify(single ? fix(out) : out.map(fix)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  globalThis.fetch = patched;
  window.fetch = patched;
}

function fakeWallet(account, chainId = '0x2105') {
  const calls = [];
  return {
    calls,
    on() {},
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') { chainId = '0x2105'; return null; }
      if (method === 'eth_sendTransaction') return `0x${'ab'.repeat(32)}`;
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function boot(account, chainId) {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
  window.ethereum = fakeWallet(account, chainId);
  await import('../src/app.js');
  return window.ethereum;
}
const $ = (sel) => document.querySelector(sel);
const text = () => document.getElementById('app').textContent;
const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
const until = (fn, ms = 30000) => vi.waitFor(() => { if (!fn()) throw new Error('not yet'); }, { timeout: ms, interval: 100 });

// tick every confirmation box one by one (each tick re-renders the page)
async function confirmAll() {
  for (let i = 0; i < 3; i++) {
    const box = [...document.querySelectorAll('input[type=checkbox]')].find((b) => !b.checked);
    if (!box) return;
    box.checked = true; box.dispatchEvent(new Event('change'));
  }
}

async function typeDest(value) {
  const input = $('#dest');
  input.value = value;
  input.dispatchEvent(new Event('input'));
  button('Controlla').click();
}

describe('recovery page', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { globalThis.fetch = realFetch; window.fetch = realFetch; });

  it('asks to switch to Base when the wallet is on another network', async () => {
    const w = await boot(randomAddress(), '0x1');
    button('Collega il wallet').click();
    await until(() => button('Passa alla rete Base'));
    button('Passa alla rete Base').click();
    await until(() => text().includes('Non c\'è niente da recuperare'));
    expect(w.calls.map((c) => c.method)).toContain('wallet_switchEthereumChain');
  });

  it('a key with ETH and money on itself gets a send button that sends exactly the simulated transfer', async () => {
    const key = randomAddress();
    fundInRpc(key, { eth: 10n ** 16n, usdc: 7_000_000n }); // 0.01 ETH, 7 USDC
    const w = await boot(key);
    button('Collega il wallet').click();
    await until(() => text().includes('Soldi già sul tuo wallet'));
    // only one text field on the whole page, and it is the destination
    const fields = [...document.querySelectorAll('input, textarea')];
    expect(fields.filter((f) => f.type !== 'checkbox').map((f) => f.id)).toEqual(['dest']);

    await typeDest(DEST.replace('FFEE', 'FfEE')); // one letter mistyped: bad checksum
    await until(() => text().includes('sembra sbagliata'));
    expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(0);

    await typeDest(DEST);
    await until(() => document.querySelector('input[type=checkbox]'));
    expect(text()).toContain('Indirizzo mai usato');
    await confirmAll();
    await until(() => button('Invia con il wallet'));
    expect(text()).toContain(`Arriveranno 7,00 USDC a ${DEST}`);
    button('Invia con il wallet').click();
    await until(() => w.calls.some((c) => c.method === 'eth_sendTransaction'));
    const [tx] = w.calls.find((c) => c.method === 'eth_sendTransaction').params;
    expect(tx).toMatchObject({ from: key, to: USDC, value: '0x0' });
    // ERC-20 transfer(DEST, 7 USDC)
    expect(tx.data).toBe('0xa9059cbb0000000000000000000000000000000000000000000000000000000000c0ffee00000000000000000000000000000000000000000000000000000000006acfc0');
    // only allowed methods were ever asked of the wallet
    expect(new Set(w.calls.map((c) => c.method))).toEqual(new Set(['eth_requestAccounts', 'eth_chainId', 'eth_sendTransaction']));
  });

  it('an unknown key gets no transaction and the support address', async () => {
    await boot(randomAddress());
    button('Collega il wallet').click();
    await until(() => text().includes('Non c\'è niente da recuperare'));
    expect(text()).toContain('info@unflat.eu');
    expect($('#dest')).toBeNull();
  });
});

describe.skipIf(!live)('real unflat accounts (private fixtures)', () => {
  it('account A: shows the savings, accepts the destination, simulates, and blocks the send for missing ETH', async () => {
    const w = await boot(live.A.owner);
    button('Collega il wallet').click();
    await until(() => text().includes('Totale stimato'));
    expect(text()).toContain('Steakhouse High Yield');
    // only one text field on the whole page, and it is the destination
    const fields = [...document.querySelectorAll('input, textarea')];
    expect(fields.filter((f) => f.type !== 'checkbox').map((f) => f.id)).toEqual(['dest']);

    await typeDest(DEST.replace('FFEE', 'FfEE')); // one letter mistyped: bad checksum
    await until(() => text().includes('sembra sbagliata'));
    expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(0);

    await typeDest(DEST);
    await until(() => document.querySelector('input[type=checkbox]'));
    expect(text()).toContain('Indirizzo mai usato');
    await confirmAll();
    await until(() => text().includes('Arriveranno'));
    expect(text()).toMatch(new RegExp(`Arriveranno [\\d.]+,\\d\\d USDC a ${DEST}`));
    expect(text()).toContain('servono un po\' di ETH');
    expect(button('Invia con il wallet')).toBeUndefined();
    expect(w.calls.map((c) => c.method)).not.toContain('eth_sendTransaction');
  });
});

describe.skipIf(!live)('destination kind on the page (private fixtures)', () => {
  it('pasting the key of an unflat account shows it and offers the account instead', async () => {
    await boot(live.A.owner);
    button('Collega il wallet').click();
    await until(() => text().includes('Totale stimato'));
    await typeDest(live.unflatKey);
    await until(() => text().includes('Chiave di un conto unflat'));
    expect(text()).toContain(`non sul conto unflat ${live.unflatAccount}`);
    button(`Usa il conto unflat ${live.unflatAccount}`).click();
    await until(() => text().includes('Conto unflat ✓'));
    expect($('#dest').value).toBe(live.unflatAccount);
    expect(text()).not.toContain('Chiave di un conto unflat');
  });
});
