# Browser harness

Not published. Runs the web build (`web.js`) where it is meant to run, with
the tools an application uses, and nothing added. Its dependencies are this
directory's; the package keeps none.

```bash
npm ci                                   # Node >= 22
npx playwright install --with-deps chromium firefox webkit
npm test                                 # type 4 and type 3 corpora in Chromium, Firefox, WebKit and jsdom
npm run jest                             # the same under jest-environment-jsdom
npm run bundlers                         # which build esbuild, webpack 5 and Vite pick
npm run types                            # web.d.ts without Node types, index.d.ts with them
TURBO_PAYER_KEY=/path/to/devnet-key.json npm run devnet
```

`npm test` bundles `page.js` with esbuild for the browser, so the package
resolves through its `browser` export condition, then signs every vector in
`../conformance/type4-vectors.json` with a wallet-style signer
(`@noble/ed25519` over the vector's seed) and compares the bytes with
turbo-sdk's. It fails if `Buffer` or `process` exists in the page.

The same run signs every vector in `../conformance/type3-vectors.json`
through an injected EIP-1193 provider over the vector's test key, reached
through a viem `WalletClient` with the adapter the package README shows. The
provider has no public key to give, so each client signs the connect message
once and then the 48 bytes of each item. Then five wallets that misbehave on
the item: one signs the hex as text, one answers with a high s, one with 97
bytes, one rejects the prompt, and one writes v as 0 or 1. The first four
must fail with `TurboSignerError` before any request is made, and the last
must produce an item that verifies with `strictV`.

## The devnet flow

`npm run devnet` also runs the live flow from each browser against the
testnet services: service info, prices, balances, a free upload, credit
sharing, a paid upload with `paidBy`, and chunked uploads. Every request goes
through a fetch that refuses any host but the testnet upload, payment and
gateway hosts. Each upload is fetched back from `https://ar-io.dev/raw/<id>`
and compared byte for byte with what was sent.

**The gateway budgets reads.** `ar-io.dev` gives each client a byte budget
for reads: its `/ar-io/info` (`rateLimiter.dataEgress`) reports 102,400,000
bytes, refilling at 20,480 bytes a second. Once it is spent, a read answers
402 with an x402 payment offer. It is a budget, not a size limit.
The fetch-back reads in 1 MiB ranges and waits out a 402 rather than paying
or failing, so a run that uploads tens of MiB can take an hour to confirm.
`node fetchback.mjs results/run-<n>.json` re-checks a run's uploads later.
An item larger than the budget is read back over time, as it refills.

`TURBO_PAYER_KEY` is a `solana-keygen` JSON file whose address holds testnet
Turbo credits. It is read, never printed. The flow is not run in CI: a key in
a workflow input lands in a public run's event payload.

## Running WebKit on an older Linux

Playwright's current WebKit build needs a newer glibc than Ubuntu 22.04 has.
`HARNESS_WEBKIT_PLAYWRIGHT=/path/to/node_modules/playwright` takes WebKit from
another Playwright install, for example an older one whose WebKit was built
for that host. The report records the WebKit version that ran.
