# @ardrive/turbo-upload

A light Turbo client for Node and browsers. Sign
[ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)
data items with an Arweave JWK, a Solana key or a Solana wallet, pay for them,
and upload them to a Turbo upload service.

**Zero runtime dependencies.** Not "few". Zero. `dependencies`,
`peerDependencies` and `optionalDependencies` are all empty, and a test in the
shipped suite fails the build if that ever changes. The Node build imports
`node:crypto` and `node:buffer`; the browser build imports nothing at all.

```bash
npm install @ardrive/turbo-upload
```

Runnable examples: [`examples/`](examples/).

```js
import { TurboUpload, TESTNET } from "@ardrive/turbo-upload";

// Testnet, so this costs nothing and nothing it writes is permanent.
// Drop `uploadUrl` and `paymentUrl` to talk to production, where uploads are
// permanent, public, and paid for out of the wallet you signed with.
const client = new TurboUpload({
  jwk: process.env.ARWEAVE_JWK,
  uploadUrl: TESTNET.uploadUrl,
  paymentUrl: TESTNET.paymentUrl,
});

const { id, winc } = await client.upload({
  data: Buffer.from("hello permanence"),
  tags: [{ name: "Content-Type", value: "text/plain" }],
});
// -> https://ar-io.dev/<id>   (production reads from https://turbo-gateway.com/<id>)
```

---

## Why this exists

`@ardrive/turbo-sdk` is the full-featured client, and it is the right choice
for most things. It carries multi-chain signing, wallet connectors, payments
and a CLI, and that costs a dependency tree:

| installed on its own | lockfile entries | on disk |
|---|---|---|
| `@ardrive/turbo-sdk@1.43.0` | 784 | 895 MB |
| `@ardrive/turbo-upload@0.3.0` | 1 | 488 KB |
| `@ardrive/turbo-upload@0.5.0` | 1 | 700 KB |

Measured 2026-09-11 (0.5.0: 2026-10-01) into an empty project with `npm install`. Re-run it rather
than trusting this table: the numbers move as either tree changes, and the
point is the shape, not the digits.

When you are adding Arweave storage to *someone else's* server, the size of
that tree is what a dependency review weighs, and every package in it is a
package somebody has to vouch for. This one does one thing completely, with
nothing else in it.

## What it does

- Signs ANS-104 data items with an Arweave JWK (type 1, RSA-4096 / RSA-PSS-SHA256), a Solana key, or a Solana wallet's `signMessage` (type 4, Ed25519)
- Runs in Node and in browsers, workers and jsdom, with no polyfills
- Uploads them to a Turbo upload service, in one request or in chunks, from bytes or from a stream
- Prices uploads, reads balances and the free quota, submits SOL top-ups, shares credits, pays with `x-paid-by`, and opens Stripe checkout sessions
- Verifies data items, including a strict mode most implementations do not have

## Use `@ardrive/turbo-sdk` instead if you need

Ethereum, KYVE or Polygon keys · ArNS · x402 · the CLI, folder uploads, or
ArDrive drive abstractions · packing your own bundles · a client that builds
and sends the SOL transfer for you.

If you sign with an Arweave or Solana key or wallet and upload bytes, this
package does it and brings nothing with it.

---

## Solana keys

```js
import { TurboUpload } from "@ardrive/turbo-upload";

const client = TurboUpload.production({ jwk: process.env.SOLANA_SECRET_KEY, token: "solana" });
```

Takes any form a Solana user actually holds: a base58 secret key as Phantom exports it, the JSON array `solana-keygen` writes, raw 64 bytes, or a bare 32-byte seed. `client.address` is the base58 Solana address.

A 64-byte key carries its own public key, and that half is checked rather than trusted. A key whose halves disagree is refused at construction, because signing with one produces items that verify nowhere and you find out after paying.

