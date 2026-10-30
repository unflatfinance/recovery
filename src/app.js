// UI of the recovery page. All user-facing text comes from i18n.js; DOM is
// built with textContent only (no innerHTML), so no address or error string
// can inject markup.
import { decodeFunctionData, formatUnits, parseAbi } from 'viem';
import { ADDR, abi, assess, makeClient, prepare, probeAddress, readState, validateDestination } from './core.js';
import { BASE_CHAIN_ID_HEX, sendStep, switchToBase, walletRequest } from './wallet.js';
import { makeT, SUPPORT } from './i18n.js';

const client = makeClient();
const metaFactoryAbi = parseAbi(['function deployWithFactory(address factory, bytes createData, bytes32 salt) payable']);

const ui = {
  lang: (navigator.language || 'it').toLowerCase().startsWith('it') ? 'it' : 'en',
  provider: null,
  eoa: null,
  chainOk: false,
  loading: false,
  error: null,
  state: null,
  destInput: '',
  dest: null, // validateDestination result
  confirmed: false,
  warnAccepted: false,
  prep: null,
  preparing: false,
  sending: null, // null | 'wallet' | 'pending'
  log: [], // { kind, hash, ok }
  ocRequested: false,
};
let t = makeT(ui.lang);

// ── helpers ────────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function fmt(x, decimals, dp = 2) {
  const s = formatUnits(x, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, dp).padEnd(dp, '0');
  const n = Number(`${i}.${frac}`);
  return n.toLocaleString(ui.lang === 'it' ? 'it-IT' : 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: 'always' });
}
const tokenDec = (sym) => ADDR.tokens.find((x) => x.symbol === sym)?.decimals ?? 18;
const tokenDp = (sym) => (sym === 'USDC' ? 2 : sym === 'cbBTC' ? 8 : 6);
const scan = (path) => `https://basescan.org/${path}`;

function receivedText(received) {
  const parts = [];
  for (const [sym, v] of Object.entries(received)) {
    if (v <= 0n) continue;
    parts.push(`${fmt(v, sym === 'ETH' ? 18 : tokenDec(sym), sym === 'ETH' ? 6 : tokenDp(sym))} ${sym}`);
  }
  return parts.join(' + ');
}

// ── actions ────────────────────────────────────────────────────────────────
async function connect() {
  ui.error = null;
  ui.provider = window.ethereum ?? null;
  if (!ui.provider) return render();
  try {
    const [acc] = await walletRequest(ui.provider, 'eth_requestAccounts');
    ui.eoa = acc ?? null;
    await checkChain();
  } catch (e) {
    ui.error = e?.code === 4001 ? t('rejected') : t('sendError', { msg: e?.message ?? e });
  }
  render();
  if (ui.eoa && ui.chainOk) await load();
}

async function checkChain() {
  const id = await walletRequest(ui.provider, 'eth_chainId');
  ui.chainOk = String(id).toLowerCase() === BASE_CHAIN_ID_HEX;
}

async function doSwitch() {
  try {
    await switchToBase(ui.provider);
    await checkChain();
  } catch (e) {
    ui.error = t('sendError', { msg: e?.message ?? e });
  }
  render();
  if (ui.chainOk) await load();
}

function resetFrom(stage) {
  if (stage <= 1) { ui.state = null; ui.log = []; ui.ocRequested = false; }
  if (stage <= 2) { ui.dest = null; ui.confirmed = false; ui.warnAccepted = false; ui.destInput = stage <= 1 ? '' : ui.destInput; }
  ui.prep = null;
}

async function load() {
  ui.loading = true; ui.error = null; render();
  try {
    ui.state = await readState(client, ui.eoa);
  } catch (e) {
    console.error(e);
    ui.error = t('readError');
  }
  ui.loading = false;
  render();
  if (ui.dest?.ok && ui.confirmed) await runPrepare();
}

async function checkDest() {
  ui.confirmed = false; ui.warnAccepted = false; ui.prep = null;
  ui.dest = await validateDestination(ui.destInput, ui.state, (address) => probeAddress(client, address));
  render();
}

async function runPrepare() {
  if (!ui.dest?.ok || !ui.state) return;
  if (assess(ui.state) !== 'recoverable') { ui.prep = null; return render(); }
  ui.preparing = true; ui.prep = null; render();
  try {
    ui.prep = await prepare(client, ui.state, ui.dest.address);
  } catch (e) {
    console.error(e);
    ui.prep = { error: true };
  }
  ui.preparing = false;
  render();
}

