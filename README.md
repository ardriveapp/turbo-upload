# @ardrive/turbo-upload

Sign [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)
data items with an Arweave JWK and upload them to a Turbo upload service.

**Zero runtime dependencies.** Not "few". Zero — `dependencies`,
`peerDependencies` and `optionalDependencies` are all empty, and a test in the
shipped suite fails the build if that ever changes. The only things it imports
are `node:crypto` and `node:buffer`.

```bash
npm install @ardrive/turbo-upload
```

```js
const { TurboUpload } = require("@ardrive/turbo-upload");

const client = new TurboUpload({ jwk: process.env.ARWEAVE_JWK });

const { id, winc } = await client.upload({
  data: Buffer.from("hello permanence"),
  tags: [{ name: "Content-Type", value: "text/plain" }],
});
// -> https://arweave.net/<id>
```

---

## Why this exists

`@ardrive/turbo-sdk` is the full-featured client, and it installs **344 packages
/ 892 MB** with **3 critical and 9 high** advisories at the time of writing —
including two private-key-extraction ones — because it bundles multi-chain
signing, wallet connectors and a CLI. When you are adding Arweave storage as a
backend to *someone else's* server, that dependency footprint is what gets the
pull request rejected.

This package does one thing completely, with nothing else in the tree.

## What it does

- Signs ANS-104 data items with an Arweave JWK (signature type 1, RSA-4096 / RSA-PSS-SHA256)
- Uploads them to a Turbo upload service (`POST /v1/tx`)
- Prices uploads, reads your credit balance, reads service info
- Verifies data items, including a strict mode most implementations do not have

## What it deliberately does **not** do

No multi-chain signing · no wallet connectors or browser build · no CLI · no
fiat top-ups, promo codes or payment flows · no bundle (multi-item) packing · no
file-streaming or chunked upload · no ArDrive/Arweave filesystem abstractions.

### When to use `@ardrive/turbo-sdk` instead

Reach for the official SDK — and accept the dependency tree — if you need to:

- sign with **Ethereum, Solana, KYVE, Polygon or any non-Arweave key**
- run **in a browser**, or connect an injected wallet
- **buy credits**, apply promo codes, or use any fiat/crypto payment flow
- use the **CLI**, upload **folders**, or use ArDrive drive/folder abstractions
- pack **multiple items into a bundle** yourself, or stream very large files

This package signs one Arweave JWK and uploads bytes. If that is your case, the
dependency count is 0 instead of 344.

---

## API

### `new TurboUpload(options)`

| option | default | notes |
|---|---|---|
| `jwk` | *required* | Arweave JWK, **an object or a JSON string** |
| `uploadUrl` | `https://upload.ardrive.io` | |
| `paymentUrl` | `https://payment.ardrive.io` | |
| `timeoutMs` | `60000` | per request, overridable per call |
| `retry` | `{retries:3, minDelayMs:500, maxDelayMs:8000, retryStatuses:[408,429,500,502,503,504]}` | **partial** — override one field, keep the rest |
| `token` | `"arweave"` | anything else throws immediately |
| `fetch` | global `fetch` | injectable for tests and proxies |

Everything is validated **in the constructor**, so a bad key is a startup error
that names the problem.

```js
const { TurboUpload, TESTNET } = require("@ardrive/turbo-upload");

const client = new TurboUpload({ jwk, ...TESTNET, timeoutMs: 30_000, retry: { retries: 5 } });
// or
const client = TurboUpload.testnet({ jwk });
```

### `await client.upload({ data, tags?, target?, anchor?, signal?, timeoutMs? })`

Signs and uploads. Returns the service response plus `id`, `owner` and
`byteCount`. The returned `id` is **checked against the id computed locally from
our own signature** — a mismatch throws rather than handing back an id you did
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

Service info, including the free-upload threshold — **107,520 bytes** at the time
of writing. It is read live from `/v1/info` rather than hardcoded here, because
it is service policy and will change. Items at or below it upload with no credit
balance at all.

### `client.verify(binary, { strictSaltLength? })` → `boolean`

Structural and cryptographic verification. See the salt-length note below for
what `strictSaltLength` catches.

### Low-level exports

`signDataItem` · `verifyDataItem` · `createDataItem` · `parseDataItem` ·
`getSignatureData` · `deepHash` · `serializeTags` · `deserializeTags` ·
`signMessage` · `verifyMessage` · `idFromSignature` · `parseJwk` ·
`ownerFromJwk` · `addressFromOwner` · `publicKeyFromOwner`

Constants: `MAX_TAG_BYTES` (4096) · `MIN_ITEM_SIZE` (1044) ·
`PSS_SALT_LENGTH_BYTES` (478) · `PRODUCTION` · `TESTNET` · `DEFAULT_TIMEOUT_MS`.

### Types

