# AGENTS.md

For an agent writing an integration against `@ardrive/turbo-upload`. Recipes
first, then the things that get written wrong. The README is the full
reference.

## Does this apply

Signs ANS-104 data items with an **Arweave RSA-4096 JWK** and uploads them to
Turbo. **Node only. Zero dependencies. Upload only.**

**Stop and use `@ardrive/turbo-sdk`** if the task needs a non-Arweave key
(Ethereum, Solana, KYVE, Polygon), a browser or injected wallet, buying credits
or any payment flow, folder or ArDrive abstractions, packing your own bundles,
or streaming a file too large to hold in memory.

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
const item = client.sign({ data, tags });
const { winc } = await client.getUploadCost(item.binary.length);
```

Price `item.binary.length`, not the payload length: a signed item is about 1044
bytes larger than its data.

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
rate limit, so a reader that matters should try more than one. Follow
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

## The four things that get written wrong

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

## Errors

Every one extends `TurboError`, so `catch (e) { if (e instanceof TurboError) }`
catches all of them.

| Class | Catch it to | Read off it |
|---|---|---|
| `TurboPaymentError` | tell "cannot pay" from a transient failure. **Retrying never helps** | `status`, `body` |
| `TurboVerificationError` | detect an id that is not the one you signed. **Never swallow this** | `expectedId`, `receivedId` |
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
| `verifyDataItem` | verify one. `{strictSaltLength: true}` also pins the PSS salt length |
| `getSignatureData`, `deepHash` | compute the ANS-104 signature preimage |
| `serializeTags`, `deserializeTags` | the Avro tag encoding |
| `signMessage`, `verifyMessage` | raw RSA-PSS over arbitrary bytes |
| `idFromSignature` | `SHA-256(signature)`, which is how an id is derived |
| `parseJwk`, `ownerFromJwk`, `addressFromOwner`, `publicKeyFromOwner` | key and address handling |
| `PSS_SALT_LENGTH_BYTES`, `MAX_TAG_BYTES`, `MIN_ITEM_SIZE`, `SIGNATURE_TYPE_ARWEAVE` | protocol constants |
| `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY` | the client's defaults, for reading |
| `PRODUCTION`, `TESTNET` | endpoint records |