async function send() {
  const step = ui.prep.plan.steps[0];
  const gas = (ui.prep.sim.steps[0].gasUsed * 13n) / 10n + 50_000n;
  ui.sending = 'wallet'; ui.error = null; render();
  try {
    const hash = await sendStep(ui.provider, ui.eoa, step, gas);
    ui.sending = 'pending'; render();
    const receipt = await client.waitForTransactionReceipt({ hash });
    ui.log.push({ kind: step.kind, hash, ok: receipt.status === 'success' });
    if (step.kind === 'opencover-request' && receipt.status === 'success') ui.ocRequested = true;
  } catch (e) {
    ui.error = e?.code === 4001 ? t('rejected') : t('sendError', { msg: e?.shortMessage ?? e?.message ?? e });
  }
  ui.sending = null;
  ui.prep = null;
  await load(); // fresh amounts, then a fresh plan and simulation for the next step
}

// ── rendering ──────────────────────────────────────────────────────────────
function section(title, active, ...body) {
  return el('section', { class: `card${active ? '' : ' muted'}` }, el('h2', {}, title), ...body);
}

function renderConnect() {
  if (!window.ethereum) return section(t('s1'), true, el('p', { class: 'warn' }, t('noWallet')));
  if (!ui.eoa) return section(t('s1'), true, el('button', { class: 'primary', onclick: connect }, t('connect')));
  return section(
    t('s1'),
    !ui.chainOk,
    el('p', {}, t('connected', { addr: ui.eoa })),
    !ui.chainOk && el('p', { class: 'warn' }, t('wrongNetwork')),
    !ui.chainOk && el('button', { class: 'primary', onclick: doSwitch }, t('switchNetwork')),
  );
}

function row(label, value) {
  return el('div', { class: 'row' }, el('span', {}, label), el('strong', {}, value));
}

function renderState() {
  if (!ui.eoa || !ui.chainOk) return section(t('s2'), false);
  if (ui.loading && !ui.state) return section(t('s2'), true, el('p', { class: 'status' }, t('reading')));
  if (!ui.state) return section(t('s2'), true, ui.error && el('p', { class: 'warn' }, ui.error), el('button', { onclick: load }, t('retry')));
  const s = ui.state;
  const verdict = assess(s);
  if (verdict === 'unrecognized') {
    return section(t('s2'), true, el('p', { class: 'warn' }, t('unrecognized', { addr: s.smartAccount })), el('p', { class: 'hint' }, t('wrongAccountHint')));
  }
  const rows = [];
  for (const v of s.sa.vaults) if (v.shares > 0n) rows.push(row(`${t('savings')} · ${v.name}`, `${fmt(v.assets, 6)} USDC`));
  if (s.sa.tokens.USDC > 0n) rows.push(row(t('free'), `${fmt(s.sa.tokens.USDC, 6)} USDC`));
  if (s.sa.oc.shares > 0n) rows.push(row(t('insured'), `${fmt(s.sa.oc.assets, 6)} USDC`));
  for (const tk of ADDR.tokens) {
    if (tk.symbol !== 'USDC' && s.sa.tokens[tk.symbol] > 0n) rows.push(row(t('otherTokens'), `${fmt(s.sa.tokens[tk.symbol], tk.decimals, tokenDp(tk.symbol))} ${tk.symbol}`));
  }
  if (s.sa.eth > 0n) rows.push(row(t('otherTokens'), `${fmt(s.sa.eth, 18, 6)} ETH`));
  for (const tk of ADDR.tokens) {
    if (s.eoaFunds.tokens[tk.symbol] > 0n) rows.push(row(t('onKey'), `${fmt(s.eoaFunds.tokens[tk.symbol], tk.decimals, tokenDp(tk.symbol))} ${tk.symbol}`));
  }
  const usd = s.sa.vaults.reduce((a, v) => a + v.assets, 0n) + s.sa.tokens.USDC + s.sa.oc.assets + s.eoaFunds.tokens.USDC;
  return section(
    t('s2'),
    true,
    el('p', { class: 'hint' }, `${t('yourAccount')}: `, el('a', { href: scan(`address/${s.smartAccount}`), target: '_blank', rel: 'noopener noreferrer' }, s.smartAccount)),
    !s.deployed && verdict === 'recoverable' && el('p', { class: 'note' }, t('notActivated')),
    rows.length > 0 && el('div', { class: 'rows' }, rows),
    rows.length > 0 && el('p', { class: 'total' }, t('total', { usd: fmt(usd, 6) })),
    row(t('ethForGas'), `${fmt(s.eoaFunds.eth, 18, 6)} ETH`),
    verdict === 'nothing' && el('p', { class: 'note' }, t('nothing'), el('br'), el('span', { class: 'hint' }, t('wrongAccountHint'))),
    verdict === 'waiting' && el('p', { class: 'note' }, t('waiting')),
    ui.ocRequested && el('p', { class: 'note' }, t('ocNext')),
    ui.loading && el('p', { class: 'status' }, t('reading')),
  );
}

