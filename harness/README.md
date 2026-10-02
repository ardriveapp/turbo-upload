# Browser harness

Not published. Runs the web build (`web.js`) where it is meant to run, with
the tools an application uses, and nothing added. Its dependencies are this
directory's; the package keeps none.

```bash
npm ci                                   # Node >= 22
npx playwright install --with-deps chromium firefox webkit
npm test                                 # type 4 corpus in Chromium, Firefox, WebKit and jsdom
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
