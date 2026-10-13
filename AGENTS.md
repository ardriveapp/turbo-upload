# AGENTS.md

For an agent writing an integration against `@ardrive/turbo-upload`. Recipes
first, then the things that get written wrong. The README is the full
reference.

## Does this apply

**A light Turbo client for Node and browsers, with zero dependencies.** It
signs ANS-104 data items, pays for them and uploads them to Turbo.

- **Keys and wallets**: an Arweave RSA-4096 JWK (Node), a Solana key (Node:
  base58, a `solana-keygen` JSON array, 64 bytes or a 32-byte seed), a
  Solana wallet's `signMessage` (`signer`, both builds), or an EVM account
  or wallet through viem (`signer`, both builds). Solana items are ANS-104
  type 4 and EVM items type 3, byte-identical to what `@ardrive/turbo-sdk`
  emits.
- **Runtimes**: Node 18.17 and up; browsers, workers and jsdom through the
  web build, which the `browser` export condition selects. No polyfills.
- **Paying**: prices, balances, the free quota, reporting a SOL top-up you
  sent, sharing credits, `paidBy`, Stripe checkout sessions.
- **Large items**: chunked uploads, from bytes or from a stream.
- **x402**: an EVM wallet pays USDC on Base for an upload that the service
  signs (`uploadUnsignedX402`, both builds). The service owns the item.

**Stop and use `@ardrive/turbo-sdk`** if the task needs an Ethereum private
key signed without an EVM library, a KYVE or Polygon key, an ETH or USDC
top-up, signed or chunked x402 uploads, ArNS, folder or ArDrive abstractions,
packing your own bundles, or a client that builds and sends the SOL transfer
itself. This package reports a SOL transfer; your wallet or RPC library sends
it.

Both can be installed together. They share no state.

## Setup

```js
const { TurboUpload } = require("@ardrive/turbo-upload");

const client = TurboUpload.production({ jwk: JSON.parse(process.env.ARWEAVE_JWK) });
```

`TurboUpload.testnet({ jwk })` for anything not meant to last forever. Uploads
to production are permanent, public and paid for out of that wallet.

Use `.production()` and `.testnet()` rather than spreading `PRODUCTION` or
`TESTNET` into the constructor: those records also carry `name` and
`gatewayUrl`, which are not constructor options and are rejected.

`client.address` is the wallet address, as a synchronous property.

## Sign with a wallet

```js
import { TurboUpload } from "@ardrive/turbo-upload";

export async function upload(wallet, bytes) {
  // A Solana wallet adapter works as is: { publicKey, signMessage }.
  const client = TurboUpload.production({ signer: wallet });
  return client.upload({ data: bytes, tags: [{ name: "Content-Type", value: "image/png" }] });
}
```

**Use `signAsync()`, not `sign()`, with a signer**: `sign()` is synchronous and
throws for one. Every wallet signature is verified before upload, and a
wallet that cannot sign data items (a Ledger) throws `TurboSignerError` with
nothing uploaded. In a browser with no WebCrypto Ed25519 (jsdom, React
Native) the signer also needs `verify(message, signature, publicKey)`.

## Sign with an EVM key or wallet

```js
import { privateKeyToAccount } from "viem/accounts";
import { recoverPublicKey } from "viem";
import { TurboUpload } from "@ardrive/turbo-upload";

export function fromKey(privateKey) {
  // A viem account plus viem's recoverPublicKey is a signer as is.
  return TurboUpload.production({ signer: { ...privateKeyToAccount(privateKey), recoverPublicKey }, token: "base-eth" });
}

export function fromWallet(walletClient, address) {
  const signer = {
    address,
    signMessage: ({ message }) => walletClient.signMessage({ account: address, message }),
    recoverPublicKey,
  };
  return TurboUpload.production({ signer, token: "base-eth" });
}
```

**The caller brings viem** (or any library with the same three names). This
package has no secp256k1: Node cannot sign a digest it is handed with it,
WebCrypto has no secp256k1 at all, and the package does not carry its own
curve code for private keys. `token` is
`"ethereum"`, `"base-eth"` or `"base-usdc"` and is required with an EVM
signer. A wallet with no `publicKey` signs one connect message the first
time, so its key can be recovered. Every item signature is checked before
upload, and a smart-contract wallet (ERC-1271, ERC-6492) throws
`TurboSignerError` with nothing uploaded: it cannot sign data items. A deployed
one can pay for an x402 upload instead (below). `client.address` is the EIP-55 `0x` address, and the free quota is that
address's.

## Upload one thing

```js
const { id, winc } = await client.upload({
  data: Buffer.from("hello"),
  tags: [{ name: "Content-Type", value: "text/plain" }],
});
```

`id` is the base64url string. `winc` is what it cost, `"0"` inside the free
tier. **Tag anything you will want to find again**: an id is the only other
handle you get.

## Upload many

