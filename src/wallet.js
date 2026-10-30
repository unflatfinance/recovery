// The only door to the user's wallet. It can ask for the account, the network
// and to send a transaction the user approves in the wallet. It cannot ask the
// wallet to sign messages or reveal anything: those methods are refused here.
export const ALLOWED_METHODS = Object.freeze([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_sendTransaction',
]);

export const BASE_CHAIN_ID_HEX = '0x2105';

export function walletRequest(provider, method, params) {
  if (!ALLOWED_METHODS.includes(method)) {
    return Promise.reject(new Error(`method not allowed on this page: ${method}`));
  }
  return provider.request(params === undefined ? { method } : { method, params });
}

export async function switchToBase(provider) {
  try {
    await walletRequest(provider, 'wallet_switchEthereumChain', [{ chainId: BASE_CHAIN_ID_HEX }]);
  } catch (e) {
    // 4902: the wallet does not know Base yet
    if (e?.code !== 4902) throw e;
    await walletRequest(provider, 'wallet_addEthereumChain', [{
      chainId: BASE_CHAIN_ID_HEX,
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    }]);
  }
}

const hex = (n) => `0x${n.toString(16)}`;

export function sendStep(provider, from, step, gas) {
  return walletRequest(provider, 'eth_sendTransaction', [{
    from,
    to: step.to,
    data: step.data,
    value: hex(step.value ?? 0n),
    ...(gas ? { gas: hex(gas) } : {}),
  }]);
}