This is **ANS-104 signature type 4**, the same type `@ardrive/turbo-sdk` uses for `token: "solana"`, so the two produce identical ids for identical content. Type 4 signs the hex encoding of the signature data rather than the bytes; the library does that for you, and a test asserts it, because signing the raw bytes yields a valid signature over the wrong message.

## Wallet signers

A browser holds no keys: a wallet does. Pass anything with a Solana
`publicKey` and an async `signMessage` as `signer`, and the client signs
through it. A Solana wallet adapter has that shape, so you pass the adapter
itself; its other properties are ignored.

```js
import { TurboUpload } from "@ardrive/turbo-upload";

export async function uploadWithWallet(wallet, bytes) {
  const client = TurboUpload.testnet({ signer: wallet });
  const item = await client.signAsync({ data: bytes, tags: [{ name: "Content-Type", value: "image/png" }] });
  return client.uploadSigned(item);
}
```

`publicKey` can be 32 bytes, a base58 string, or an object
with `toBytes()` (web3.js). `signMessage` can answer with the 64 signature
bytes or with `{ signature }`.

The client calls `signMessage` once per item, with the 96 ASCII bytes of the
lowercase hex of the item's deep hash, as `@ardrive/turbo-sdk` does. **Every
signature is verified before it is used**: a wallet that signs something else
would produce an item that verifies nowhere, found out after paying. A
`signMessage` that throws, an answer that is not 64 bytes, and a signature
that does not verify are all `TurboSignerError`, and nothing is uploaded.

**A Ledger cannot sign data items**, whether used directly or as an account
inside a browser wallet: it signs transactions and off-chain messages, not
raw bytes. Expect `TurboSignerError` from one, with the device's error as
`cause`.

Use `signAsync()` with a signer: `sign()` is synchronous, and a wallet is not.
`upload()` works with either. In Node, `createSolanaSigner(secretKey)` wraps a
key you hold in the same shape, so code written against a wallet runs in
tests and scripts unchanged.

## In the browser

The package has a second build, `web.js`, for browsers, workers and jsdom. It
shares the client with the Node build, hashes in plain JavaScript, returns
`Uint8Array` where Node returns `Buffer`, and signs only through a `signer`:
it refuses a raw key, because a secret key in a page is readable by every
script on it. It needs no `Buffer`, no `process` and no polyfill.

You import `@ardrive/turbo-upload` as usual; the `browser` export condition
selects the web build. To name a build explicitly, import
`@ardrive/turbo-upload/web` or `@ardrive/turbo-upload/node`. Both builds are
CommonJS, which every bundler below consumes.

| bundler or runtime | gets |
|---|---|
| webpack 5 (`target: "web"`), Vite, esbuild `platform: "browser"`, Next.js client code, Cloudflare Workers (workerd) | `web.js` |
| Jest with `jest-environment-jsdom` | `web.js` |
| Node, esbuild `platform: "node"`, Next.js server code | `index.js` |
| esbuild `platform: "neutral"`, webpack 4 | a build error: they ignore the `browser` condition, take the Node build, and cannot resolve `node:crypto` |

[`harness/`](https://github.com/ardriveapp/turbo-upload/tree/main/harness)
checks webpack 5, Vite, esbuild and Jest in CI; webpack 4 was checked once by
hand; the Next.js and workerd rows follow from the conditions those tools
document.

**Verifying a wallet's signature in the browser.** The web build checks each
signature with WebCrypto's Ed25519 (current Chromium, Firefox and Safari have
it), and with the signer's `verify(message, signature, publicKey)` only where
the runtime has none, as in jsdom or React Native. A wrapper over
`@noble/ed25519`'s `verify` is enough. With neither, signing throws
`TurboSignerError` rather than skipping the check.

In the web build, `verify()` and `verifyDataItem()` return a promise and check
type 4 items only.

## Paying for uploads

Turbo charges in winc (winston credits). Every call here takes
`{ signal, timeoutMs }`.

