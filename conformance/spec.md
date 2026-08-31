# ANS-104 data-item signing, signature type 1 — an implementable spec

Scope: producing and verifying a **single ANS-104 data item** signed with **signature
type 1 (`arweave`, RSA-4096 / RSA-PSS-SHA256)**. Bundles (the container that packs many
data items into one Arweave transaction) are out of scope.

This document is written so that a Python, Rust, Go or Java implementation needs nothing
else. Everything asserted here is pinned by [`vectors.json`](vectors.json) and checked by
[`verify.js`](verify.js) against `@dha-team/arbundles@1.0.4`, which is the de-facto
reference implementation of this format.

> **Where ANS-104 is silent or ambiguous, arbundles' behaviour is the answer**, because
> that is what the gateways and bundlers actually run. Those places are called out inline
> as **DE-FACTO** and collected in §9. They are where reimplementations break.

---

## 1. Byte layout

All multi-byte integers in the *container* are **unsigned little-endian**. (The integers
inside the tag region are a different encoding — see §3.)

| Field | Offset | Width | Notes |
|---|---|---|---|
| `signature_type` | 0 | 2 | little-endian u16. `1` for Arweave/RSA. |
| `signature` | 2 | 512 | raw RSA-PSS signature, big-endian, left-padded to the modulus size |
| `owner` | 514 | 512 | the RSA **modulus** `n`, big-endian. See §6. |
| `target_presence` | 1026 | 1 | `0x00` absent, `0x01` present |
| `target` | 1027 | 32 | present only if the presence byte is `0x01` |
| `anchor_presence` | 1026 + T | 1 | `T` = 1 if target absent, 33 if present |
| `anchor` | 1027 + T | 32 | present only if the presence byte is `0x01` |
| `tag_count` | 1026 + T + A | 8 | little-endian u64. `A` = 1 or 33. |
| `tag_bytes_len` | +8 | 8 | little-endian u64, byte length of the tag region |
| `tags` | +16 | `tag_bytes_len` | see §3 |
| `data` | +16+`tag_bytes_len` | to end of item | opaque bytes |

The 512/512 widths are specific to signature type 1; other types have different
`signature_length` / `owner_length` and every offset above shifts accordingly.

**Smallest possible item: 1044 bytes** — `2 + 512 + 512 + 1 + 1 + 16 + 0` — with no
target, no anchor, no tags, no data. Vector `empty-data-empty-tags` pins it.

The presence bytes are read as `== 1`. **DE-FACTO:** arbundles treats any byte that is
not exactly `0x01` as *absent* — measured for `0x00`, `0x02` and `0xFF` — so a `0x02` in
the target presence byte silently reinterprets the following 32 bytes as the start of the
anchor field and every later offset moves. Write only `0x00` or `0x01`, and read anything
else as absent, which is what makes such an item fail signature verification rather than
parse differently in two implementations.

There is **no length prefix and no `id` field** on the wire. The item's length is implied
by its container, and the id is derived (§7).

### 1.1 Offsets are chained, not fixed

`tag_count` sits at a different absolute offset depending on whether target and anchor are
present. Compute the offsets by walking the presence bytes; never hardcode past byte 1026.
Vectors `target-present`, `anchor-present`, `target-and-anchor` and `everything-present`
exist to catch exactly this.

---

## 2. Optional fields: target and anchor

Both are **exactly 32 bytes** when present.

- **`target`** is an Arweave address — a 32-byte value conventionally written as a 43-char
  base64url string. When an API takes a string, it is **base64url-decoded**.
- **`anchor`** is 32 arbitrary bytes used for replay protection.

> **DE-FACTO — the asymmetry that catches everyone.** arbundles decodes `target` from
> base64url but takes `anchor` as **raw bytes**: `Buffer.from(opts.anchor)`, i.e. the
> string's UTF-8 encoding. So a 32-*character* ASCII anchor works and a 43-character
> base64url anchor throws `Anchor must be 32 bytes`. Two adjacent fields of the same
> width, two different string conventions, in one function. See `cases.js` and the
> `limits` block of `vectors.json`.

In the deep hash (§4) an **absent** target or anchor contributes a **zero-length byte
string**, not a skipped element. The list is always 8 elements long.

---

## 3. Tag encoding

The tag region is the **Avro binary encoding** of `array<record{name:string, value:string}>`.

```
tags   := zigzag_varint(count)  block*  zigzag_varint(0)
block  := string(name) string(value)
string := zigzag_varint(utf8_byte_length) utf8_bytes
```

- One block per tag, `count` blocks in a single Avro array block, then a **single `0x00`
  terminator** for the zero-length end-of-array block.
