// Recovery core: reads an unflat user's on-chain state on Base and builds the
// transactions the user's own wallet (the exported key) sends to move every
// fund out. No key ever enters this code: the only signer is the user's wallet.
import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import { toAccount } from 'viem/accounts';
import { entryPoint07Address } from 'viem/account-abstraction';
import { toKernelSmartAccount } from 'permissionless/accounts';

export const ADDR = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
  kernelImpl: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
  metaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
  openCover: '0x98380446865D66E23157378E260CBeC0033f991B',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  // The vaults the unflat app uses: 4 active Vault V2 + Re7 legacy.
  vaults: [
    { symbol: 'bbqUSDC', name: 'Steakhouse High Yield', address: '0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100' },
    { symbol: 'steakUSDC', name: 'Steakhouse Prime', address: '0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9' },
    { symbol: 'gtusdcp', name: 'Gauntlet USDC Prime', address: '0x050cE30b927Da55177A4914EC73480238BAD56f0' },
    { symbol: 'gtusdcf', name: 'Gauntlet USDC Frontier', address: '0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765' },
    { symbol: 'Re7USDC', name: 'Re7 USDC (legacy)', address: '0x618495ccC4e751178C4914b1E939C0fe0FB07b9b' },
  ],
  // Order matters: it is the order of the transfers inside the batch.
  tokens: [
    { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { symbol: 'WETH', decimals: 18, address: '0x4200000000000000000000000000000000000006' },
    { symbol: 'cbBTC', decimals: 8, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  ],
};

export const KERNEL_ACCOUNT_ID = 'kernel.advanced.v0.3.1';
const MODE_SINGLE = `0x${'00'.repeat(32)}`;
const MODE_BATCH = `0x01${'00'.repeat(31)}`;

export const abi = {
  kernel: parseAbi([
    'function execute(bytes32 mode, bytes executionCalldata) payable',
    'function accountId() view returns (string)',
  ]),
  validator: parseAbi(['function ecdsaValidatorStorage(address) view returns (address)']),
  erc20: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ]),
  vault: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function convertToAssets(uint256) view returns (uint256)',
    'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  ]),
  openCover: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function convertToAssets(uint256) view returns (uint256)',
    'function requestRedeem(uint256 shares, address controller, address owner) returns (uint256)',
    'function lastRedeemRequestId(address) view returns (uint256)',
    'function pendingRedeemRequest(uint256,address) view returns (uint256)',
    'function claimableRedeemRequest(uint256,address) view returns (uint256)',
    'function pendingRedeemShares(address) view returns (uint256)',
  ]),
  multicall3: parseAbi(['function getEthBalance(address) view returns (uint256)']),
};

const executionTuple = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
];

export function encodeExecuteBatch(calls) {
  return encodeFunctionData({
    abi: abi.kernel,
    functionName: 'execute',
    args: [MODE_BATCH, encodeAbiParameters(executionTuple, [calls])],
  });
}

export function encodeExecuteSingle(call) {
  return encodeFunctionData({
    abi: abi.kernel,
    functionName: 'execute',
    args: [MODE_SINGLE, encodePacked(['address', 'uint256', 'bytes'], [call.target, call.value, call.callData])],
  });
}

function redeemCall(vault, shares, dest, smartAccount) {
  return {
    target: vault.address,
    value: 0n,
    callData: encodeFunctionData({ abi: abi.vault, functionName: 'redeem', args: [shares, dest, smartAccount] }),
    what: { type: 'vault', symbol: vault.symbol, name: vault.name, shares, assets: vault.assets },
  };
}

function transferCall(token, amount, dest) {
  return {
    target: token.address,
    value: 0n,
    callData: encodeFunctionData({ abi: abi.erc20, functionName: 'transfer', args: [dest, amount] }),
    what: { type: 'token', symbol: token.symbol, amount },
  };
}

/** Calls the smart account runs to empty itself into `dest` (vaults, tokens, ETH). */
export function smartAccountCalls(state, dest) {
  const calls = [];
  for (const v of state.sa.vaults) {
    if (v.shares > 0n) calls.push(redeemCall(v, v.shares, dest, state.smartAccount));
  }
  for (const t of ADDR.tokens) {
    const amount = state.sa.tokens[t.symbol] ?? 0n;
    if (amount > 0n) calls.push(transferCall(t, amount, dest));
  }
  if (state.sa.eth > 0n) {
    calls.push({ target: dest, value: state.sa.eth, callData: '0x', what: { type: 'eth', amount: state.sa.eth } });
  }
  return calls;
}

