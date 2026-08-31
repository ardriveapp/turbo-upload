"use strict";
/**
 * generate-vectors.js — emit vectors.json using @dha-team/arbundles as the reference.
 * This file is the ONLY place arbundles produces expected values. reference-signer.js
 * never sees it.
 *
 *   node generate-vectors.js
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const arb = require("./arbundles.js");
const cases = require("./cases.js");

const jwk = require("./test-key.json");
const signer = new arb.ArweaveSigner(jwk);
const OWNER = Buffer.from(jwk.n, "base64url");
const SIG_LEN = 512, OWNER_LEN = 512;

const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

/** Recompute field offsets from a serialized item, independently of arbundles' privates. */
function offsetsOf(bin) {
  const targetStart = 2 + SIG_LEN + OWNER_LEN;
  const targetPresent = bin[targetStart] === 1;
  const anchorStart = targetStart + (targetPresent ? 33 : 1);
  const anchorPresent = bin[anchorStart] === 1;
  const tagsStart = anchorStart + (anchorPresent ? 33 : 1);
  const tagBytesLen = Number(bin.readBigUInt64LE(tagsStart + 8));
  return {
    signature_type: 0,
    signature: 2,
    owner: 2 + SIG_LEN,
    target_presence_byte: targetStart,
    anchor_presence_byte: anchorStart,
    tags_start: tagsStart,
    data_start: tagsStart + 16 + tagBytesLen,
    total_length: bin.length,
  };
}


/**
 * A deliberately naive, self-contained Avro tag serializer using the platform's
 * STANDARD UTF-8 encoder — i.e. what a Python/Rust/Java implementer writes without
 * knowing about arbundles' internals. Used only to detect divergence, never as the
 * expected value.
 */
function strictUtf8Tags(tags) {
  if (!tags || !tags.length) return Buffer.alloc(0);
  const out = [];
  const varint = (n) => { let m = n >= 0 ? n * 2 : -n * 2 - 1; for (;;) { const b = m & 0x7f; m = Math.floor(m / 128); if (!m) { out.push(b); return; } out.push(b | 0x80); } };
  varint(tags.length);
  for (const t of tags) for (const s of [t.name, t.value]) { const b = Buffer.from(s, "utf8"); varint(b.length); for (const x of b) out.push(x); }
  varint(0);
  return Buffer.from(out);
}

async function buildVector(c) {
  const opts = {};
  if (c.tags && c.tags.length) opts.tags = c.tags;
  if (c.target) opts.target = c.target;
  if (c.anchor) opts.anchor = c.anchor;

  const item = arb.createData(c.data, signer, opts);
  const unsigned = Buffer.from(item.getRaw()); // signature region is all zeroes at this point
  if (!unsigned.subarray(2, 2 + SIG_LEN).every((b) => b === 0))
    throw new Error(`${c.name}: signature region was not zero before signing`);

  const off = offsetsOf(unsigned);
  const rawTags = Buffer.from(item.rawTags);
  const rawTarget = Buffer.from(item.rawTarget);
  const rawAnchor = Buffer.from(item.rawAnchor);
  const rawData = Buffer.from(item.rawData);

  // The eight chunks that go into the deep hash, in order.
  const chunks = [
    Buffer.from("dataitem", "utf8"),
    Buffer.from("1", "utf8"),
    Buffer.from("1", "utf8"), // signatureType.toString()
    Buffer.from(item.rawOwner),
    rawTarget,
    rawAnchor,
    rawTags,
    rawData,
  ];
  const deepHashOut = Buffer.from(await arb.getSignatureData(item));

  // Key-independent skeleton: signature AND owner zeroed, so an implementer with a
  // different test key can still check the field layout.
  const skeleton = Buffer.from(unsigned);
  skeleton.fill(0, 2, 2 + SIG_LEN + OWNER_LEN);

  // One sample signature. NOT reproducible (PSS is randomised) — for verifier fixtures only.
  const signature = Buffer.from(await signer.sign(deepHashOut));
  const id = sha256(signature);

  return {
    name: c.name,
    description: c.description,
    input: {
      data_hex: hex(c.data),
      data_len: c.data.length,
      data_utf8: (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(c.data); } catch { return null; } })(),
      tags: c.tags ?? [],
      tags_hex: (c.tags ?? []).map((t) => ({
        name_hex: hex(Buffer.from(t.name, "utf8")),
        value_hex: hex(Buffer.from(t.value, "utf8")),
      })),
      target_b64url: c.target ?? null,
      anchor_utf8: c.anchor ?? null,
      anchor_hex: c.anchor ? hex(Buffer.from(c.anchor)) : null,
    },
    expected: {
      signature_type: 1,
      tag_count: (c.tags ?? []).length,
      tag_bytes_len: rawTags.length,
      tag_bytes_hex: hex(rawTags),
      raw_target_hex: hex(rawTarget),
      raw_anchor_hex: hex(rawAnchor),
      raw_data_hex: hex(rawData),
      offsets: off,
      unsigned_item_hex: hex(unsigned),
      unsigned_item_sha256: hex(sha256(unsigned)),
      keyless_skeleton_sha256: hex(sha256(skeleton)),
      deep_hash_input_chunks_hex: chunks.map(hex),
      deep_hash_hex: hex(deepHashOut),
    },
    encoding: (() => {
      const strict = strictUtf8Tags(c.tags);
      const same = strict.equals(rawTags);
      return {
        strict_utf8_tag_bytes_match: same,
        strict_utf8_tag_bytes_hex: same ? null : hex(strict),
        note: same ? null
          : "DIVERGENCE: arbundles' tag bytes are NOT standard UTF-8 for this input. Its hand-rolled encoder (taken when the string's byte length is <= 64) writes unpaired UTF-16 surrogates as raw WTF-8 code points instead of substituting U+FFFD, while still declaring the standard-UTF-8 byte length. To reproduce arbundles byte for byte you must replicate that; `strict_utf8_tag_bytes_hex` is what a conventional encoder produces.",
      };
    })(),
    sample_signature: {
      note: "NOT reproducible: RSA-PSS is randomised. Do not assert equality on these. Splice signature_hex into unsigned_item_hex at byte offset 2 to obtain a valid signed item, then test your VERIFIER against it.",
      signature_hex: hex(signature),
      id_hex: hex(id),
      id_b64url: id.toString("base64url"),
    },
  };
}