- **An empty tag list serializes to ZERO bytes**, not to a bare `0x00`. `tag_count` is 0
  and `tag_bytes_len` is 0 and the region is empty. (This is arbundles' `createData`
  short-circuiting before it ever calls the serializer. `serializeTags([])` in isolation
  also returns an empty buffer.)
- Tag **order is preserved** and never normalised. Duplicate names are legal
  (`duplicate-tag-names`).
- Empty names and empty values are both legal (`empty-tag-name`, `empty-tag-value`,
  `empty-name-and-value` → the whole region is `02 00 00 00`).

### 3.1 Zigzag varint

```
encode(n): m = n >= 0 ? 2n : -2n - 1
           while m >= 128: emit((m & 0x7f) | 0x80); m = floor(m / 128)
           emit(m)
```

So `1 → 0x02`, `5 → 0x0a`, `12 → 0x18`, `64 → 0x80 0x01`. The tag count crosses into two
bytes at 64 tags — vector `tag-count-varint-boundary` pins `80 01`.

### 3.2 The declared length is the UTF-8 **byte** length

Not the character count, not the UTF-16 code-unit count. Vector `unicode-tags` covers
Latin-1 accents, CJK, Cyrillic and astral-plane emoji (`🎉` is 4 bytes).

### 3.3 DE-FACTO — arbundles has two UTF-8 encoders and they disagree

`AVSCTap.writeString` branches on the string's UTF-8 byte length:

- **`byteLength <= 64`** → a hand-rolled encoding loop.
- **`byteLength > 64`** → `Buffer.prototype.write(s, ..., "utf8")`.

For every **well-formed** string the two agree, and both agree with standard UTF-8.
Vectors `tag-value-64-bytes` and `tag-value-65-bytes` sit either side of the threshold and
pin that.

They **disagree on an unpaired UTF-16 surrogate**:

| input | path | arbundles emits | standard UTF-8 emits |
|---|---|---|---|
| `"\uD800"` (3 bytes declared) | `<= 64` | `ED A0 80` (raw code point, WTF-8) | `EF BF BD` (U+FFFD) |
| `"\uD800" + 67 chars` | `> 64` | `EF BF BD` | `EF BF BD` |

The **declared length is `Buffer.byteLength` (3) in both cases**, which happens to equal
the width of both encodings, so nothing desynchronises and nothing errors. The item is
structurally valid, verifies fine, and simply has a **different id** from the one another
implementation would produce for the same logical input.

Vectors `lone-surrogate-tag-short` and `lone-surrogate-tag-long` pin both sides, and
`vectors.json` records `encoding.strict_utf8_tag_bytes_hex` wherever arbundles' bytes are
not standard UTF-8.

**What an implementer should do.** Rust `String` and Go `string` cannot hold an unpaired
surrogate, so **use your language's standard UTF-8 encoder and the divergence cannot
arise**. Python `str` *can* hold one (`"\ud800"`, and `surrogatepass` will encode it as
`ED A0 80`) — so a Python implementation should either reject unpaired surrogates in tag
strings up front, or deliberately mirror the table above. Do not let it happen by
accident: 21 of the 22 vectors are byte-identical under strict UTF-8, and the 22nd is the
whole point.

### 3.4 Size cap

`tag_bytes_len` must be **≤ 4096** (`MAX_TAG_BYTES`). arbundles throws
`Too many tag bytes (N > 4096)` on write, and `DataItem.verify` returns `false` on read.
The cap is on the **serialized byte length**, not the tag count. Vector `max-tag-set`
fills the region to 2793 bytes with 90 tags.

A verifier must **also** re-parse the tag region and confirm the recovered tag count
equals the declared `tag_count`, rejecting the item if it does not.

---

## 4. The deep hash — what actually gets signed

The signed message is **not** the item bytes. It is a 48-byte SHA-384 digest computed over
a structured transcript, so that field boundaries cannot be shifted without changing the
digest.

```
deepHash(blob b)  = SHA384( SHA384("blob" || ascii_decimal(len(b))) || SHA384(b) )

deepHash(list L)  = acc = SHA384("list" || ascii_decimal(len(L)))
                    for each child c in L:  acc = SHA384( acc || deepHash(c) )
                    return acc
```

`"blob"` and `"list"` are the literal ASCII bytes; the length is its **decimal ASCII
representation** (`0` → `"0"`, `512` → `"512"`), concatenated with no separator. So the
tag for a 512-byte blob is the 7 bytes `blob512`.

The message for a data item is `deepHash` of this **8-element list, in this order**:

| # | element | bytes |
|---|---|---|
| 1 | `"dataitem"` | 8, ASCII |
| 2 | `"1"` | 1, ASCII — the **format version**, always `"1"` |
| 3 | `signature_type` as decimal ASCII | 1 for type 1 — `"1"` |
| 4 | `owner` | 512 |
| 5 | `target` | 32, or **0 if absent** |
| 6 | `anchor` | 32, or **0 if absent** |
| 7 | `tags` (the serialized region) | `tag_bytes_len`, or 0 |
| 8 | `data` | any length, may be 0 |

Elements 2 and 3 are both the ASCII string `"1"` for signature type 1, and they are
different things. Element 2 is the *ANS-104 format version*; element 3 is the *signature
type*, stringified in **decimal**, not written as a byte.

For a data item with no target, no anchor, no tags and no data the chunk widths are
`[8, 1, 1, 512, 0, 0, 0, 0]` — see `deep_hash_input_chunks_hex` in every vector, which is
the fastest way to localise a bug.

**DE-FACTO:** ANS-104 describes the deep hash informally; the SHA-384 choice, the
`"blob"`/`"list"` tags and the decimal-ASCII lengths are all defined only by the reference
code. Note the asymmetry: **the transcript is SHA-384, the signature digest is SHA-256,
and the id is SHA-256.** Three different hash usages in one operation.

---

## 5. Signature — RSA-PSS

| parameter | value |
|---|---|
| algorithm | RSASSA-PSS |
| modulus | 4096 bits (512 bytes) |
| public exponent | 65537 (`AQAB`) — **not carried on the wire**, see §6 |
| message digest | SHA-256 |
| MGF | MGF1 with SHA-256 |
| **salt length** | **478 bytes** (`RSA_PSS_SALTLEN_MAX_SIGN`) |
| trailer | `0xBC` (standard) |
| signature length | 512 bytes |

The message passed to the signer is the **48-byte deep hash from §4**, which is then
hashed *again* with SHA-256 by the PSS construction. Do not pre-hash it yourself and do
not sign the item bytes.

### 5.1 The salt length, which is the interop hazard

arbundles signs with Node's

```js
createSign("sha256").update(msg).sign({ key, padding: RSA_PKCS1_PSS_PADDING })
```

and **does not set `saltLength`**. Node's default for *signing* is
`RSA_PSS_SALTLEN_MAX_SIGN`, **not** `RSA_PSS_SALTLEN_DIGEST`. The maximum is

```
emBits = modBits - 1 = 4095
emLen  = ceil(emBits / 8) = 512
sLen   = emLen - hLen - 2 = 512 - 32 - 2 = 478
```

**478 bytes**, verified empirically by recovering the encoded message
(`sig^e mod n` with no padding removal) and unmasking the DB — see the `[global]` section
of `verify.js`, which re-derives it on every run.

Most crypto libraries default PSS to the **digest length (32)**. An implementation that
takes that default produces a structurally valid, verifiable signature that is
**478 vs 32 bytes of salt away** from what the reference produces. Set it explicitly:

| library | how to get 478 |
|---|---|
| Node `crypto` | `saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN` (or omit it) |
| Python `cryptography` | `padding.PSS(mgf=MGF1(SHA256()), salt_length=padding.PSS.MAX_LENGTH)` |
| Rust `rsa` | the PSS variant taking an explicit salt length; pass 478 |
| Go `crypto/rsa` | `&rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthAuto, Hash: crypto.SHA256}` — Go's "Auto" means *maximum* when signing |
| OpenSSL CLI | `-sigopt rsa_pss_saltlen:max` |

Whatever the API, **assert the result rather than trusting the flag**: sign a known
message, compute `sig^e mod n` with no padding removal, unmask the DB with MGF1 and count
the salt bytes. `verify.js` does exactly that on every run, in about 20 lines.

### 5.2 Signatures are not reproducible

PSS draws a fresh random salt per signature. **Signing identical input twice yields
different bytes, and therefore a different id.** `verify.js` asserts this on every run for
both implementations. This is why `vectors.json` pins the deep hash, the tag bytes and the
unsigned item bytes, and explicitly does **not** pin signatures or ids as expectations.
The `sample_signature` block in each vector is a one-off fixture for testing a *verifier*.

### 5.3 Verification is more permissive than signing

arbundles verifies through arweave.js's node driver, which likewise passes **no**
`saltLength` — and Node's default for *verification* is `RSA_PSS_SALTLEN_AUTO`, which
recovers the salt length from the encoded message and accepts **any** value. In Node both
constants are literally `-2`, which is how one omitted parameter means "maximum" on the
signing side and "anything" on the verifying side.

Measured consequence: **a signature made with a 32-byte salt verifies fine under
arbundles.** So a reimplementation that gets §5.1 wrong will pass a naive round-trip test
against the reference and still be non-conformant. Cross-verification alone does not catch
it; the explicit salt-length recovery in `verify.js` does.