function renderDest() {
  const s = ui.state;
  const active = s && assess(s) === 'recoverable';
  if (!active) return section(t('s3'), false);
  const d = ui.dest;
  const needsWarn = d?.ok && d.warnings.length > 0;
  return section(
    t('s3'),
    true,
    el('label', { for: 'dest' }, t('destLabel')),
    el('p', { class: 'hint', id: 'dest-help' }, t('destHelp')),
    el('div', { class: 'inline' },
      el('input', {
        id: 'dest', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
        placeholder: '0x…', value: ui.destInput, 'aria-describedby': 'dest-help',
        oninput: (e) => { ui.destInput = e.target.value; ui.dest = null; ui.confirmed = false; ui.prep = null; },
        onkeydown: (e) => { if (e.key === 'Enter') checkDest(); },
      }),
      el('button', { onclick: checkDest }, t('check')),
    ),
    d && !d.ok && el('p', { class: 'warn', role: 'alert' }, t(`err_${d.errors[0]}`)),
    d?.ok && el('p', { class: 'addr' }, d.address),
    d?.ok && el('p', { class: `kind kind-${d.kind}` }, t(`kind_${d.kind}`)),
    d?.ok && d.suggestion && el('button', { onclick: () => { ui.destInput = d.suggestion; checkDest(); } }, t('useSuggestion', { addr: d.suggestion })),
    d?.ok && d.warnings.map((w) => el('p', { class: 'warn' }, t(`warn_${w}`, { addr: d.suggestion ?? '' }))),
    needsWarn && el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: ui.warnAccepted, onchange: (e) => { ui.warnAccepted = e.target.checked; maybePrepare(); } }),
      t('confirmWarn')),
    d?.ok && el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: ui.confirmed, onchange: (e) => { ui.confirmed = e.target.checked; maybePrepare(); } }),
      t('confirmDest', { addr: d.address })),
  );
}

function maybePrepare() {
  const d = ui.dest;
  const ready = d?.ok && ui.confirmed && (d.warnings.length === 0 || ui.warnAccepted);
  if (ready) runPrepare(); else { ui.prep = null; render(); }
}

function renderSend() {
  const ready = ui.dest?.ok && ui.confirmed && (ui.dest.warnings.length === 0 || ui.warnAccepted);
  const logEls = ui.log.map((l) => el('p', { class: l.ok ? 'ok' : 'warn' }, `${t(`kind_${l.kind}`)} — `, l.ok ? t('done') : '✗ ', el('a', { href: scan(`tx/${l.hash}`), target: '_blank', rel: 'noopener noreferrer' }, short(l.hash))));
  if (ui.state && assess(ui.state) !== 'recoverable' && ui.log.length > 0) {
    return section(t('s4'), true, logEls, assess(ui.state) === 'nothing' && el('p', { class: 'ok' }, t('allDone')));
  }
  if (!ready) return section(t('s4'), false, logEls);
  if (ui.preparing || !ui.prep) return section(t('s4'), true, logEls, el('p', { class: 'status' }, t('simulating')));
  const p = ui.prep;
  if (p.error) return section(t('s4'), true, logEls, el('p', { class: 'warn' }, t('simFailed')), el('button', { onclick: runPrepare }, t('recheck')));

  const steps = p.plan.steps;
  const step = steps[0];
  const what = receivedText(p.sim.received);
  const oc = steps.find((x) => x.kind === 'opencover-request');
  const body = [
    logEls,
    p.mode === 'per-vault' && el('p', { class: 'note' }, t('perVault')),
    p.skipped.length > 0 && el('p', { class: 'warn' }, t('skipped', { names: p.skipped.map((v) => v.name).join(', ') })),
    !p.sim.ok && el('p', { class: 'warn', role: 'alert' }, t(p.sim.reason === 'nothing-moved' ? 'nothingMoved' : 'simFailed')),
    p.sim.ok && what && el('p', { class: 'expect' }, t('expect', { what, addr: ui.dest.address })),
    p.sim.ok && oc && el('p', { class: 'expect' }, t('expectOc', { usd: fmt(ui.state.sa.oc.assets, 6) })),
    oc && el('p', { class: 'hint' }, t('ocNext')),
    p.sim.ok && !p.gas.enough && el('p', { class: 'warn', role: 'alert' }, t('noGas', { need: fmt(p.gas.need, 18, 6), rec: fmt(p.gas.recommended, 18, 4), addr: ui.eoa })),
    p.sim.ok && !p.gas.enough && el('button', { onclick: load }, t('recheck')),
    steps.length > 0 && el('p', { class: 'step' }, `${t('stepOf', { i: 1, n: steps.length })}: ${t(`kind_${step.kind}`)}`),
    p.canSend && el('button', { class: 'primary', disabled: !!ui.sending, onclick: send }, ui.sending === 'wallet' ? t('confirmInWallet') : ui.sending === 'pending' ? t('pending') : t('send')),
    ui.error && el('p', { class: 'warn' }, ui.error),
    renderExpert(steps),
  ];
  return section(t('s4'), true, ...body);
}

