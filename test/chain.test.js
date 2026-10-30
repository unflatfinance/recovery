// Live checks against Base mainnet through the public RPC.
// Read-only: eth_call and eth_simulateV1, nothing is ever sent.
//
// The public part uses made-up keys: their money exists only inside the
// simulation (state overrides). The part on real unflat accounts runs only when
// RECOVERY_LIVE_FIXTURES points to a private JSON file that is never committed
// here (shape: test/fixtures/live.example.json).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatUnits, parseAbi, keccak256, encodeAbiParameters, toHex, getAddress } from 'viem';
import { makeClient, readState, assess, prepare, probeAddress, validateDestination, ADDR } from '../src/core.js';

const live = process.env.RECOVERY_LIVE_FIXTURES ? JSON.parse(readFileSync(process.env.RECOVERY_LIVE_FIXTURES, 'utf8')) : null;

const client = makeClient();
let blockNumber;
beforeAll(async () => {
  blockNumber = (await client.getBlockNumber()) - 2n;
});

const DEST = '0x000000000000000000000000000000000000bEEF';
const randomAddress = () => getAddress(`0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`);

// USDC on Base keeps balances in the mapping at storage slot 9.
const usdcBalanceOverride = (holder, amount) => ({
  address: ADDR.usdc,
  stateDiff: [{ slot: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 9n])), value: toHex(amount, { size: 32 }) }],
});

describe('made-up key whose account was never activated', () => {
  // A fresh random key each run: even "fictitious" vanity addresses receive real tokens.
  const FAKE_KEY = randomAddress();
  const amount = 25_000_000n; // 25 USDC, only inside the simulation

  async function stateWithUsdc() {
    const s = await readState(client, FAKE_KEY, { blockNumber });
    s.sa.tokens.USDC = amount;
    return s;
  }

  it('derives the account, sees it is not deployed, and recognises it as Kernel 0.3.1', async () => {
    const s = await readState(client, FAKE_KEY, { blockNumber });
    expect(s).toMatchObject({ deployed: false, recognized: true });
    expect(s.factory?.factory).toBe(ADDR.metaFactory);
  });

  it('deploys via the factory and then recovers exactly the USDC', async () => {
    const s = await stateWithUsdc();
    expect(assess(s)).toBe('recoverable');
    const r = await prepare(client, s, DEST, { blockNumber, stateOverrides: [usdcBalanceOverride(s.smartAccount, amount)] });
    expect(r.plan.steps.map((x) => x.kind)).toEqual(['deploy', 'recover']);
    expect(r.sim.ok).toBe(true);
    expect(r.sim.received.USDC).toBe(amount);
  });

  it('without the deploy the execute would "succeed" and move nothing: the simulation must refuse it', async () => {
    const s = await stateWithUsdc();
    const r = await prepare(client, s, DEST, { blockNumber, stateOverrides: [usdcBalanceOverride(s.smartAccount, amount)], dropDeployForTest: true });
    expect(r.sim.ok).toBe(false);
    expect(r.sim.reason).toBe('nothing-moved');
    expect(r.canSend).toBe(false);
  });

  it('blocks the send when the key has no ETH for gas, and says how much is needed', async () => {
    const s = await stateWithUsdc();
    const r = await prepare(client, s, DEST, { blockNumber, stateOverrides: [usdcBalanceOverride(s.smartAccount, amount)] });
    expect(s.eoaFunds.eth).toBe(0n);
    expect(r.gas.enough).toBe(false);
    expect(r.gas.recommended).toBeGreaterThanOrEqual(r.gas.need);
    expect(r.canSend).toBe(false);
  });
});

describe('nothing to recover', () => {
  it('an empty key has nothing to recover and gets no transaction', async () => {
    const s = await readState(client, randomAddress(), { blockNumber });
    expect(s.deployed).toBe(false);
    expect(assess(s)).toBe('nothing');
  });
});

describe('what kind of destination (live probe, public addresses)', () => {
  const ctx = { eoa: randomAddress(), smartAccount: randomAddress() };
  const probe = (a) => probeAddress(client, a);

  it('a never-used address is flagged', async () => {
    expect(await validateDestination(randomAddress(), ctx, probe)).toMatchObject({ kind: 'fresh', warnings: ['never-used'] });
  });

  it('USDC is "another contract"', async () => {
    expect(await validateDestination(ADDR.usdc, ctx, probe)).toMatchObject({ kind: 'contract', warnings: ['is-contract'] });
  });

  it('the Kernel implementation itself is a contract, not an unflat account', async () => {
    expect(await validateDestination(ADDR.kernelImpl, ctx, probe)).toMatchObject({ kind: 'contract', warnings: ['is-contract'] });
  });
});