```js
import { TurboUpload } from "@ardrive/turbo-upload";

const client = TurboUpload.testnet({ jwk: process.env.SOLANA_SECRET_KEY, token: "solana" });

const size = client.getDataItemSize({ dataSize: 6_000_000 });  // the signed item, not the payload
const { winc } = await client.getUploadCost(size);
const balance = await client.getBalance();                        // { winc, ... }, zeros for a new address
const solBuys = await client.getWincForToken(1_000_000_000);      // 1 SOL in lamports
console.log({ winc, balance: balance.winc, perSol: solBuys.winc });
```

**The free tier is a quota, and it belongs to the signer.** Items up to a
per-item ceiling upload free until the signing address's lifetime allowance
is spent (there is a per-IP one too). Read the numbers from
`getInfo().freeTier` and `getFreeQuota()`: they are service policy, and
testnet's differ from production's. A `paidBy` upload draws no free quota.

**Topping up with SOL** is two steps, and the first is yours. Send a SOL
transfer to `await client.getFundingAddress()` with your wallet or RPC
library, wait until it is `finalized`, then report it:

```js
import { TurboUpload } from "@ardrive/turbo-upload";

export async function creditTopUp(client, signature) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await client.submitFundTransaction(signature);
    if (result.status !== "pending") return result;   // "confirmed" or "failed"
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`top-up ${signature} is still pending`);
}
```

Submitting a transaction twice credits it once. To credit another address,
add a memo instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with
the text `turboCreditDestinationAddress=<address>`. Legacy and version 0
transactions are both credited. Building the transfer is left to you, which
keeps this package free of a Solana library.

**Paying for someone else's uploads.** `shareCredits` lets another address
spend up to an amount of yours; that address then uploads with
`paidBy: <your address>`, and the charge comes out of the approval:

```js
import { TurboUpload } from "@ardrive/turbo-upload";

export async function sponsor(payer, uploader, bytes) {
  const size = uploader.getDataItemSize({ data: bytes });
  const { winc } = await payer.getUploadCost(size);
  await payer.shareCredits({
    approvedAddress: uploader.address,
    approvedWincAmount: BigInt(winc) * 12n / 10n,
    expiresBySeconds: 3600,          // the unused part returns when it expires
  });
  return uploader.upload({ data: bytes, paidBy: payer.address });
}
```

`paidBy` is one address. The service refuses a list with a 402, so the client
refuses one before anything is signed.

**Paying by card.** `createCheckoutSession({ amount: 1000, currency: "usd" })`
opens a Stripe checkout for $10.00 (`amount` is in cents) and returns its
`url`. The testnet payment service answers with a Stripe test-mode session.

## Large items: chunked uploads

An item of more than two chunks (over 10 MiB at the default 5 MiB chunk)
goes chunked, over `@ardrive/turbo-sdk`'s routes. Each chunk is its own
request with its own retries, so a dropped connection re-sends one chunk.
`paidBy` travels with the final request.

```js
import { createReadStream, statSync } from "node:fs";
import { TurboUpload } from "@ardrive/turbo-upload";

const client = TurboUpload.testnet({ jwk: process.env.SOLANA_SECRET_KEY, token: "solana" });
const path = "video.mp4";
const result = await client.uploadStream({
  streamFactory: () => createReadStream(path),
  size: statSync(path).size,
  tags: [{ name: "Content-Type", value: "video/mp4" }],
  onProgress: ({ processedBytes, totalBytes }) => console.log(processedBytes, "/", totalBytes),
});
console.log(result.id);
```

`uploadStream` reads the stream twice, once to sign and once to send, so
`streamFactory` returns a new stream each call. If the second read differs,
the upload is abandoned unfinalized and nothing is charged. In a browser,
pass `() => file.stream()`.