There is no batch call. Loop, and decide per item what a failure means.

```js
const results = [];
for (const file of files) {
  try {
    results.push(await client.upload({ data: file.bytes, tags: file.tags }));
  } catch (err) {
    if (err instanceof TurboPaymentError) throw err;   // out of credit, stop
    results.push({ error: err, file });                 // otherwise record and continue
  }
}
```

**Stop on `TurboPaymentError` rather than continuing.** Every later item will
fail the same way, and earlier ones are already paid for and permanent.

## Know the cost before uploading

```js
const size = client.getDataItemSize({ data, tags });
const { winc } = await client.getUploadCost(size);
```

Price the signed item's size, not the payload length: a signed item is 1044
bytes larger than its data for an Arweave key, 150 for an EVM one and 116 for
a Solana one, before tags.

## Pay for someone else's upload

```js
await payer.shareCredits({ approvedAddress: uploader.address, approvedWincAmount: winc, expiresBySeconds: 3600 });
await uploader.upload({ data, paidBy: payer.address });
```

**`paidBy` is one address.** A list is refused before signing. The free quota
belongs to the signing address, so a fresh uploader key starts with its own,
and a `paidBy` upload draws none of it.

## Top up with SOL

Send the transfer yourself, to `await client.getFundingAddress()`, wait for
`finalized`, then `await client.submitFundTransaction(signature)`. The answer's
`status` is `"confirmed"`, `"pending"` (submit again later) or `"failed"`.
Submitting twice credits once.

## Pay in USDC from an EVM wallet (x402)

```js
import { privateKeyToAccount } from "viem/accounts";
import { uploadUnsignedX402, TESTNET } from "@ardrive/turbo-upload";

export async function uploadWithUsdc(bytes) {
  const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY); // a viem LocalAccount works as is
  const { id, payer, x402Payment } = await uploadUnsignedX402({
    data: bytes,
    tags: [{ name: "Content-Type", value: "image/png" }],
    signer,
    maxUsdc: 50_000n,               // required, USDC base units: 0.05 USDC
    uploadUrl: TESTNET.uploadUrl,   // Base Sepolia; production pays on Base
  });
  return { id, payer, tx: x402Payment?.transactionHash };
}
```

