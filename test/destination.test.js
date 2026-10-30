import { describe, it, expect } from 'vitest';
import { validateDestination, ADDR, KERNEL_ACCOUNT_ID } from '../src/core.js';

const ctx = { eoa: '0x00000000000000000000000000000000000A11cE', smartAccount: '0x00000000000000000000000000000000005Afe0a' };
const DEST = '0x0000000000000000000000000000000000C0FFEE';

// probe(address) describes what lives at an address; these are the shapes the
// live probe returns for each kind of address (see chain.test.js).
const personal = async () => ({ code: '0x', nonce: 4, impl: null, accountId: null, keyOf: null });
const fresh = async () => ({ code: '0x', nonce: 0, impl: null, accountId: null, keyOf: null });
const unflatAccount = async () => ({ code: '0x363d3d37', nonce: 1, impl: ADDR.kernelImpl, accountId: KERNEL_ACCOUNT_ID, keyOf: null });
const otherContract = async () => ({ code: '0x6080604052', nonce: 1, impl: null, accountId: null, keyOf: null });
const delegated = async () => ({ code: '0xef0100612373d7003d694220f7800eeaf8e3924c0951d3', nonce: 3, impl: null, accountId: null, keyOf: null });
const keyOfUnflat = async () => ({ code: '0xef0100612373d7003d694220f7800eeaf8e3924c0951d3', nonce: 3, impl: null, accountId: null, keyOf: '0x00000000000000000000000000000000005AfE0E' });

describe('validateDestination: address format', () => {
  it('accepts a checksummed address and returns it unchanged', async () => {
    expect(await validateDestination(DEST, ctx, personal)).toMatchObject({ ok: true, address: DEST, errors: [] });
  });
  it('accepts an all-lowercase address but returns the checksummed form to confirm', async () => {
    expect(await validateDestination(DEST.toLowerCase(), ctx, personal)).toMatchObject({ ok: true, address: DEST });
  });
  it('rejects a mixed-case address with a wrong checksum (one letter mistyped)', async () => {
    expect(await validateDestination(DEST.replace('FFEE', 'FfEE'), ctx, personal)).toMatchObject({ ok: false, errors: ['checksum'] });
  });
  it('rejects empty, malformed and zero addresses', async () => {
    expect((await validateDestination('  ', ctx, personal)).errors).toEqual(['empty']);
    expect((await validateDestination('0x1234', ctx, personal)).errors).toEqual(['invalid']);
    expect((await validateDestination('0x0000000000000000000000000000000000000000', ctx, personal)).errors).toEqual(['zero']);
  });
  it('rejects the smart account being emptied', async () => {
    expect(await validateDestination(ctx.smartAccount, ctx, unflatAccount)).toMatchObject({ ok: false, errors: ['is-smart-account'] });
  });
  it('warns, without blocking, when the destination is the connected key itself', async () => {
    expect(await validateDestination(ctx.eoa, ctx, fresh)).toMatchObject({ ok: true, warnings: ['is-eoa'] });
  });
});

describe('validateDestination: what kind of address it is', () => {
  it('"Conto unflat" for a Kernel smart account with our implementation, no warning', async () => {
    expect(await validateDestination(DEST, ctx, unflatAccount)).toMatchObject({ ok: true, kind: 'unflat', warnings: [] });
  });
  it('"Wallet personale" for an address with a key that has been used', async () => {
    expect(await validateDestination(DEST, ctx, personal)).toMatchObject({ ok: true, kind: 'personal', warnings: [] });
  });
  it('"Wallet personale" also for a key with an EIP-7702 delegation', async () => {
    expect(await validateDestination(DEST, ctx, delegated)).toMatchObject({ ok: true, kind: 'personal', warnings: [] });
  });
  it('warns on an address never used: could be a new wallet or an unflat account not yet activated', async () => {
    expect(await validateDestination(DEST, ctx, fresh)).toMatchObject({ ok: true, kind: 'fresh', warnings: ['never-used'] });
  });
  it('warns on any other contract', async () => {
    expect(await validateDestination(DEST, ctx, otherContract)).toMatchObject({ ok: true, kind: 'contract', warnings: ['is-contract'] });
  });
  it('a Kernel with another implementation is "another contract", not an unflat account', async () => {
    const otherKernel = async () => ({ code: '0x363d3d37', nonce: 1, impl: '0x0000000000000000000000000000000000000abc', accountId: 'kernel.advanced.v0.3.3', keyOf: null });
    expect(await validateDestination(DEST, ctx, otherKernel)).toMatchObject({ kind: 'contract', warnings: ['is-contract'] });
  });
  it('the key of an unflat account is flagged and the account is suggested', async () => {
    expect(await validateDestination(DEST, ctx, keyOfUnflat)).toMatchObject({
      ok: true, kind: 'unflat-key', warnings: ['is-unflat-key'], suggestion: '0x00000000000000000000000000000000005AfE0E',
    });
  });
});