`upload()` and `uploadSigned()` take `chunking` (`"auto"`, `"force"`,
`"disabled"`), `chunkSize` (5 to 500 MiB), `chunkConcurrency` (default 5) and
`onProgress` too. If the service refuses a request as too large, the client
reads the limit from the refusal, remembers it, and sends in chunks. A
request's timeout grows with its size: at least `timeoutMs`, and enough for
128 KiB/s.

**The testnet service finalizes no item over 10,485,760 bytes**, chunked or
not, through this client or `@ardrive/turbo-sdk`: such an upload ends in
`TurboChunkedUploadError` with `uploadStatus` `"INVALID"`. Test chunking on
testnet with items of 10 MiB and under, sent with `chunking: "force"`.

## Support matrix

| | tested |
|---|---|
| Node | 18.17, 18, 20, 22, 24 (the whole suite, in CI) |
| Browsers | Chromium, Firefox and WebKit through Playwright: the type 4 corpus with no polyfills in CI, and the testnet flow by hand |
| jsdom | jsdom directly, and Jest's `jest-environment-jsdom` |
| Bundlers | esbuild, webpack 5, Vite (see § In the browser) |
| Keys | Arweave JWK (Node), Solana key (Node), Solana wallet signer (both builds) |

Ethereum, KYVE and Polygon keys are not supported in either build.

## Coming from `@ardrive/turbo-sdk`

The realistic reader already has turbo-sdk wired into a server and wants one
upload path out of it. The call maps directly:

```js
// before
import { TurboFactory } from "@ardrive/turbo-sdk";
const turbo = TurboFactory.authenticated({ privateKey: jwk });
const { id } = await turbo.uploadFile({
  fileStreamFactory: () => Readable.from(buffer),
  fileSizeFactory: () => buffer.length,
  dataItemOpts: { tags },
});

// after
import { TurboUpload } from "@ardrive/turbo-upload";
const client = new TurboUpload({ jwk });
const { id } = await client.upload({ data: buffer, tags });
```

What changes beyond the call:

| turbo-sdk | here |
|---|---|
| `TurboFactory.authenticated({ privateKey })` | `new TurboUpload({ jwk })`, and a bad key throws at construction rather than at first upload |
| stream factories | a `Buffer`, `Uint8Array` or string to `upload()`, or `uploadStream({ streamFactory, size })` |
| `walletAdapter` | `signer`: pass the same adapter |
| `dataItemOpts.paidBy` | `paidBy`, one address |
| `getBalance()` returns a signed-in account | `getBalance()` returns zeros for an unknown wallet, because the service answers `404` |
| errors arrive as `fetch failed` | typed errors that name the endpoint, the status and the method |
| any supported token | Arweave JWKs, Solana keys and Solana wallets. Anything else throws at construction |

**Keep turbo-sdk** for the cases in § Use `@ardrive/turbo-sdk` instead if you need. Nothing stops both being
installed; they share no state.

## API

### `new TurboUpload(options)`

| option | default | notes |
|---|---|---|
| `jwk` | | Arweave JWK, **an object or a JSON string**, or a Solana key with `token: "solana"`. Node build only |
| `signer` | | a wallet-style signer, in place of `jwk`. See § Wallet signers |
| `uploadUrl` | `https://upload.ardrive.io` | |
| `paymentUrl` | `https://payment.ardrive.io` | |
| `timeoutMs` | `60000` | **per request, not per call**. See § Bounding a call |
| `retry` | `{retries:3, minDelayMs:500, maxDelayMs:8000, retryStatuses:[408,429,500,502,503,504]}` | **partial**: override one field, keep the rest |
| `token` | `"arweave"`, or `"solana"` with `signer` | Anything else throws immediately |
| `fetch` | global `fetch` | injectable for tests and proxies |

Everything is validated **in the constructor**, so a bad key is a startup error
that names the problem.

**An option this package does not recognise is an error, not something it
ignores.** That holds for every method that takes an options object, and it
exists because the two typos that hide are both expensive:

```js
new TurboUpload({ jwk, uploadServiceUrl: TESTNET.uploadUrl });
// TurboConfigError: new TurboUpload: unknown option `uploadServiceUrl`
//   (did you mean `uploadUrl`?). Accepted: jwk, uploadUrl, paymentUrl, ...

client.sign({ data, tag: [{ name: "Chain-Id", value: "1" }] });
// TurboValidationError: sign(): unknown option `tag` (did you mean `tags`?)
```

Silently dropped, the first leaves the client on production, so data meant for
a throwaway testnet is written permanently and billed for. The second uploads
an item with no tags, which no tag query will find again. Neither shows up in
the return value.

```js
const { TurboUpload } = require("@ardrive/turbo-upload");

// Use the helpers rather than spreading TESTNET or PRODUCTION: those records
// also carry `name` and `gatewayUrl`, which are not constructor options.
const client = TurboUpload.testnet({ jwk, timeoutMs: 30_000, retry: { retries: 5 } });
```

#### Bounding a call

`timeoutMs` applies to each HTTP attempt, and `retry` runs up to `retries` more
of them. **They multiply.** With the defaults, one `upload()` can take:

```
(retries + 1) × timeoutMs + backoff
(3 + 1)       × 60_000    + ~15s     ≈ 4 minutes 7 seconds
```

There is deliberately no total-deadline option, because the right bound depends
on the caller. In a request handler or any path a user is waiting on, set one:

```js
const bounded = AbortSignal.any([shutdownSignal, AbortSignal.timeout(20_000)]);
await client.upload({ data, tags, signal: bounded });
```

Lower `timeoutMs` alone is not enough: it shortens each attempt, not the call.

### `await client.upload({ data, tags?, target?, anchor?, signal?, timeoutMs?, paidBy?, chunking? })`

Signs and uploads, chunked when the item is large (§ Large items). Returns the service response plus `id`, `owner` and
`byteCount`. The returned `id` is **checked against the id computed locally from
our own signature**, and a mismatch throws rather than handing back an id you did
not produce.

### `client.sign({ data, tags?, target?, anchor? })` → `{ binary, id, idB64Url, signature }`

Signs without uploading.

### `await client.signAsync({ data, tags?, target?, anchor? })` → the same as `sign()`

Signs through whichever signer the client has. Required with `signer`.

### `client.getDataItemSize({ data? | dataSize?, tags?, target?, anchor? })` → `number`

The byte length of the signed item, without signing it. Price this.

### `await client.uploadStream({ streamFactory, size, tags?, paidBy?, ... })`

See § Large items.

### `await client.uploadSigned(item, { signal?, timeoutMs?, paidBy?, chunking? })`

Uploads bytes already produced by `sign()`.

> **Use this, not `sign()` + `upload()`.** RSA-PSS draws a fresh random salt per
> signature, so signing the same payload twice yields **different bytes and a
> different id**. `upload()` signs internally; calling it after `sign()` signs a
> second time and the id you printed is not the id that landed.

```js
const item = client.sign({ data, tags });
await recordInMyDatabase(item.idB64Url);   // the id, before it exists on-chain
await client.uploadSigned(item);           // the same bytes, same id
```

### `await client.getUploadCost(bytes)` → `{ winc, adjustments }`

Price in winston credits for a raw byte count. A signed item is ~1044 bytes
larger than its payload, so price `item.binary.length`, not your payload length.

### `await client.getBalance()` → `{ winc, controlledWinc, effectiveBalance, address }`

A wallet the payment service has never seen answers `404 User Not Found`. That
is a zero balance, not an error, and is normalised to zeros.

### `await client.getInfo()` / `await client.getFreeUploadLimitBytes()`

Service info, including the free-upload threshold, **107,520 bytes** when this
was written. Read it from `/v1/info` rather than from this page: it is service
policy and it changes. Items at or below it upload with no credit
balance at all.