> **Unresolved.** Whether the Arweave gateway and node accept a non-maximum salt length was
> not tested here — it needs a live endpoint. Until someone checks, **emit the maximum
> salt length**, which is what every existing producer emits.

---

## 6. Owner, and the missing public exponent

The 512-byte `owner` field is the RSA **modulus only**. The public exponent is not on the
wire. Every implementation reconstructs the public key as

```
{ kty: "RSA", n: <owner, base64url>, e: "AQAB" }
```

i.e. **e = 65537, hardcoded**. A key with any other exponent cannot be represented in this
format and its items will not verify. Arweave wallet JWKs always use 65537.

The **wallet address** (distinct from the data-item id) is `base64url(SHA-256(owner))`.

---

## 7. The id

```
id = SHA-256( signature )          // the 512 raw signature bytes
```

Base64url-encoded (no padding) for display; 43 characters. It is a hash of the
**signature**, not of the item and not of the deep hash — which is why the id inherits
PSS's randomness and is not reproducible from the inputs alone.

---

## 8. Algorithms

### Sign

1. Serialize the tags (§3).
2. Lay out the item with the signature region **all zeroes** (§1).
3. Compute the deep hash over the 8-element list (§4).
4. Sign it with RSA-PSS-SHA256, salt length 478 (§5).
5. Write the 512 signature bytes at offset 2.
6. `id = SHA-256(signature)`.

### Verify

1. Length ≥ 80, else reject.
2. Read `signature_type`; reject unknown types.
3. Walk the presence bytes to resolve all offsets (§1.1).
4. Reject if `tag_bytes_len > 4096`.
5. If `tag_count > 0`, re-parse the tag region and reject unless the recovered tag count
   equals `tag_count`.
6. Rebuild the public key from `owner` with `e = 65537` (§6).
7. Recompute the deep hash and verify the signature over it.

Step 5 matters: without it, a tag region that decodes to a different number of tags than
declared is accepted, and two implementations disagree about what the item says while both
agree the signature is valid.

---

## 9. Every de-facto behaviour, collected

Ranked by how likely it is to bite.

1. **PSS salt length is 478 (maximum), not 32 (digest).** ANS-104 says "RSA-PSS" and stops.
   Verification is salt-agnostic, so this does not fail loudly. §5.1.
2. **`anchor` is raw bytes; `target` is base64url.** Same width, adjacent fields, opposite
   string conventions. §2.
3. **The tag encoder is not standard UTF-8 for unpaired surrogates, below 64 bytes.** §3.3.
4. **Empty tag list ⇒ zero tag bytes**, not a `0x00` terminator. §3.
5. **`MAX_TAG_BYTES = 4096` is on the serialized length**, not the tag count, and it is a
   hard limit on both write and read. It is not in the ANS-104 text. §3.4.
6. **Absent target/anchor are zero-length elements in the deep hash**, not omitted
   elements. The list is always 8 long. §4.
7. **The signature type is hashed as decimal ASCII**, not as its little-endian bytes. §4.
8. **The public exponent is assumed to be 65537.** §6.
9. **Presence bytes are tested `== 1`**, so any other non-zero value silently means
   "absent" and shifts the parse. §1.
10. **Empty tag names are legal** and round-trip. A validator that rejects them will reject
    items the reference happily produces. §3.
11. **Three hash functions in one operation:** SHA-384 for the transcript, SHA-256 for the
    signature digest, SHA-256 for the id. §4, §5, §7.
12. **Tag order is significant** and is never sorted; duplicate names are legal. §3.

---

## 10. Known bug in the reference implementation

`require("@dha-team/arbundles")` **throws on a clean install**:

```
Error: Cannot find module 'axios'
Require stack:
  .../build/node/cjs/src/file/FileDataItem.js
  .../build/node/cjs/src/file/FileBundle.js
  .../build/node/cjs/src/file/bundleData.js
  .../build/node/cjs/src/file/index.js
  .../build/node/cjs/index.js
```

`axios` is in neither `dependencies`, `peerDependencies` nor `optionalDependencies` of
`@dha-team/arbundles@1.0.4`. The package index unconditionally pulls in the filesystem
helpers, which need it.

Worse, the package's `"./*"` export map rewrites subpaths to `"./*.js"`, so the obvious
workaround `require("@dha-team/arbundles/build/node/cjs/index.js")` resolves to
`index.js.js` and also fails.

[`arbundles.js`](arbundles.js) works around both by requiring the individual compiled CJS
modules under `build/node/cjs/src/` through an absolute filesystem path, which never
touches `./file/`. No `axios` install is needed. This is worth knowing independently of
this corpus: it means **`@dha-team/arbundles` cannot be imported at all** without either
installing an undeclared dependency or bypassing its own entry point.