const strip = ({ what, ...call }) => call;

/**
 * The ordered transactions the user's wallet sends. `perVault` splits the
 * smart-account batch into one transaction per vault plus one for the tokens:
 * the fallback when one vault cannot pay out right now.
 */
export function buildPlan(state, dest, { perVault = false, skipVaults = [] } = {}) {
  const steps = [];
  const calls = smartAccountCalls(state, dest).filter(
    (c) => !(c.what.type === 'vault' && skipVaults.includes(c.target)),
  );
  const ocShares = state.sa.oc.shares;
  const ocRequest =
    ocShares > 0n && state.sa.oc.pending === 0n && state.sa.oc.claimable === 0n
      ? {
          target: ADDR.openCover,
          value: 0n,
          callData: encodeFunctionData({
            abi: abi.openCover,
            functionName: 'requestRedeem',
            args: [ocShares, state.smartAccount, state.smartAccount],
          }),
          what: { type: 'opencover', shares: ocShares, assets: state.sa.oc.assets },
        }
      : null;

  if (!state.deployed && (calls.length > 0 || ocRequest)) {
    steps.push({ kind: 'deploy', to: state.factory.factory, data: state.factory.factoryData, value: 0n, what: [] });
  }

  if (calls.length > 0) {
    if (!perVault) {
      steps.push({ kind: 'recover', to: state.smartAccount, value: 0n, data: encodeExecuteBatch(calls.map(strip)), what: calls.map((c) => c.what) });
    } else {
      const vaultCalls = calls.filter((c) => c.what.type === 'vault');
      const rest = calls.filter((c) => c.what.type !== 'vault');
      for (const c of vaultCalls) {
        steps.push({ kind: 'recover', to: state.smartAccount, value: 0n, data: encodeExecuteSingle(strip(c)), what: [c.what] });
      }
      if (rest.length > 0) {
        steps.push({ kind: 'recover', to: state.smartAccount, value: 0n, data: encodeExecuteBatch(rest.map(strip)), what: rest.map((c) => c.what) });
      }
    }
  }

  if (ocRequest) {
    steps.push({ kind: 'opencover-request', to: state.smartAccount, value: 0n, data: encodeExecuteSingle(strip(ocRequest)), what: [ocRequest.what] });
  }

  // Money already on the key itself: plain token transfers from the wallet.
  for (const t of ADDR.tokens) {
    const amount = state.eoaFunds.tokens[t.symbol] ?? 0n;
    if (amount > 0n) {
      const c = transferCall(t, amount, dest);
      steps.push({ kind: 'eoa-send', to: t.address, value: 0n, data: c.callData, what: [c.what] });
    }
  }
  return { dest, steps };
}

/**
 * Checks the address the user typed and says what lives there. Errors block;
 * warnings need the user's explicit confirmation. `probe(address)` describes
 * the address (see probeAddress) and is injected so tests can use fixtures.
 *
 * kind: 'unflat' (Kernel v0.3.1 smart account with our implementation),
 *       'unflat-key' (the key that owns an unflat account, not the account),
 *       'personal' (a used key, also with an EIP-7702 delegation),
 *       'fresh' (no code and never used), 'contract' (anything else).
 */
export async function validateDestination(input, ctx, probe) {
  const raw = (input ?? '').trim();
  const fail = (code) => ({ ok: false, address: null, kind: null, errors: [code], warnings: [] });
  if (raw === '') return fail('empty');
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return fail('invalid');
  const mixedCase = raw.slice(2) !== raw.slice(2).toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase();
  if (mixedCase && !isAddress(raw, { strict: true })) return fail('checksum');
  const address = getAddress(raw.toLowerCase());
  if (address === zeroAddress) return fail('zero');
  if (ctx.smartAccount && address === getAddress(ctx.smartAccount)) return fail('is-smart-account');

  const info = await probe(address);
  const { kind, suggestion } = classify(info);
  if (ctx.eoa && address === getAddress(ctx.eoa)) {
    return { ok: true, address, kind, errors: [], warnings: ['is-eoa'] };
  }
  const warnings = { fresh: ['never-used'], contract: ['is-contract'], 'unflat-key': ['is-unflat-key'] }[kind] ?? [];
  return { ok: true, address, kind, errors: [], warnings, ...(suggestion ? { suggestion } : {}) };
}

