# ANS-104 conformance corpus

The evidence behind `@ardrive/turbo-upload`: proof that this package's signing is
byte-identical to the de-facto reference implementation (`@dha-team/arbundles`)
without depending on it.

- **`spec.md`** — the implementable spec. Byte layout, Avro tag encoding, the deep
  hash, RSA-PSS parameters, id derivation, and §9: every de-facto behaviour where
  ANS-104 is ambiguous and arbundles is the answer. **Read this first** if you are
  porting to Python, Rust or Go.
- **`vectors.json`** — 22 vectors covering unicode tags, lone surrogates, the
  64/65-byte encoder boundary, empty names and values, binary data, tag-count
  varint boundaries, and every `target`/`anchor` combination. The authoritative
  copy the package tests against lives in [`../vectors/`](../vectors/).
- **`reference-signer.js`** — zero-dependency reference (`node:crypto` only).
- **`verify.js`** — 545 assertions, two-way cross-verified against arbundles.
- **`roundtrip.js` / `salt-test.js`** — live testnet probes.

## There is deliberately no private key here

`gen-key.js` regenerates one. It is not committed, because a JWK containing `d`
in a repository that may become public is exactly what every secret scanner is
built to find — and `test/zero-deps.test.js` fails the build if one appears.

Regenerating a key means regenerating the corpus with it: the vectors pin deep
hashes derived from a specific public modulus, so a new key produces a new,
equally valid corpus. Run `node gen-key.js && node generate-vectors.js`.

## The one detail most likely to be "simplified" by mistake

**Emit a 478-byte PSS salt**, not the conventional digest length of 32. Both are
currently accepted by the upload service, so the wrong choice passes every test
anyone would think to run — self-verify, cross-verify against arbundles, and a
live upload — and only surfaces later, at a stricter verifier, on data that is
already permanent and paid for. Only explicit salt recovery catches it, which is
why `verify.js` has a dedicated check.