A function, not a client method, and no data-item key: the service signs the
item, so `owner` is the service and your address is `payer`. **There is no free
tier here**: every upload is paid, with a minimum price
([README § x402 uploads](README.md#x402-uploads-pay-in-usdc-from-an-evm-wallet)). The
signer signs one EIP-712 authorization for exactly what the service's `402`
asks; over `maxUsdc`, another network or another asset throws
`TurboPaymentError` before anything is signed. For a viem `WalletClient`, pass
`{ address, signTypedData: (t) => walletClient.signTypedData({ account, ...t }) }`.
The first Content-Type tag becomes the item's Content-Type, and every other
tag is stored as given, non-ASCII values included, up to 3072 tag bytes. One request carries at most
`X402_MAX_DATA_BYTES` (about 75 MiB), and the paid request is never retried:
if it fails, the error says the payment might have settled.

## Upload something large

`upload()` sends an item over 10 MiB in 5 MiB chunks without being asked.
For data you do not want in memory, `uploadStream({ streamFactory, size })`
reads the stream twice, so `streamFactory` returns a new stream each call.
If the service does not finalize a chunked upload, it ends in
`TurboChunkedUploadError`, carrying the `uploadStatus` the service reported.

## Record the id before it exists

```js
const item = client.sign({ data, tags });
await db.record(item.idB64Url);      // the string form
await client.uploadSigned(item);     // same bytes, same id
```

**`item.idB64Url` is the string. `item.id` is a Buffer**, so printing or
storing `item.id` gives you the wrong thing.

## Handle running out of credit

```js
try {
  await client.upload({ data, tags });
} catch (err) {
  if (err instanceof TurboPaymentError) {
    // 402. The wallet cannot pay. Retrying never helps.
    alert(`Turbo wallet ${client.address} is out of credit, nothing is being stored`);
    return;
  }
  throw err;
}
```

A payment failure is a standing condition, not a blip. An integration that
treats it like a `503` goes quiet while reporting healthy, which for anything
archival is the worst available failure mode.

## Read it back

```js
import { PRODUCTION } from "@ardrive/turbo-upload";
const res = await fetch(`${PRODUCTION.gatewayUrl}/${id}`, { redirect: "follow" });
```

An id is not a URL. Any gateway serving Arweave returns the item at
`<gateway>/<id>`, and `PRODUCTION.gatewayUrl` is a sensible default rather than
the only answer. Gateways differ in what they have indexed and a busy one will
rate limit, so a reader that matters tries more than one. Follow
redirects: a gateway may serve HTML from a per-transaction subdomain.

## Bound the call

`timeoutMs` is **per HTTP request**, and `retry` runs up to `retries` more of
them, so one `upload()` can take about four minutes with the defaults. There is
no total-deadline option, deliberately, because the right bound belongs to the
caller.

```js
const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(20_000)]);
await client.upload({ data, tags, signal });
```

Lowering `timeoutMs` shortens each attempt, not the call.

## The five things that get written wrong

**1. `sign()` then `upload()` charges twice.** RSA-PSS draws a fresh random
salt per signature, so signing the same payload twice produces different bytes
and a different id. `upload()` signs internally, so calling it after `sign()`
signs again and the id you recorded is not the id that landed. Use
`uploadSigned(item)`.

**2. `target` and `anchor` are adjacent 32-byte fields with opposite
conventions.** `target` is a **base64url string** that decodes to 32 bytes.
`anchor` is **32 raw bytes**, and a string passed to it is used as raw UTF-8
bytes, not decoded. A 43-character base64url anchor throws.

**3. An unrecognised option throws**, on every method that takes one, as of
`0.2.0`. `uploadServiceUrl` is not `uploadUrl`; `tag` is not `tags`. The error
names the correct key.

**4. Production is the default.** A bare `new TurboUpload({ jwk })` talks to
mainnet.

**5. The web build returns `Uint8Array`, the Node build `Buffer`.** Code that
calls `.toString("hex")` on `item.binary` works in Node and breaks in a
browser. Use `item.idB64Url` for the id in both.

## Errors

Every one extends `TurboError`, so `catch (e) { if (e instanceof TurboError) }`
catches all of them.

| Class | Catch it to | Read off it |
|---|---|---|
| `TurboPaymentError` | tell "cannot pay" from a transient failure. **Retrying never helps**. After an x402 payment is sent, check the payer's USDC transfers first | `status`, `body` |
| `TurboVerificationError` | detect an id that is not the one you signed. **Never swallow this** | `expectedId`, `receivedId` |
| `TurboSignerError` | tell a wallet that cannot sign data items (a Ledger, a smart-contract EVM wallet) from a network failure. Nothing was uploaded | `cause` |
| `TurboChunkedUploadError` | report a chunked upload that did not finalize | `uploadId`, `uploadStatus` |
| `TurboTimeoutError` | tell a slow endpoint from a broken one | `endpoint`, `timeoutMs` |
| `TurboNetworkError` | retry a connection-level failure | `endpoint`, `cause` |
| `TurboHTTPError` | handle any other non-2xx | `status`, `endpoint`, `body` |
| `TurboKeyError` | report a bad or missing JWK at startup | message |
| `TurboConfigError` | report a bad option at startup | message |
| `TurboValidationError` | report bad arguments to a call | message |

`TurboPaymentError` extends `TurboHTTPError`, so catching the base class still
catches a 402.

## Testing without spending anything

The constructor validates eagerly, so a placeholder key fails.

```js
const { generateKeyPairSync } = require("node:crypto");
const jwk = generateKeyPairSync("rsa", { modulusLength: 4096 })
  .privateKey.export({ format: "jwk" });
```

Generate it **once per suite**: RSA-4096 keygen takes tens of milliseconds.
Inject a stub with `new TurboUpload({ jwk, fetch: myStub })`. `uploadSigned`
checks the returned id against the one it computed, so a stub returning a fixed
id fails with `TurboVerificationError` rather than the thing under test. Return
the id of what was actually posted.

Testnet uploads are free and real, which is usually a better test than a stub.

## Low-level exports

Supported API, not internals. Reach for these only when building or inspecting
items outside the client.

| Export | Use |
|---|---|
| `signDataItem`, `createDataItem` | build an item without a client |
| `parseDataItem` | read the field offsets of a serialized item |
| `verifyDataItem` | verify one. `{strictSaltLength: true}` also pins the PSS salt length. Type 3 needs `{recoverPublicKey}` and returns a promise, and throws without it (0.5.0 returned `false` for any type 3 item); `{strictV: true}` also pins v |
| `getSignatureData`, `deepHash` | compute the ANS-104 signature preimage |
| `serializeTags`, `deserializeTags` | the Avro tag encoding |
| `signMessage`, `verifyMessage` | raw RSA-PSS over arbitrary bytes |
| `idFromSignature` | `SHA-256(signature)`, which is how an id is derived |
| `parseJwk`, `ownerFromJwk`, `addressFromOwner`, `publicKeyFromOwner` | key and address handling |
| `createSolanaSigner` | a Solana key in the wallet shape, for tests and scripts (Node build) |
| `PSS_SALT_LENGTH_BYTES`, `MAX_TAG_BYTES`, `MIN_ITEM_SIZE`, `SIGNATURE_TYPE_ARWEAVE`, `SIGNATURE_TYPE_ETHEREUM`, `SIGNATURE_TYPE_SOLANA` | protocol constants |
| `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY` | the client's defaults, for reading |
| `PRODUCTION`, `TESTNET` | endpoint records |