function classify({ code, nonce, impl, accountId, keyOf }) {
  const c = (code ?? '0x').toLowerCase();
  const isKey = c === '0x' || c.startsWith('0xef0100'); // 0xef0100…: EIP-7702 delegation, still a key
  if (isKey) {
    if (keyOf) return { kind: 'unflat-key', suggestion: getAddress(keyOf) };
    return { kind: nonce > 0 || c !== '0x' ? 'personal' : 'fresh' };
  }
  if (impl && getAddress(impl) === getAddress(ADDR.kernelImpl) && accountId === KERNEL_ACCOUNT_ID) return { kind: 'unflat' };
  return { kind: 'contract' };
}

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** What lives at `address` on Base, for validateDestination. Read-only. */
export async function probeAddress(client, address) {
  const [code, nonce] = await Promise.all([
    client.getCode({ address }).then((x) => x ?? '0x'),
    client.getTransactionCount({ address }),
  ]);
  const c = code.toLowerCase();
  if (c === '0x' || c.startsWith('0xef0100')) {
    // Is this the key of an unflat account? Its Kernel exists and names it as owner.
    const account = await deriveSmartAccount(client, address);
    const sa = getAddress(account.address);
    const saCode = (await client.getCode({ address: sa })) ?? '0x';
    let keyOf = null;
    if (saCode !== '0x') {
      const owner = await client
        .readContract({ address: ADDR.ecdsaValidator, abi: abi.validator, functionName: 'ecdsaValidatorStorage', args: [sa] })
        .catch(() => null);
      if (owner && getAddress(owner) === getAddress(address)) keyOf = sa;
    }
    return { code, nonce, impl: null, accountId: null, keyOf };
  }
  const slot = await client.getStorageAt({ address, slot: IMPL_SLOT });
  const impl = slot && BigInt(slot) !== 0n ? getAddress(`0x${slot.slice(-40)}`) : null;
  const accountId = await client.readContract({ address, abi: abi.kernel, functionName: 'accountId' }).catch(() => null);
  return { code, nonce, impl, accountId, keyOf: null };
}

export const RPC_URL = 'https://mainnet.base.org';

export function makeClient(url = RPC_URL) {
  return createPublicClient({
    chain: base,
    transport: http(url, { retryCount: 6, retryDelay: 1200 }),
    batch: { multicall: true },
  });
}

const noSign = async () => {
  throw new Error('this page never signs anything');
};

/** Kernel v0.3.1 address of an unflat user: the same derivation Privy uses (index 0). */
export async function deriveSmartAccount(client, eoa) {
  const owner = toAccount({ address: getAddress(eoa), signMessage: noSign, signTransaction: noSign, signTypedData: noSign });
  const account = await toKernelSmartAccount({
    client,
    owners: [owner],
    version: '0.3.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    index: 0n,
  });
  return account;
}