### Payment calls

`getWincForToken(amount)` · `getPaymentInfo()` · `getFundingAddress()` ·
`getFreeQuota({ address? })` · `submitFundTransaction(txId)` ·
`shareCredits({ approvedAddress, approvedWincAmount, expiresBySeconds? })` ·
`createCheckoutSession({ amount, currency?, owner?, ... })`. See § Paying for
uploads.

### `client.verify(binary, { strictSaltLength? })` → `boolean`

Structural and cryptographic verification. § The PSS salt length, and why it is
478 explains what `strictSaltLength` catches.

### Low-level exports

`signDataItem` · `verifyDataItem` · `createDataItem` · `parseDataItem` ·
`getSignatureData` · `deepHash` · `serializeTags` · `deserializeTags` ·
`signMessage` · `verifyMessage` · `idFromSignature` · `parseJwk` ·
`ownerFromJwk` · `addressFromOwner` · `publicKeyFromOwner` ·
`createSolanaSigner`. The web build exports the format helpers, an async
`verifyDataItem`, and no RSA or key helpers.

Constants: `MAX_TAG_BYTES` (4096) · `MIN_ITEM_SIZE` (1044) ·
`PSS_SALT_LENGTH_BYTES` (478) · `SIGNATURE_TYPE_ARWEAVE` (1) · `PRODUCTION` ·
`TESTNET` · `DEFAULT_TIMEOUT_MS` · `DEFAULT_RETRY`.

### Types

Hand-written `index.d.ts`, so no `typescript` dependency, no `@types/*`.

```ts
import type { Tag } from "@ardrive/turbo-upload";
// Tag is { name: string; value: string }
```

`Tag` is exported deliberately: in `@ardrive/turbo-sdk` you have to go read a
third-party package's `.d.ts` to learn the shape.

### Errors

Every error extends `TurboError` and carries its context.

| class | when | carries |
|---|---|---|
| `TurboKeyError` | bad/missing/non-RSA-4096 JWK | none |
| `TurboConfigError` | bad option or unsupported token | none |
| `TurboValidationError` | bad arguments to a call | none |
| `TurboNetworkError` | no response at all (DNS, TLS, reset) | `endpoint`, `method`, `cause` |
| `TurboTimeoutError` | exceeded `timeoutMs`, or caller aborted | `endpoint`, `timeoutMs`, `cause` |
| `TurboHTTPError` | non-2xx | `status`, `endpoint`, `method`, `body` |
| `TurboPaymentError` | `402`, the wallet cannot pay. A `TurboHTTPError`, so existing catches still work | `status`, `endpoint`, `method`, `body` |
| `TurboVerificationError` | the service returned an id we did not sign | `expectedId`, `receivedId` |
| `TurboSignerError` | a wallet signer threw, answered with something other than 64 bytes, or signed something else. Nothing was uploaded | `cause` |
| `TurboChunkedUploadError` | a chunked upload did not finalize (`INVALID`, or the wait ran out). `UNDERFUNDED` is a `TurboPaymentError` | `uploadId`, `uploadStatus` |

```
TurboHTTPError: POST https://upload.ardrive.io/v1/tx failed: HTTP 402 Payment Required
  {"error":"Insufficient balance"}
```

rather than a bare `fetch failed`.

---

## Testing against it

The constructor validates eagerly, so a placeholder key will not work. Generate
a throwaway one, and inject `fetch`:

```js
const { generateKeyPairSync } = require("node:crypto");
const { TurboUpload } = require("@ardrive/turbo-upload");

const jwk = generateKeyPairSync("rsa", { modulusLength: 4096 })
  .privateKey.export({ format: "jwk" });

const fetchStub = async (url, init) =>
  new Response(JSON.stringify({ id: "…", winc: "0" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const client = new TurboUpload({ jwk, fetch: fetchStub });
```

