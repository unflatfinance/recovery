import { describe, it, expect } from 'vitest';
import { assess, gasCheck, ADDR } from '../src/core.js';

const base = () => ({
  deployed: true, recognized: true,
  sa: { eth: 0n, tokens: { USDC: 0n, WETH: 0n, cbBTC: 0n }, vaults: ADDR.vaults.map((v) => ({ ...v, shares: 0n, assets: 0n })), oc: { shares: 0n, assets: 0n, pending: 0n, claimable: 0n } },
  eoaFunds: { eth: 0n, tokens: { USDC: 0n, WETH: 0n, cbBTC: 0n } },
});

describe('assess', () => {
  it('a deployed account whose owner is another key is not recognised, even with funds', () => {
    const s = base(); s.recognized = false; s.sa.tokens.USDC = 10n;
    expect(assess(s)).toBe('unrecognized');
  });
  it('a pending OpenCover request alone is not something to send now', () => {
    const s = base(); s.sa.oc.pending = 5n;
    expect(assess(s)).toBe('waiting');
  });
  it('money on the key itself is recoverable', () => {
    const s = base(); s.eoaFunds.tokens.USDC = 1n;
    expect(assess(s)).toBe('recoverable');
  });
  it('ETH alone on the key is not "funds to recover" (it pays the gas)', () => {
    const s = base(); s.eoaFunds.eth = 10n ** 15n;
    expect(assess(s)).toBe('nothing');
  });
});

describe('gasCheck', () => {
  it('says how much ETH is missing at today\'s Base gas price', () => {
    // 1.4M gas at 0.006 gwei = 8.4e-6 ETH; with the safety factors the need is above that
    const g = gasCheck({ gasUsed: 1_400_000n, gasPrice: 6_000_000n, eth: 0n });
    expect(g.enough).toBe(false);
    expect(g.need).toBeGreaterThan(8_400_000_000_000n);
    expect(g.recommended).toBe(200_000_000_000_000n); // floor: 0.0002 ETH
  });
  it('is enough with 0.0002 ETH on the key', () => {
    expect(gasCheck({ gasUsed: 1_400_000n, gasPrice: 6_000_000n, eth: 200_000_000_000_000n }).enough).toBe(true);
  });
});