/** Everything the page shows, read at one block. */
export async function readState(client, eoaInput, { blockNumber } = {}) {
  const eoa = getAddress(eoaInput);
  const at = blockNumber ? { blockNumber } : {};
  const account = await deriveSmartAccount(client, eoa);
  const smartAccount = getAddress(account.address);
  const code = (await client.getCode({ address: smartAccount, ...at })) ?? '0x';
  const deployed = code !== '0x';

  let recognized = true;
  let factory = null;
  if (deployed) {
    const [accountId, owner] = await Promise.all([
      client.readContract({ address: smartAccount, abi: abi.kernel, functionName: 'accountId', ...at }).catch(() => null),
      client.readContract({ address: ADDR.ecdsaValidator, abi: abi.validator, functionName: 'ecdsaValidatorStorage', args: [smartAccount], ...at }),
    ]);
    recognized = accountId === KERNEL_ACCOUNT_ID && getAddress(owner) === eoa;
  } else {
    factory = await account.getFactoryArgs();
  }

  const bal = (token, who) => ({ address: token, abi: abi.erc20, functionName: 'balanceOf', args: [who] });
  const first = await client.multicall({
    allowFailure: false,
    ...at,
    contracts: [
      ...ADDR.tokens.map((t) => bal(t.address, smartAccount)),
      ...ADDR.tokens.map((t) => bal(t.address, eoa)),
      ...ADDR.vaults.map((v) => bal(v.address, smartAccount)),
      bal(ADDR.openCover, smartAccount),
      { address: ADDR.openCover, abi: abi.openCover, functionName: 'lastRedeemRequestId', args: [smartAccount] },
    ],
  });
  const n = ADDR.tokens.length;
  const saTok = first.slice(0, n);
  const eoaTok = first.slice(n, 2 * n);
  const shares = first.slice(2 * n, 2 * n + ADDR.vaults.length);
  const [ocShares, ocLastId] = first.slice(2 * n + ADDR.vaults.length);

  const second = await client.multicall({
    allowFailure: false,
    ...at,
    contracts: [
      ...ADDR.vaults.map((v, i) => ({ address: v.address, abi: abi.vault, functionName: 'convertToAssets', args: [shares[i]] })),
      { address: ADDR.openCover, abi: abi.openCover, functionName: 'convertToAssets', args: [ocShares] },
      { address: ADDR.openCover, abi: abi.openCover, functionName: 'pendingRedeemRequest', args: [ocLastId, smartAccount] },
      { address: ADDR.openCover, abi: abi.openCover, functionName: 'claimableRedeemRequest', args: [ocLastId, smartAccount] },
    ],
  });
  const assets = second.slice(0, ADDR.vaults.length);
  const [ocBbq, ocPending, ocClaimable] = second.slice(ADDR.vaults.length);
  // OpenCover wraps bbqUSDC (vault 0): its USDC value goes through that vault.
  const ocAssets = ocBbq > 0n
    ? await client.readContract({ address: ADDR.vaults[0].address, abi: abi.vault, functionName: 'convertToAssets', args: [ocBbq], ...at })
    : 0n;

  const [saEth, eoaEth] = await Promise.all([
    client.getBalance({ address: smartAccount, ...at }),
    client.getBalance({ address: eoa, ...at }),
  ]);

  const tokenMap = (arr) => Object.fromEntries(ADDR.tokens.map((t, i) => [t.symbol, arr[i]]));
  return {
    eoa,
    smartAccount,
    deployed,
    recognized,
    factory,
    sa: {
      eth: saEth,
      tokens: tokenMap(saTok),
      vaults: ADDR.vaults.map((v, i) => ({ ...v, shares: shares[i], assets: assets[i] })),
      oc: { shares: ocShares, assets: ocAssets, requestId: ocLastId, pending: ocPending, claimable: ocClaimable },
    },
    eoaFunds: { eth: eoaEth, tokens: tokenMap(eoaTok) },
  };
}

/** 'recoverable' | 'waiting' (OpenCover request in progress) | 'nothing' | 'unrecognized' */
export function assess(state) {
  if (state.deployed && !state.recognized) return 'unrecognized';
  const sa = state.sa;
  const onSa =
    sa.eth > 0n ||
    sa.oc.shares > 0n ||
    sa.vaults.some((v) => v.shares > 0n) ||
    Object.values(sa.tokens).some((x) => x > 0n);
  const onKey = Object.values(state.eoaFunds.tokens).some((x) => x > 0n);
  if (onSa || onKey) return 'recoverable';
  if (sa.oc.pending > 0n || sa.oc.claimable > 0n) return 'waiting';
  return 'nothing';
}

const MIN_RECOMMENDED_WEI = 200_000_000_000_000n; // 0.0002 ETH

/**
 * ETH the key needs for the gas. `need` covers the simulated gas with a 30%
 * margin and a doubled gas price (Base fees move); `recommended` is what we
 * tell the user to send.
 */
export function gasCheck({ gasUsed, gasPrice, eth }) {
  const need = ((gasUsed * 13n) / 10n) * gasPrice * 2n;
  const recommended = need * 5n > MIN_RECOMMENDED_WEI ? need * 5n : MIN_RECOMMENDED_WEI;
  return { need, recommended, enough: eth >= need };
}

/**
 * Runs the whole plan in one simulated block, from the user's key, and
 * measures what reaches the destination. Nothing is sent.
 */
