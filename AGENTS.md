# AGENTS.md

For a coding agent writing an integration against `@ardrive/turbo-upload`.
Read this first; it is shorter than the README and covers what gets written
wrong. The README is the reference, [`conformance/spec.md`](conformance/spec.md)
is the byte-level authority.

## Does this package apply

Signs ANS-104 data items with an **Arweave RSA-4096 JWK** and uploads them to a
Turbo upload service. **Node only. Zero dependencies. Upload only.**

**Stop and use `@ardrive/turbo-sdk` instead** if the task needs any of: a
non-Arweave key (Ethereum, Solana, KYVE, Polygon), a browser or an injected
wallet, buying credits or any payment flow, folder or ArDrive abstractions,
packing your own bundles, or streaming a file too large to hold in memory.

Both can be installed together. They share no state.

## The four things that get written wrong

Everything else in the API is ordinary. These are not.

**1. `sign()` then `upload()` is not `upload()`.** Signing twice produces two
different ids and two charges, because the anchor is random per signature. If
you need the id before sending, sign once and pass that item to `uploadSigned`:

```js
const item = client.sign({ data, tags });   // item.id is final
await client.uploadSigned(item);            // do not call upload() here
```

**2. `target` and `anchor` are adjacent 32-byte fields with opposite
conventions.** `target` is a **base64url string** that decodes to 32 bytes.
`anchor` is **32 raw bytes**, and a string passed to it is used as raw UTF-8
bytes, not decoded. Reading one and writing the other is silent.

**3. An unrecognised option throws.** As of `0.2.0` every options object rejects
keys it does not know, on every public method. `uploadServiceUrl` is not
`uploadUrl`, and `tag` is not `tags`. Before `0.2.0` these were ignored, which
is why the check exists: a misspelled `uploadUrl` left the client on production.

**4. Production is the default.** `new TurboUpload({ jwk })` talks to mainnet,
where uploads are permanent, public and paid for. Pass `TESTNET.uploadUrl` and
`TESTNET.paymentUrl` for anything that is not meant to last forever.

## The minimal correct call

```js
const { TurboUpload, TESTNET } = require("@ardrive/turbo-upload");

const client = new TurboUpload({
  jwk: JSON.parse(process.env.ARWEAVE_JWK),
  uploadUrl: TESTNET.uploadUrl,
  paymentUrl: TESTNET.paymentUrl,
});

const { id, winc } = await client.upload({
  data: Buffer.from("hello"),
  tags: [{ name: "Content-Type", value: "text/plain" }],
});
```

`client.address` is a synchronous property, not a promise.

## Catch this when

| Class | Catch it when you want to | Read off it |
|---|---|---|
| `TurboPaymentError` | tell "cannot pay" from a transient failure. **Retrying never helps** | `status` (402), `body` |
| `TurboVerificationError` | detect that the returned id is not the one you signed. **Never swallow this** | `expectedId`, `receivedId` |
| `TurboTimeoutError` | distinguish a slow endpoint from a broken one | `endpoint`, `timeoutMs` |
| `TurboNetworkError` | retry a connection-level failure | `endpoint`, `cause` |
| `TurboHTTPError` | handle any other non-2xx | `status`, `endpoint`, `body` |
| `TurboKeyError` | report a bad or missing JWK at startup | message |
| `TurboConfigError` | report a bad option or unsupported token at startup | message |
| `TurboValidationError` | report bad arguments to a call | message |

`TurboPaymentError` extends `TurboHTTPError`, and all of them extend
`TurboError`, so a single `catch (e) { if (e instanceof TurboError) ... }`
still works.

## Timeouts compose, so bound the call yourself

`timeoutMs` is **per HTTP request**, and `retry` runs up to `retries` more of
them. With the defaults one `upload()` can take about four minutes. There is no
total-deadline option, deliberately, because the right bound belongs to the
caller. In a request handler, pass a signal:

```js
const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(20_000)]);
await client.upload({ data, tags, signal });
```

Lowering `timeoutMs` alone shortens each attempt, not the call.

## Testing without spending anything

The constructor validates eagerly, so a placeholder key fails. Generate a
throwaway and inject `fetch`:

```js
const { generateKeyPairSync } = require("node:crypto");
const jwk = generateKeyPairSync("rsa", { modulusLength: 4096 })
  .privateKey.export({ format: "jwk" });
```

Generate it **once per suite**: RSA-4096 keygen takes tens of milliseconds.
`uploadSigned` checks the returned id against the one it computed, so a stub
returning a fixed id fails with `TurboVerificationError` rather than the thing
under test. Return the id of what was actually posted.

## Low-level exports, and when to reach for them

All supported API, not internals. Reach for them only when building or
inspecting items outside the client.

| Export | Use |
|---|---|
| `signDataItem`, `createDataItem` | build an item without a client |
| `parseDataItem` | read the field offsets of a serialized item |
| `verifyDataItem` | verify one. Pass `{strictSaltLength: true}` to also pin the PSS salt length |
| `getSignatureData`, `deepHash` | compute the ANS-104 signature preimage |
| `serializeTags`, `deserializeTags` | the Avro tag encoding |
| `signMessage`, `verifyMessage` | raw RSA-PSS over arbitrary bytes |
| `idFromSignature` | `SHA-256(signature)`, which is how an id is derived |
| `parseJwk`, `ownerFromJwk`, `addressFromOwner`, `publicKeyFromOwner` | key and address handling |
| `PSS_SALT_LENGTH_BYTES`, `MAX_TAG_BYTES`, `MIN_ITEM_SIZE`, `SIGNATURE_TYPE_ARWEAVE` | protocol constants |
| `PRODUCTION`, `TESTNET` | endpoint records. Use these rather than typing a hostname |

## Reading an item back

An id is not a URL. Any gateway serving Arweave returns the item at
`<gateway>/<id>`, and `PRODUCTION.gatewayUrl` is a sensible default rather than
the only answer. Gateways differ in what they have indexed and a busy one will
rate limit, so a reader that matters should try more than one.
