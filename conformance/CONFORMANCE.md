# ANS-104 conformance vectors + zero-dependency reference signer

A language-neutral conformance corpus for **ANS-104 data items, signature type 1**
(Arweave, RSA-4096 / RSA-PSS-SHA256), plus a reference signer that uses nothing but
`node:crypto` and `node:buffer`.

**Why it exists.** We want to replace a 344-package / 892 MB SDK carrying 3 critical CVEs
with a minimal package that signs data items. Before writing that package we needed proof
that a reimplementation can be **byte-correct**. This is that proof, and it is deliberately
language-neutral so a Python, Rust, Go or Java implementation can use the same vectors.

Current status: **22 vectors, 545 assertions, all green** against
`@dha-team/arbundles@1.0.4`.

---

## Files

| file | what it is |
|---|---|
| [`spec.md`](spec.md) | **Read this first.** The implementable spec: byte layout, tag encoding, deep hash, RSA-PSS parameters, id derivation, and every place ANS-104 is ambiguous and arbundles is the de-facto answer. |
| [`vectors.json`](vectors.json) | The corpus. Everything hex-encoded, no Node required to consume it. |
| [`reference-signer.js`](reference-signer.js) | **Zero runtime dependencies.** `node:crypto` + `node:buffer` only. Never imports arbundles. |
| [`verify.js`](verify.js) | The test. Checks the reference implementation against the corpus *and* cross-verifies both ways against arbundles. |
| [`generate-vectors.js`](generate-vectors.js) | Regenerates `vectors.json` from `cases.js` using arbundles as the reference. |
| [`cases.js`](cases.js) | The corpus definition — pure data, one entry per case, with the rationale for each. |
| [`arbundles.js`](arbundles.js) | Loader shim that works around arbundles' undeclared `axios` dependency. See below. |
| [`test-key.json`](test-key.json) | **THROWAWAY RSA-4096 key.** Generated for this corpus, checked in deliberately, published in the clear. Never use it for anything. Regenerate with `node gen-key.js`. |
| [`standalone-check.js`](standalone-check.js) | Isolation test: the reference signer against the corpus with **no `node_modules` anywhere on the resolution path**. Proves the zero-dependency claim. |
| `probe-*.js` | The empirical probes behind the spec's claims: salt length, the UTF-8 encoder split, presence-byte handling. Kept as evidence. |

---

## Running it

Node ≥ 18. The corpus itself has **no dependencies**; only the cross-check needs arbundles.

```bash
node verify.js                      # the whole suite
node verify.js one-tag unicode-tags # just these vectors
node generate-vectors.js            # regenerate vectors.json
node probe-salt.js                  # the salt-length determination, standalone
node standalone-check.js            # reference signer vs corpus, zero dependencies
```

`standalone-check.js`, `reference-signer.js`, `vectors.json` and `test-key.json` are the
complete zero-dependency subset: copy those four into an empty directory with no
`node_modules` and `node standalone-check.js` passes.

`verify.js` exits non-zero on any failure.

`arbundles.js` resolves arbundles at `../minimal/node_modules/@dha-team/arbundles` by
default. Point it elsewhere with `ARBUNDLES_ROOT=/path/to/build/node/cjs/src`.

### What `verify.js` actually checks

**Direction 1 — the corpus.** For every vector, `reference-signer.js` must reproduce the
serialized tag bytes, the raw target/anchor/data, every field offset, the full unsigned
item, its SHA-256, a key-independent skeleton hash, the eight deep-hash input chunks, and
the deep hash itself. Byte for byte.

**Direction 2 — cross-verification.** This is the check that matters. Equal deep hashes
are necessary but not sufficient.

- an item signed by **us** verifies under **arbundles'** verifier
- an item signed by **arbundles** verifies under **ours**
- the pinned sample signature verifies under both, and both derive the same id
- three tamper mutations (data byte, tag byte, signature byte) are rejected by both

**Plus** the global invariants: RSA-PSS is randomised (both implementations), the salt
length is recovered from the encoded message and asserted to be 478, the five malformed
inputs throw in both, and the strict-UTF-8 divergence is quantified.

---

## Using `vectors.json` from Python, Rust, or anything else

No Node needed. Every byte string in the file is **lowercase hex**; every hash is hex;
`target_b64url` is standard base64url without padding.

### Structure

```
{
  "signature_type": { ... },   # algorithm, salt length, widths — the parameters, in one place
  "deep_hash":      { ... },   # the two hashing rules, restated
  "key":            { ... },   # the throwaway key's modulus, base64url
  "limits":         [ ... ],   # malformed inputs and the errors the reference raises
  "vectors":        [ ... ]
}
```

Each vector:

```
{
  "name": "unicode-tags",
  "description": "why this case exists and what it catches",

  "input": {
    "data_hex":       "...",         # the payload, hex
    "data_utf8":      "..." | null,  # convenience only; null when the data is not valid UTF-8
    "tags":           [ {"name": "...", "value": "..."} ],
    "tags_hex":       [ {"name_hex": "...", "value_hex": "..."} ],   # authoritative
    "target_b64url":  "..." | null,
    "anchor_utf8":    "..." | null,
    "anchor_hex":     "..." | null   # authoritative: the anchor is RAW BYTES, not base64url
  },

  "expected": {                      # all deterministic — assert equality on all of it
    "tag_bytes_hex":              "...",   # the serialized tag region
    "raw_target_hex":             "...",   # "" when absent
    "raw_anchor_hex":             "...",
    "raw_data_hex":               "...",
    "offsets":                    { ... }, # every field offset and the total length
    "unsigned_item_hex":          "...",   # the complete item, signature region zeroed
    "unsigned_item_sha256":       "...",
    "keyless_skeleton_sha256":    "...",   # signature AND owner zeroed — key-independent
    "deep_hash_input_chunks_hex": [ 8 strings ],  # the exact deep-hash inputs, in order
    "deep_hash_hex":              "..."    # 48 bytes: THE MESSAGE THAT GETS SIGNED
  },

  "encoding": {                      # is arbundles' tag encoding standard UTF-8 here?
    "strict_utf8_tag_bytes_match": true|false,
    "strict_utf8_tag_bytes_hex":   null | "..."
  },

  "sample_signature": {              # NOT an equality target — see below
    "signature_hex": "...", "id_hex": "...", "id_b64url": "..."
  }
}
```

### What you can and cannot assert

**Assert equality on everything under `expected`.** It is fully deterministic.

**Do not assert equality on signatures or ids.** RSA-PSS draws a fresh random salt per
signature, so signing identical input twice produces different bytes and a different id.
`verify.js` re-confirms this on every run. `sample_signature` is a **verifier fixture**:
splice `signature_hex` into `unsigned_item_hex` at byte offset 2 and you have a valid
signed item to test your verifier against.

### Suggested order of attack

1. **`tag_bytes_hex`** — the Avro tag encoder. Most bugs live here, and it needs no crypto.
2. **`unsigned_item_hex`** and **`offsets`** — the container layout.
3. **`deep_hash_input_chunks_hex`** — if this matches and `deep_hash_hex` does not, your
   deep-hash function is wrong. If a chunk is wrong, your layout is wrong. This split is
   the fastest way to localise a failure.
4. **`deep_hash_hex`** — the SHA-384 transcript.
5. **Verification** — verify each `sample_signature` against the corresponding
   `unsigned_item_hex`.
6. **Signing** — sign, then verify with your own verifier, then confirm your salt length is
   478 by recovering it from the encoded message. Do not skip this: a wrong salt length
   still verifies against the reference (see `spec.md` §5.3).

`keyless_skeleton_sha256` lets you check the field layout with your **own** key: build the
item, zero bytes `[2, 1026)` (signature and owner), SHA-256 the result.

---

## The three things that will break your implementation

Detail and evidence in [`spec.md`](spec.md); the short version:

1. **The PSS salt length is 478, not 32.** It is `RSA_PSS_SALTLEN_MAX_SIGN`
   (`emLen - hLen - 2 = 512 - 32 - 2`), because arbundles never sets `saltLength` and
   Node's signing default is the maximum. Most libraries default to the digest length.
   **Verification is salt-agnostic, so getting this wrong does not fail loudly** — a
   32-byte-salt signature verifies fine under arbundles.
2. **`anchor` is raw bytes; `target` is base64url.** Same 32-byte width, adjacent fields,
   opposite string conventions, in the same function.
3. **arbundles' tag encoder is not standard UTF-8 for unpaired surrogates** in strings
   under 64 bytes: it emits WTF-8 (`ED A0 80`) where standard UTF-8 emits `EF BF BD`.
   21 of 22 vectors are byte-identical under strict UTF-8; the 22nd exists to show this.
   Rust and Go strings cannot hold an unpaired surrogate, so this cannot bite them; Python
   `str` can.

---

## A bug in arbundles you should know about regardless

`require("@dha-team/arbundles")` **throws on a clean install**:

```
Error: Cannot find module 'axios'
Require stack:
  .../build/node/cjs/src/file/FileDataItem.js
  ... -> .../build/node/cjs/index.js
```

`axios` is in neither `dependencies`, `peerDependencies` nor `optionalDependencies` of
`@dha-team/arbundles@1.0.4`, and the package index unconditionally loads the filesystem
helpers that need it. The obvious workaround also fails: the package's `"./*"` export map
rewrites subpaths to `"./*.js"`, so
`require("@dha-team/arbundles/build/node/cjs/index.js")` resolves to `index.js.js`.

[`arbundles.js`](arbundles.js) works around both by requiring the compiled CJS modules
under `build/node/cjs/src/` through an absolute filesystem path, which never touches
`./file/`. No `axios` install required.

---

## Scope

- Single data items only. Bundles (the ANS-104 container that packs many items into one
  Arweave transaction) are not covered.
- Signature type 1 only. Types 2–7 and 101 exist and have different key and signature
  widths; the layout in `spec.md` §1 generalises, the crypto does not.
- Nothing here talks to the network. Whether the Arweave gateway accepts a non-maximum PSS
  salt length is **untested** — it needs a live endpoint. See `spec.md` §5.3.