describe.skipIf(!live)('real unflat accounts (private fixtures)', () => {
  it('account A: derives the smart account from the key and recognises it', async () => {
    const s = await readState(client, live.A.owner, { blockNumber });
    expect(s.smartAccount).toBe(live.A.sa);
    expect(s).toMatchObject({ deployed: true, recognized: true });
    expect(assess(s)).toBe('recoverable');
    expect(s.sa.vaults.slice(0, 4).map((v) => v.shares.toString())).toEqual(live.A.shares);
  });

  it('account A: one transaction moves everything the vaults say the shares are worth', async () => {
    const s = await readState(client, live.A.owner, { blockNumber });
    const r = await prepare(client, s, DEST, { blockNumber });
    expect(r.mode).toBe('batch');
    expect(r.plan.steps.map((x) => x.kind)).toEqual(['recover']);
    expect(r.sim.ok).toBe(true);
    // the shares have not moved since the fixtures were written, so yield only adds
    expect(r.sim.received.USDC).toBeGreaterThanOrEqual(BigInt(live.expectedUsdcA));
    const expected = s.sa.vaults.reduce((t, v) => t + v.assets, 0n) + s.sa.tokens.USDC;
    expect(r.sim.received.USDC - expected).toBeGreaterThanOrEqual(-5n);
    // the simulated block is the next one: a few units of interest accrue on top
    expect(r.sim.received.USDC - expected).toBeLessThanOrEqual(1000n);
    expect(r.sim.saLeft.vaultShares).toBe(0n);
    console.log('A: arrive', formatUnits(r.sim.received.USDC, 6), 'USDC, gas', r.sim.gasUsed.toString());
  });

  it('account A: a vault without liquidity falls back to one transaction per vault and is left out', async () => {
    const s = await readState(client, live.A.owner, { blockNumber });
    const broken = ADDR.vaults[1].address; // made to revert on every call
    const r = await prepare(client, s, DEST, { blockNumber, stateOverrides: [{ address: broken, code: '0x60006000fd' }] });
    expect(r.mode).toBe('per-vault');
    expect(r.skipped.map((v) => v.address)).toEqual([broken]);
    expect(r.plan.steps.every((x) => x.kind === 'recover')).toBe(true);
    expect(r.plan.steps).toHaveLength(4); // 3 working vaults + the USDC batch
    expect(r.sim.ok).toBe(true);
    const expected = s.sa.vaults.filter((v) => v.address !== broken).reduce((t, v) => t + v.assets, 0n) + s.sa.tokens.USDC;
    expect(r.sim.received.USDC - expected).toBeGreaterThanOrEqual(-5n);
    expect(r.sim.received.USDC - expected).toBeLessThanOrEqual(1000n);
  });

  it('never-activated account U: deploy + recover of its real USDC', async () => {
    const s = await readState(client, live.U.owner, { blockNumber });
    expect(s).toMatchObject({ smartAccount: live.U.sa, deployed: false, recognized: true });
    const r = await prepare(client, s, DEST, { blockNumber });
    expect(r.plan.steps.map((x) => x.kind)).toEqual(['deploy', 'recover']);
    expect(r.sim.ok).toBe(true);
    expect(r.sim.received.USDC).toBe(BigInt(live.expectedUsdcU));
  });

  it('OpenCover: after the simulated request the redeem is pending', async () => {
    const owner = await client.readContract({
      address: ADDR.ecdsaValidator,
      abi: parseAbi(['function ecdsaValidatorStorage(address) view returns (address)']),
      functionName: 'ecdsaValidatorStorage',
      args: [live.O.sa],
    });
    const s = await readState(client, owner, { blockNumber });
    expect(s.smartAccount).toBe(live.O.sa);
    expect(s.sa.oc.shares).toBe(BigInt(live.O.shares));
    const r = await prepare(client, s, DEST, { blockNumber });
    expect(r.plan.steps.map((x) => x.kind)).toEqual(['opencover-request']);
    expect(r.sim.ok).toBe(true);
    expect(r.sim.ocPendingAfter).toBe(BigInt(live.O.shares));
  });

  it('destination kinds: unflat account, key of an unflat account (with suggestion), personal wallet', async () => {
    const ctx = { eoa: live.A.owner, smartAccount: live.A.sa };
    const probe = (a) => probeAddress(client, a);
    expect(await validateDestination(live.unflatAccount, ctx, probe)).toMatchObject({ kind: 'unflat', warnings: [] });
    expect(await validateDestination(live.unflatKey, ctx, probe)).toMatchObject({
      kind: 'unflat-key', warnings: ['is-unflat-key'], suggestion: live.unflatAccount,
    });
    const blk = await client.getBlock({ blockNumber: BigInt(live.personalBlock), includeTransactions: true });
    let found = null;
    for (const tx of blk.transactions.slice(1, 40)) {
      const r = await validateDestination(tx.from, ctx, probe);
      if (r.kind === 'personal') { found = r; break; }
    }
    expect(found).toMatchObject({ kind: 'personal', warnings: [] });
  });
});
