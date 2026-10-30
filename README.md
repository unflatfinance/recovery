# unflat recovery

**Recover your unflat savings without the unflat app.** One static page that runs entirely in your browser: you connect your own wallet (MetaMask or similar) holding the recovery key you exported from unflat, and the page builds the transactions that move everything to an address you choose.

**Recupera i tuoi risparmi unflat senza l'app.** Una pagina statica che gira solo nel tuo browser: colleghi il tuo wallet (MetaMask o simile) con la chiave di recupero esportata da unflat, e la pagina prepara le transazioni che portano tutto all'indirizzo che scegli.

- Page / pagina: https://unflatfinance.github.io/recovery/
- Support / assistenza: info@unflat.eu

> This page will never ask for your recovery key or secret words. There is no field for them anywhere. If a site asks for them, it is a scam.
>
> Questa pagina non ti chiederà mai la chiave di recupero o parole segrete: non esiste un campo per inserirle. Se un sito te le chiede, è una truffa.

## Why it exists

unflat keeps each user's savings in their own smart account on Base (an ERC-4337 [Kernel v0.3.1](https://github.com/zerodevapp/kernel/tree/v3.1) account). The key you export from the app is the key that **owns** that account, not the account itself, so a normal wallet that imports it shows a zero balance.

The owner key can operate the account directly: Kernel's `execute` accepts calls from the owner (`onlyEntryPointOrSelfOrRoot` → `ECDSAValidator.preCheck`: `msgSender == owner`). This page builds those calls. No unflat server, bundler or paymaster is involved.

## What it does

1. **Connect.** Asks your wallet for the account and switches it to Base. The page can ask the wallet only for the account, the network and to send a transaction you approve (`src/wallet.js`, `ALLOWED_METHODS`). It never asks for a signature.
2. **Read.** Derives your unflat account from the connected key, with the same derivation as Privy: `toKernelSmartAccount`, Kernel 0.3.1, EntryPoint 0.7, index 0. It then reads, at one block:
   - free USDC and other known tokens (WETH, cbBTC);
   - shares in the Morpho vaults: 4 Vault V2 plus Re7 legacy. Amounts come from `balanceOf`, never `maxRedeem`, which is 0 on Vault V2;
   - insured savings (OpenCover);
   - money already on the key itself;
   - the key's ETH for gas.
3. **Destination.** You type where the money goes. The page checks the checksum and refuses your own unflat account. It tells you what the address is:

   | Label | Meaning |
   |---|---|
   | **unflat account ✓** | Kernel v0.3.1 with unflat's implementation `0xBAC8…4b4D` |
   | **Personal wallet** | A used key, also with an EIP-7702 delegation |
   | **Key of an unflat account** | The key, not the account. The page warns and offers the account address instead |
   | **Address never used** | Warning: a new wallet, an exchange deposit address, or an unflat account not yet activated |
   | **Contract** | Warning: some other kind of contract |

   You must confirm the address explicitly.
4. **Send.** As few transactions as possible, in order, from your key:

   | Situation | Transactions |
   |---|---|
   | Account never activated (money arrived, no transaction ever) | deploy through the Kernel meta factory (`deployWithFactory`), then the recovery |
   | Normal case | **one** `execute` batch: redeem every vault to the destination + transfer every token and ETH |
   | A vault cannot pay now | one transaction per vault; the blocked one is left out and named |
   | Insured savings (OpenCover) | only the first step, the redeem request, with an explanation. Settlement is asynchronous (anyone can settle after 24 h) and the last two steps are not in this page yet |
   | Money on the key itself | a plain token transfer |

   **Before showing the send button the page always simulates** the whole plan (`eth_simulateV1`) from your key, and shows what will arrive ("5.00 USDC will arrive at 0x…"). If any step fails, or the plan moves no money, sending is blocked. If your key has no ETH for gas, the page says how much to send on Base. After each transaction it reads the chain again and simulates the next step.
5. **Expert users.** A manual section shows `to` + `data` and the decoded `execute(mode, executionCalldata)` fields for Basescan "Write as Proxy".

## Security model

- A single self-contained `index.html`. Script and style are inline and pinned by sha256 in the Content-Security-Policy: `default-src 'none'`.
- The page loads nothing from outside and talks to one host only: the public Base RPC `https://mainnet.base.org`.
- No backend, no API keys, no analytics, no cookies.
- No input for keys or seeds: `test/security.test.js` fails if one appears. The only text field is the destination.
- The wallet is reached only through `walletRequest`. Signing methods (`personal_sign`, `eth_sign`, `eth_signTypedData*`, …) are refused.
- DOM is built with `textContent` only. No address or error text can inject markup.

## Verify the published page

The build is reproducible: same source, same lockfile → the same bytes.

```sh
git clone https://github.com/unflatfinance/recovery && cd recovery
nvm use            # Node 20
npm ci
npm run verify     # rebuilds and compares sha256 with https://unflatfinance.github.io/recovery/
```

`IDENTICAL` means the page you open is exactly this source. Every CI run also prints the page's sha256 in the job summary.

## Run it locally

```sh
npm ci
npm run serve      # http://localhost:8787
```

Your wallet extension works on `localhost`. The local page is the same file as the published one.

## Tests

```sh
npm test               # everything
npm run test:offline   # no network: calldata, destination checks, security
npm run test:chain     # read-only against Base mainnet: eth_call / eth_simulateV1, nothing is sent
```

- **Calldata:** byte for byte against an independent encoding (`test/fixtures/make-golden.mjs`, viem only, no code from `src/`).
- **Live simulations on Base** with random, made-up keys. Their money exists only inside the simulation, through state overrides:
  - a never-activated account holding USDC (deploy + recover);
  - the same plan without the deploy, which must be refused;
  - a key without ETH for gas;
  - an empty key;
  - destination kinds of public contracts and never-used addresses.
- **UI end to end** with a fake wallet that records what the page asks, on a made-up key funded only in the RPC answers.
- **No real data in this repo:** `test/security.test.js` fails if an address is neither a protocol contract nor an all-zeros example, or if a transaction hash appears.

The same tests also run on real unflat accounts (4 vaults in one batch, a vault that cannot pay, OpenCover, the key of an unflat account pasted as destination). Those accounts are not published: the tests read them from a private file, and are skipped without it.

```sh
RECOVERY_LIVE_FIXTURES=/path/to/private.json npm test   # shape: test/fixtures/live.example.json
```

Before each release the page was also tested with real funds.

## Limits

- Base only. Funds the unflat app bridged to other networks are not covered.
- OpenCover: only the redeem request. For the next steps write to info@unflat.eu.
- Accounts with a Kernel version other than 0.3.1 or a non-zero index are "not recognised": no transaction is offered.

## Deploy

GitHub Pages, from `.github/workflows/pages.yml`:
- every push to `main` runs the tests, builds `dist/index.html` and publishes it;
- pull requests only run the tests.

There is no dependency on unflat infrastructure.

## License

MIT, © 2026 UNFLAT S.R.L.