/** Behaviours both implementations must reject. Recorded, not asserted-by-equality. */
function buildLimits() {
  const probe = (label, fn) => {
    try { fn(); return { case: label, throws: false, message: null }; }
    catch (e) { return { case: label, throws: true, message: e.message }; }
  };
  const big = Array.from({ length: 200 }, (_, i) => ({ name: `long-tag-name-number-${i}`, value: `long-tag-value-number-${i}` }));
  return [
    probe("tag region over MAX_TAG_BYTES (4096)", () => arb.createData("x", signer, { tags: big })),
    probe("target that is not 32 bytes", () => arb.createData("x", signer, { target: Buffer.from("short").toString("base64url") })),
    probe("anchor that is not 32 bytes", () => arb.createData("x", signer, { anchor: "too-short" })),
    probe("anchor supplied as 43-char base64url (a natural mistake)", () =>
      arb.createData("x", signer, { anchor: Buffer.alloc(32).toString("base64url") })),
    probe("non-string tag value", () => arb.createData("x", signer, { tags: [{ name: "n", value: 5 }] })),
  ];
}

(async () => {
  const vectors = [];
  for (const c of cases) vectors.push(await buildVector(c));

  const out = {
    format: "ans104-dataitem-conformance-vectors",
    version: 1,
    generated_by: "@dha-team/arbundles@" +
      require(require("node:path").join(arb.ARB_ROOT, "..", "..", "..", "..", "package.json")).version,
    generated_with_node: process.version,
    signature_type: {
      id: 1,
      name: "arweave",
      algorithm: "RSA-PSS",
      hash: "SHA-256",
      mgf1_hash: "SHA-256",
      modulus_bits: 4096,
      signature_length: 512,
      owner_length: 512,
      salt_length_bytes: 478,
      salt_length_rule: "RSA_PSS_SALTLEN_MAX_SIGN = emLen - hLen - 2 = 512 - 32 - 2. NOT the digest length.",
      public_exponent: "65537 (0x10001). Not carried on the wire; every implementation hardcodes it.",
    },
    deep_hash: {
      hash: "SHA-384",
      blob_rule: "H(H('blob' || decimal_ascii(len)) || H(data))",
      list_rule: "acc = H('list' || decimal_ascii(count)); for each child: acc = H(acc || deepHash(child))",
    },
    key: {
      file: "test-key.json",
      warning: "THROWAWAY KEY. Generated for this corpus, published in the clear, never used for anything real.",
      owner_b64url: jwk.n,
      owner_sha256: hex(sha256(OWNER)),
    },
    notes: [
      "Signature bytes and data-item ids are NOT pinned as expectations: RSA-PSS is randomised, so signing identical input twice yields different bytes.",
      "Everything under `expected` is deterministic and must match byte for byte.",
      "`sample_signature` is a one-off fixture for testing a verifier, never an equality target.",
    ],
    limits: buildLimits(),
    vectors,
  };

  fs.writeFileSync(__dirname + "/vectors.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote vectors.json: ${vectors.length} vectors, ${out.limits.length} limit probes, ` +
    `${(fs.statSync(__dirname + "/vectors.json").size / 1024).toFixed(1)} KiB`);
  for (const l of out.limits) console.log(`  limit: ${l.case} -> ${l.throws ? "THROWS: " + l.message : "ACCEPTED (no error)"}`);
})();