export async function simulatePlan(client, state, plan, { blockNumber, stateOverrides } = {}) {
  const from = state.eoa;
  const dest = plan.dest;
  const read = (to, data) => ({ account: from, to, data });
  const balOf = (token, who) => read(token, encodeFunctionData({ abi: abi.erc20, functionName: 'balanceOf', args: [who] }));
  const ethOf = (who) => read(ADDR.multicall3, encodeFunctionData({ abi: abi.multicall3, functionName: 'getEthBalance', args: [who] }));
  const destReads = () => [...ADDR.tokens.map((t) => balOf(t.address, dest)), ethOf(dest)];
  const includedVaults = [...new Set(plan.steps.flatMap((s) => s.what.filter((w) => w.type === 'vault').map((w) => w.symbol)))]
    .map((sym) => ADDR.vaults.find((v) => v.symbol === sym));
  const after = [
    ...destReads(),
    ...includedVaults.map((v) => balOf(v.address, state.smartAccount)),
    read(ADDR.openCover, encodeFunctionData({ abi: abi.openCover, functionName: 'pendingRedeemShares', args: [state.smartAccount] })),
  ];
  const txs = plan.steps.map((s) => ({ account: from, to: s.to, data: s.data, value: s.value }));
  const block = { calls: [...destReads(), ...txs, ...after] };
  if (stateOverrides) block.stateOverrides = stateOverrides;

  const [res] = await client.simulateBlocks({ blocks: [block], validation: false, ...(blockNumber ? { blockNumber } : {}) });
  const num = (c) => (c.status === 'success' && c.data && c.data !== '0x' ? BigInt(c.data.slice(0, 66)) : 0n);
  const k = ADDR.tokens.length + 1;
  const before = res.calls.slice(0, k).map(num);
  const stepRes = res.calls.slice(k, k + txs.length);
  const tail = res.calls.slice(k + txs.length).map(num);
  const afterDest = tail.slice(0, k);
  const vaultLeft = tail.slice(k, k + includedVaults.length).reduce((a, b) => a + b, 0n);
  const ocPendingAfter = tail[k + includedVaults.length];

  const received = Object.fromEntries(ADDR.tokens.map((t, i) => [t.symbol, afterDest[i] - before[i]]));
  received.ETH = afterDest[k - 1] - before[k - 1];
  const steps = stepRes.map((c) => ({ ok: c.status === 'success', gasUsed: c.gasUsed, error: c.error?.shortMessage ?? c.error?.message ?? null }));
  const gasUsed = steps.reduce((a, s) => a + s.gasUsed, 0n);

  const allOk = steps.every((s) => s.ok);
  const moved = Object.values(received).some((x) => x > 0n) || ocPendingAfter > (state.sa.oc.pending ?? 0n);
  const reason = !allOk ? 'step-failed' : !moved ? 'nothing-moved' : vaultLeft > 0n ? 'vault-left' : null;
  return { ok: reason === null, reason, steps, received, gasUsed, saLeft: { vaultShares: vaultLeft }, ocPendingAfter };
}

/**
 * Builds and verifies the transactions for `dest`. One batch first; if it
 * fails, one transaction per vault, leaving out the vaults that cannot pay now.
 */
export async function prepare(client, state, dest, opts = {}) {
  const { blockNumber, stateOverrides, dropDeployForTest } = opts;
  const simOpts = { blockNumber, stateOverrides };
  const build = (o) => {
    const plan = buildPlan(state, dest, o);
    if (dropDeployForTest) plan.steps = plan.steps.filter((s) => s.kind !== 'deploy');
    return plan;
  };

  let mode = 'batch';
  let skipped = [];
  let plan = build();
  let sim = await simulatePlan(client, state, plan, simOpts);

  const hasVaults = plan.steps.some((s) => s.what.some((w) => w.type === 'vault'));
  if (!sim.ok && sim.reason === 'step-failed' && hasVaults) {
    mode = 'per-vault';
    const split = build({ perVault: true });
    const trial = await simulatePlan(client, state, split, simOpts);
    skipped = split.steps
      .map((s, i) => ({ s, r: trial.steps[i] }))
      .filter(({ s, r }) => !r.ok && s.what.length === 1 && s.what[0].type === 'vault')
      .map(({ s }) => ADDR.vaults.find((v) => v.symbol === s.what[0].symbol));
    plan = build({ perVault: true, skipVaults: skipped.map((v) => v.address) });
    sim = await simulatePlan(client, state, plan, simOpts);
  }

  const gasPrice = await client.getGasPrice();
  const gas = gasCheck({ gasUsed: sim.gasUsed, gasPrice, eth: state.eoaFunds.eth });
  return { plan, sim, mode, skipped, gas, gasPrice, canSend: sim.ok && gas.enough && plan.steps.length > 0 };
}