Hand-written `index.d.ts` — no `typescript` dependency, no `@types/*`.

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
| `TurboKeyError` | bad/missing/non-RSA-4096 JWK | — |
| `TurboConfigError` | bad option or unsupported token | — |
| `TurboValidationError` | bad arguments to a call | — |
| `TurboNetworkError` | no response at all (DNS, TLS, reset) | `endpoint`, `method`, `cause` |
| `TurboTimeoutError` | exceeded `timeoutMs`, or caller aborted | `endpoint`, `timeoutMs`, `cause` |
| `TurboHTTPError` | non-2xx | `status`, `endpoint`, `method`, `body` |
| `TurboVerificationError` | the service returned an id we did not sign | `expectedId`, `receivedId` |

```
TurboHTTPError: POST https://upload.ardrive.io/v1/tx failed: HTTP 402 Payment Required
  — {"error":"Insufficient balance"}
```

rather than a bare `fetch failed`.

---

## Endpoints

Exported as named constants so nobody has to guess a hostname.

| | upload | payment | gateway |
|---|---|---|---|
| `PRODUCTION` | `https://upload.ardrive.io` | `https://payment.ardrive.io` | `https://arweave.net` |
| `TESTNET` | `https://upload.services.ar-io.dev` | `https://payment.services.ar-io.dev` | `https://ar-io.dev` |

> **The testnet hostnames contain `.services.`** — this matters, and it is why
> they are constants rather than documentation:
>
> - `upload.ar-io.dev` (without `.services.`) **resolves** and serves an HTML SPA
>   on every path including `/v1/tx`, so you get a `200` with an HTML body rather
>   than an obvious failure.
> - The published `@ardrive/turbo-sdk` ships `upload.ardrive.dev` /
>   `payment.ardrive.dev` as its development configuration, and both are
>   **NXDOMAIN**.

Uploads to `PRODUCTION` are permanent and cost real money.

---

## The PSS salt length, and why it is 478

This is the single most important correctness detail in the package, and the one
most likely to be "fixed" into a bug.

ANS-104 says RSA-PSS and stops. The reference implementation (arbundles) signs
through Node without setting `saltLength`, and **Node's default for signing is
`RSA_PSS_SALTLEN_MAX_SIGN`** — the maximum the modulus allows:

```
emBits = 4096 - 1 = 4095
emLen  = ceil(4095/8) = 512
sLen   = emLen - hLen - 2 = 512 - 32 - 2 = 478 bytes
```

Almost every other crypto library defaults PSS to the **digest length, 32**.

The trap is that **getting this wrong does not fail loudly.** Verification is
salt-agnostic: arbundles verifies through arweave.js, which also passes no
`saltLength`, and Node's default for *verifying* is `RSA_PSS_SALTLEN_AUTO`, which
recovers the length from the encoded message and accepts **any** value. (Both
constants are literally `-2`, which is how one omitted parameter means "maximum"
when signing and "anything" when verifying.)

So a 32-byte-salt signature passes round-trip tests, passes cross-verification
against the reference, and **is accepted by the live service today**. It would
only fail later, at a stricter verifier.

This package therefore sets 478 **explicitly** rather than inheriting a default,
and the test suite **recovers the salt length off the wire** — computing
`sig^e mod n`, unmasking the DB with MGF1 and counting the bytes — instead of
trusting the flag. `client.verify(item, { strictSaltLength: true })` applies the
same strictness when verifying.

---

## Conformance

The package ships **22 conformance vectors** in `vectors/vectors.json`, generated
from `@dha-team/arbundles@1.0.4` — the de-facto reference that the gateways and
bundlers actually run — and the test suite ships with it, so you can re-prove all
of this from your own `node_modules`:

```bash
npm test --prefix node_modules/@ardrive/turbo-upload
```

The vectors pin the exact unsigned item bytes, the deep-hash transcript chunk by
chunk, every field offset, the serialized tag region and a reference-produced
signature per vector that must verify here. They cover the degenerate 1044-byte
item, target/anchor presence combinations, unicode and empty and duplicate tags,
the 64/65-byte encoder threshold, the 64-tag varint boundary, and the maximum tag
set.

No private key ships with this package: the corpus carries only the public
modulus, and the signing tests generate an ephemeral key at runtime.

Some things worth knowing if you reimplement this format:

- **`target` is base64url-decoded; `anchor` is taken as raw bytes.** Two adjacent
  32-byte fields, opposite string conventions. A 43-character base64url anchor
  throws.
- **An empty tag list serializes to zero bytes**, not to a `0x00` terminator.
- **`MAX_TAG_BYTES` (4096) is a cap on the serialized byte length**, not the tag
  count, and applies on read as well as write.
- **Absent target/anchor are zero-length elements in the deep hash**, not omitted
  ones — the list is always 8 long.
- **Three hash functions in one operation**: SHA-384 for the transcript, SHA-256
  for the signature digest, SHA-256 for the id.
- **`id = SHA-256(signature)`** — so ids are randomised and not reproducible from
  the inputs.
- Tag strings go through arbundles' hand-rolled UTF-8 encoder below 64 bytes,
  which writes unpaired UTF-16 surrogates as WTF-8. Reproduced here bug-for-bug,
  because the alternative is a different id for the same input.

---

## Requirements

Node **>= 18.17.0** (global `fetch`, `AbortSignal.any`). Server-side only —
there is no browser build, and a JWK does not belong in a browser anyway.

## License

Apache-2.0