**Two things worth knowing before you write the stub.** `uploadSigned` checks
that the id the service returned matches the one it computed locally, so a stub
returning a fixed id fails with `TurboVerificationError` rather than the thing
you were testing. Return the id of what was actually POSTed. And signing an
RSA-4096 key takes tens of milliseconds, so generate it once per suite, not per
test.

The error classes take an options object and are declared with constructors, so
you can build one directly to test your own handling:

```js
const { TurboPaymentError } = require("@ardrive/turbo-upload");
throw new TurboPaymentError({ status: 402, endpoint: UPLOAD_URL, method: "POST" });
```

## Endpoints

Exported as named constants so nobody has to guess a hostname.

Each `gatewayUrl` is the gateway its own upload service names in `/v1/info`.
**Set it yourself if reads matter to you.** Any gateway serving Arweave returns
these items by id, they differ in what they have indexed, and a busy one will
rate limit you: `arweave.net` answered `429` to ten consecutive reads of items
this package had uploaded moments before.

| | upload | payment | gateway |
|---|---|---|---|
| `PRODUCTION` | `https://upload.ardrive.io` | `https://payment.ardrive.io` | `https://turbo-gateway.com` |
| `TESTNET` | `https://upload.services.ar-io.dev` | `https://payment.services.ar-io.dev` | `https://ar-io.dev` |

> **The testnet hostnames contain `.services.`**, which is why they are
> constants rather than prose. `upload.ar-io.dev`, without `.services.`,
> **resolves** and serves an HTML page on every path including `/v1/tx`, so a
> wrong hostname gives you a `200` with an HTML body instead of an obvious
> failure. Import the constant and the question never arises.

Uploads to `PRODUCTION` are permanent and cost real money.

---

## The PSS salt length

ANS-104 says RSA-PSS and stops. This package sets the salt length to **478
bytes** explicitly rather than inheriting a default, because that is what the
reference implementation produces and **getting it wrong does not fail loudly**:
verification is salt-agnostic, so a 32-byte-salt signature passes round-trip
tests, passes cross-verification, and is accepted by the live service. It would
fail later, at a stricter verifier.

What that means for you: nothing, unless you sign items yourself elsewhere. If
you do, pass `{ strictSaltLength: true }` to `client.verify()` to catch it.

The derivation, the empirical recovery of the salt off the wire, and the
per-library instructions are in [the conformance spec](https://github.com/ardriveapp/turbo-upload/blob/main/conformance/spec.md).

## Conformance

The package ships **22 conformance vectors** in `vectors/vectors.json`,
generated from `@dha-team/arbundles@1.0.4`, the de-facto reference that the
gateways and bundlers actually run. The test suite ships too, so you can
re-prove all of it from your own `node_modules`:

```bash
npm test --prefix node_modules/@ardrive/turbo-upload
```

The vectors pin the unsigned item bytes, the deep-hash transcript, every field
offset, the serialized tag region and a reference-produced signature per vector.
No private key ships: the corpus carries only the public modulus, and the
signing tests generate an ephemeral key at runtime.

A second corpus in the repository, `conformance/type4-vectors.json`, holds 22
complete type 4 (Solana) items generated by `@ardrive/turbo-sdk@2.1.0`. Ed25519
is deterministic, so it pins every byte, signature and id included; both
builds reproduce it, in Node, in three browsers and in jsdom. It does not
ship, to keep the package small.

Reimplementing the format rather than consuming it? [The conformance
spec](https://github.com/ardriveapp/turbo-upload/blob/main/conformance/spec.md) has the byte-level rules, including the two adjacent 32-byte
fields with opposite string conventions and the encoder quirks reproduced
bug-for-bug.

## Requirements

Node **>= 18.17.0** (global `fetch`, `AbortSignal.any`), or a browser with
`fetch`. In a browser, sign with a wallet; a raw key does not belong in a page.

## License

Apache-2.0