function copyButton(text) {
  const b = el('button', { class: 'small', onclick: async () => { await navigator.clipboard.writeText(text); b.textContent = t('copied'); } }, t('copy'));
  return b;
}

function renderExpert(steps) {
  if (!steps.length) return null;
  const items = steps.map((s, i) => {
    const fields = [['to', s.to], ['value', s.value.toString()], ['data', s.data]];
    let link = null;
    if (s.to === ui.state.smartAccount) {
      const { args } = decodeFunctionData({ abi: abi.kernel, data: s.data });
      fields.push(['execute.mode', args[0]], ['execute.executionCalldata', args[1]]);
      link = scan(`address/${s.to}#writeProxyContract`);
    } else if (s.kind === 'deploy') {
      const { args } = decodeFunctionData({ abi: metaFactoryAbi, data: s.data });
      fields.push(['deployWithFactory.factory', args[0]], ['deployWithFactory.createData', args[1]], ['deployWithFactory.salt', args[2]]);
      link = scan(`address/${s.to}#writeContract`);
    }
    return el('div', { class: 'tx' },
      el('h3', {}, `${i + 1}. ${t(`kind_${s.kind}`)}`),
      link && el('p', { class: 'hint' }, t('expertWrite', { link }).split(link)[0], el('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Basescan'), t('expertWrite', { link }).split(link)[1]),
      fields.map(([k, v]) => el('div', { class: 'field' }, el('span', {}, k), el('code', {}, v), copyButton(v))));
  });
  return el('details', { class: 'expert' }, el('summary', {}, t('expert')), el('p', { class: 'hint' }, t('expertIntro')), items);
}

function render() {
  t = makeT(ui.lang);
  document.documentElement.lang = ui.lang;
  document.title = t('title');
  const root = document.getElementById('app');
  const focusedId = document.activeElement?.id;
  root.replaceChildren(
    el('header', {},
      el('div', { class: 'lang' },
        el('button', { class: ui.lang === 'it' ? 'small on' : 'small', onclick: () => { ui.lang = 'it'; render(); } }, 'IT'),
        el('button', { class: ui.lang === 'en' ? 'small on' : 'small', onclick: () => { ui.lang = 'en'; render(); } }, 'EN')),
      el('h1', {}, t('title')),
      el('p', {}, t('intro')),
      el('p', { class: 'shield' }, t('neverKey'))),
    renderConnect(),
    renderState(),
    renderDest(),
    renderSend(),
    el('footer', {}, t('footer')),
  );
  if (focusedId) document.getElementById(focusedId)?.focus();
}

let listening = false;
function listen() {
  if (listening || !window.ethereum?.on) return;
  listening = true;
  window.ethereum.on('accountsChanged', (accs) => { ui.eoa = accs?.[0] ?? null; resetFrom(1); render(); if (ui.eoa && ui.chainOk) load(); });
  window.ethereum.on('chainChanged', async () => { await checkChain(); resetFrom(1); render(); if (ui.eoa && ui.chainOk) load(); });
}

function init() {
  listen();
  render();
  // Some wallets inject window.ethereum after the page script runs.
  if (!window.ethereum) {
    const late = () => { listen(); if (!ui.eoa) render(); };
    window.addEventListener('ethereum#initialized', late, { once: true });
    setTimeout(late, 1000);
  }
}

init();
export { SUPPORT };
