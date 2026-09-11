# @ardrive/turbo-upload

Sign [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)
data items with an Arweave JWK and upload them to a Turbo upload service.

**Zero runtime dependencies.** Not "few". Zero. `dependencies`,
`peerDependencies` and `optionalDependencies` are all empty, and a test in the
shipped suite fails the build if that ever changes. The only things it imports
are `node:crypto` and `node:buffer`.

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

| installed on its own | lockfile entries | on disk | `npm audit` |
|---|---|---|---|
| `@ardrive/turbo-sdk@1.43.0` | 784 | 895 MB | 58 advisories, 3 critical, 9 high |
| `@ardrive/turbo-upload@0.2.0` | 1 | 464 KB | none |

Measured 2026-09-09 into an empty project with `npm install` and `npm audit`.
Re-run it rather than trusting this table: the numbers move as either tree
changes, and the point is the shape, not the digits.

When you are adding Arweave storage to *someone else's* server, that tree is
what a dependency review rejects, and those three criticals are what it asks
about first. This package does one thing completely, with nothing else in it.

## What it does

- Signs ANS-104 data items with an Arweave JWK (signature type 1, RSA-4096 / RSA-PSS-SHA256)
- Uploads them to a Turbo upload service (`POST /v1/tx`)
- Prices uploads, reads your credit balance, reads service info
- Verifies data items, including a strict mode most implementations do not have

## Use `@ardrive/turbo-sdk` instead if you need

Ethereum, KYVE or Polygon keys · a browser build or an
injected wallet · buying credits, promo codes, any payment flow · the CLI,
folder uploads, or ArDrive drive abstractions · packing your own bundles ·
streaming very large files.

This package signs one Arweave JWK and uploads bytes. If that is your case, it
brings nothing with it.

---

## Solana keys

```js
import { TurboUpload } from "@ardrive/turbo-upload";

const client = TurboUpload.production({ jwk: process.env.SOLANA_SECRET_KEY, token: "solana" });
```

Takes any form a Solana user actually holds: a base58 secret key as Phantom exports it, the JSON array `solana-keygen` writes, raw 64 bytes, or a bare 32-byte seed. `client.address` is the base58 Solana address.

A 64-byte key carries its own public key, and that half is checked rather than trusted. A key whose halves disagree is refused at construction, because signing with one produces items that verify nowhere and you find out after paying.

This is **ANS-104 signature type 4**, the same type `@ardrive/turbo-sdk` uses for `token: "solana"`, so the two produce identical ids for identical content. Type 4 signs the hex encoding of the signature data rather than the bytes; the library does that for you, and a test asserts it, because signing the raw bytes yields a valid signature over the wrong message.

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
| stream factories | a `Buffer`, `Uint8Array` or string. There is no streaming |
| `getBalance()` returns a signed-in account | `getBalance()` returns zeros for an unknown wallet, because the service answers `404` |
| errors arrive as `fetch failed` | typed errors that name the endpoint, the status and the method |
| any supported token | Arweave JWKs and Solana keys. Anything else throws at construction |

**Keep turbo-sdk** for the cases in § Use `@ardrive/turbo-sdk` instead if you need. Nothing stops both being
installed; they share no state.

## API

### `new TurboUpload(options)`

| option | default | notes |
|---|---|---|
| `jwk` | *required* | Arweave JWK, **an object or a JSON string** |
| `uploadUrl` | `https://upload.ardrive.io` | |
| `paymentUrl` | `https://payment.ardrive.io` | |
| `timeoutMs` | `60000` | **per request, not per call**. See § Bounding a call |
| `retry` | `{retries:3, minDelayMs:500, maxDelayMs:8000, retryStatuses:[408,429,500,502,503,504]}` | **partial**: override one field, keep the rest |
| `token` | `"arweave"` | or `"solana"`. Anything else throws immediately |
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

### `await client.upload({ data, tags?, target?, anchor?, signal?, timeoutMs? })`

Signs and uploads. Returns the service response plus `id`, `owner` and
`byteCount`. The returned `id` is **checked against the id computed locally from
our own signature**, and a mismatch throws rather than handing back an id you did
not produce.

### `client.sign({ data, tags?, target?, anchor? })` → `{ binary, id, idB64Url, signature }`

Signs without uploading.

### `await client.uploadSigned(item, { signal?, timeoutMs? })`

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

### `client.verify(binary, { strictSaltLength? })` → `boolean`

Structural and cryptographic verification. § The PSS salt length, and why it is
478 explains what `strictSaltLength` catches.

### Low-level exports

`signDataItem` · `verifyDataItem` · `createDataItem` · `parseDataItem` ·
`getSignatureData` · `deepHash` · `serializeTags` · `deserializeTags` ·
`signMessage` · `verifyMessage` · `idFromSignature` · `parseJwk` ·
`ownerFromJwk` · `addressFromOwner` · `publicKeyFromOwner`

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
this package had just uploaded.

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

Reimplementing the format rather than consuming it? [The conformance
spec](https://github.com/ardriveapp/turbo-upload/blob/main/conformance/spec.md) has the byte-level rules, including the two adjacent 32-byte
fields with opposite string conventions and the encoder quirks reproduced
bug-for-bug.

## Requirements

Node **>= 18.17.0** (global `fetch`, `AbortSignal.any`). Server-side only:
there is no browser build, and a JWK does not belong in a browser anyway.

## License

Apache-2.0
