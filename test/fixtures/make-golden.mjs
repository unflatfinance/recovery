// Writes golden.json: the calldata the page must produce, encoded here with
// viem alone (no code from src/), for made-up accounts and amounts.
// Run: node test/fixtures/make-golden.mjs
import { writeFileSync } from 'node:fs';
import { encodeFunctionData, encodeAbiParameters, encodePacked, parseAbi, getAddress } from 'viem';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OPENCOVER = '0x98380446865D66E23157378E260CBeC0033f991B';
const VAULTS = [
  '0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100',
  '0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9',
  '0x050cE30b927Da55177A4914EC73480238BAD56f0',
  '0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765',
];
// Fictitious: nobody holds a key for these.
const fake = (hex) => getAddress(`0x${hex.padStart(40, '0')}`);

const erc = parseAbi([
  'function redeem(uint256,address,address) returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function requestRedeem(uint256,address,address) returns (uint256)',
]);
const kernel = parseAbi(['function execute(bytes32,bytes) payable']);
const batch = (execs) => encodeFunctionData({
  abi: kernel, functionName: 'execute',
  args: [
    `0x01${'00'.repeat(31)}`,
    encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], [execs]),
  ],
});
const single = (target, data) => encodeFunctionData({
  abi: kernel, functionName: 'execute',
  args: [`0x${'00'.repeat(32)}`, encodePacked(['address', 'uint256', 'bytes'], [target, 0n, data])],
});
const transfer = (to, amount) => encodeFunctionData({ abi: erc, functionName: 'transfer', args: [to, BigInt(amount)] });

// A: deployed account with 4 vaults + free USDC, destination = its own key
const A = { sa: fake('5afe0a'), owner: fake('a11ce'), shares: ['1000000000000000000000', '750000000000000000000', '500000000000000000000', '250000000000000000000'], usdc: '100500000' };
A.data = batch([
  ...VAULTS.map((v, i) => ({ target: v, value: 0n, callData: encodeFunctionData({ abi: erc, functionName: 'redeem', args: [BigInt(A.shares[i]), A.owner, A.sa] }) })),
  { target: USDC, value: 0n, callData: transfer(A.owner, A.usdc) },
]);

// U: never-activated account holding USDC
const U = { sa: fake('5afe0b'), owner: fake('b0b00'), usdc: '25000000' };
U.singleData = single(USDC, transfer(U.owner, U.usdc));
U.batchData = batch([{ target: USDC, value: 0n, callData: transfer(U.owner, U.usdc) }]);

// O: OpenCover redeem request, controller and owner = the account
const O = { sa: fake('5afe0c'), shares: '90000000000000000000' };
O.requestData = single(OPENCOVER, encodeFunctionData({ abi: erc, functionName: 'requestRedeem', args: [BigInt(O.shares), O.sa, O.sa] }));

writeFileSync(new URL('./golden.json', import.meta.url), `${JSON.stringify({ source: 'test/fixtures/make-golden.mjs (fictitious accounts and amounts)', A, U, O }, null, 1)}\n`);
