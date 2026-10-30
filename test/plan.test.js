import { describe, it, expect } from 'vitest';
import golden from './fixtures/golden.json' with { type: 'json' };
import { buildPlan, ADDR } from '../src/core.js';

// A state shaped as readState() returns it, for the fictitious accounts of
// fixtures/golden.json (calldata encoded independently by make-golden.mjs).
function stateA() {
  const { sa, owner, shares, usdc } = golden.A;
  return {
    eoa: owner,
    smartAccount: sa,
    deployed: true,
    recognized: true,
    factory: null,
    sa: {
      eth: 0n,
      tokens: { USDC: BigInt(usdc), WETH: 0n, cbBTC: 0n },
      vaults: ADDR.vaults.map((v, i) => ({ ...v, shares: i < 4 ? BigInt(shares[i]) : 0n, assets: 1n })),
      oc: { shares: 0n, assets: 0n, pending: 0n, claimable: 0n },
    },
    eoaFunds: { eth: 0n, tokens: { USDC: 0n, WETH: 0n, cbBTC: 0n } },
  };
}

describe('buildPlan', () => {
  it('recovers the 4 vaults and the free USDC of account A in one execute batch, byte for byte as simulated', () => {
    const plan = buildPlan(stateA(), golden.A.owner);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: 'recover', to: golden.A.sa, value: 0n, data: golden.A.data });
  });
});

function emptyState(overrides) {
  return {
    eoa: null, smartAccount: null, deployed: true, recognized: true, factory: null,
    sa: {
      eth: 0n,
      tokens: { USDC: 0n, WETH: 0n, cbBTC: 0n },
      vaults: ADDR.vaults.map((v) => ({ ...v, shares: 0n, assets: 0n })),
      oc: { shares: 0n, assets: 0n, pending: 0n, claimable: 0n },
    },
    eoaFunds: { eth: 0n, tokens: { USDC: 0n, WETH: 0n, cbBTC: 0n } },
    ...overrides,
  };
}

describe('buildPlan: smart account never activated', () => {
  it('deploys through the meta factory first, then recovers the USDC (never-activated account)', () => {
    const { sa, owner, usdc } = golden.U;
    const s = emptyState({ eoa: owner, smartAccount: sa, deployed: false,
      factory: { factory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5', factoryData: '0xc5265d5d00' } });
    s.sa.tokens.USDC = BigInt(usdc);
    const plan = buildPlan(s, owner);
    expect(plan.steps.map((x) => x.kind)).toEqual(['deploy', 'recover']);
    expect(plan.steps[0]).toMatchObject({ to: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5', data: '0xc5265d5d00' });
    expect(plan.steps[1]).toMatchObject({ to: sa, data: golden.U.batchData });
  });
});

describe('buildPlan: OpenCover', () => {
  it('only requests the redeem (first step), with controller and owner = smart account', () => {
    const s = emptyState({ eoa: '0x0000000000000000000000000000000000000001', smartAccount: golden.O.sa });
    s.sa.oc.shares = BigInt(golden.O.shares);
    const plan = buildPlan(s, '0x0000000000000000000000000000000000000002');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: 'opencover-request', to: golden.O.sa, data: golden.O.requestData });
  });

  it('does not request again while a redeem request is pending', () => {
    const s = emptyState({ smartAccount: golden.O.sa });
    s.sa.oc = { shares: 0n, assets: 0n, pending: 5n, claimable: 0n };
    expect(buildPlan(s, '0x0000000000000000000000000000000000000002').steps).toHaveLength(0);
  });
});

describe('buildPlan: fallback one transaction per vault', () => {
  it('splits vaults into single executes and keeps the tokens in one batch', () => {
    const plan = buildPlan(stateA(), golden.A.owner, { perVault: true });
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps.slice(0, 4).every((x) => x.data.slice(10, 74) === '00'.repeat(32))).toBe(true);
    expect(plan.steps[4].what.map((w) => w.symbol)).toEqual(['USDC']);
  });
});

describe('buildPlan: funds on the key itself', () => {
  it('sends tokens on the EOA with a plain transfer, never through the smart account', () => {
    const s = emptyState({ eoa: '0x0000000000000000000000000000000000C0FFEE', smartAccount: '0x00000000000000000000000000000000005AfE0d' });
    s.eoaFunds.tokens.USDC = 3_000_000n;
    const plan = buildPlan(s, '0x0000000000000000000000000000000000000002');
    expect(plan.steps).toEqual([expect.objectContaining({ kind: 'eoa-send', to: ADDR.usdc })]);
    // ERC-20 transfer(dest, 3 USDC)
    expect(plan.steps[0].data).toBe('0xa9059cbb000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000002dc6c0');
  });
});
