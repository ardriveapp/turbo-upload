"use strict";
/**
 * Conformance against vectors/vectors.json — 22 vectors generated from
 * @dha-team/arbundles@1.0.4, the de-facto reference implementation.
 *
 * Everything asserted here is DETERMINISTIC and must match byte for byte. If a
 * vector fails, this package is wrong; the vector is not the thing to change.
 *
 * These assertions need only the PUBLIC modulus, which the corpus carries, so
 * no private key ships with this package. The signing tests generate an
 * ephemeral key at runtime (see signing.test.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { Buffer } = require("node:buffer");

const ans104 = require("../src/ans104.js");
const V = require("../vectors/vectors.json");

const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** The corpus's public modulus. The private half is deliberately not shipped. */
const OWNER = Buffer.from(V.key.owner_b64url, "base64url");

test("corpus is the expected format and version", () => {
  assert.equal(V.format, "ans104-dataitem-conformance-vectors");
  assert.equal(V.signature_type.id, 1);
  assert.equal(V.signature_type.modulus_bits, 4096);
  assert.equal(V.vectors.length, 22);
});

test("the corpus pins the salt length this package emits", () => {
  // If these ever disagree, one of them is wrong and uploads are non-conformant.
  assert.equal(V.signature_type.salt_length_bytes, 478);
  assert.equal(ans104.PSS_SALT_LENGTH_BYTES, 478);
});

test("owner derives the corpus's recorded address", () => {
  assert.equal(OWNER.length, 512);
  assert.equal(hex(sha256(OWNER)), V.key.owner_sha256);
});

for (const v of V.vectors) {
  test(`vector: ${v.name}`, () => {
    const i = v.input;
    const e = v.expected;

    const opts = {
      data: Buffer.from(i.data_hex, "hex"),
      tags: i.tags,
      target: i.target_b64url ?? undefined,
      anchor: i.anchor_utf8 ?? undefined,
      owner: OWNER,
    };

    const unsigned = ans104.createDataItem(opts);
    const parsed = ans104.parseDataItem(unsigned);

    // --- tag region ---
    const tagBytes = i.tags.length ? ans104.serializeTags(i.tags) : Buffer.alloc(0);
    assert.equal(hex(tagBytes), e.tag_bytes_hex, "tag_bytes_hex");
    assert.equal(tagBytes.length, e.tag_bytes_len, "tag_bytes_len");
    assert.equal(parsed.tagCount, e.tag_count, "tag_count");

    // --- fields ---
    assert.equal(hex(parsed.rawTarget), e.raw_target_hex, "raw_target_hex");
    assert.equal(hex(parsed.rawAnchor), e.raw_anchor_hex, "raw_anchor_hex");
    assert.equal(hex(parsed.rawData), e.raw_data_hex, "raw_data_hex");

    // --- offsets are chained, not fixed: this is what catches a hardcoded layout ---
    assert.equal(parsed.offsets.ownerStart, e.offsets.owner, "offset.owner");
    assert.equal(parsed.offsets.targetStart, e.offsets.target_presence_byte, "offset.target_presence_byte");
    assert.equal(parsed.offsets.anchorStart, e.offsets.anchor_presence_byte, "offset.anchor_presence_byte");
    assert.equal(parsed.offsets.tagsStart, e.offsets.tags_start, "offset.tags_start");
    assert.equal(parsed.offsets.dataStart, e.offsets.data_start, "offset.data_start");
    assert.equal(parsed.offsets.totalLength, e.offsets.total_length, "offset.total_length");

    // --- the whole unsigned item, byte for byte ---
    assert.equal(hex(unsigned), e.unsigned_item_hex, "unsigned_item_hex");
    assert.equal(hex(sha256(unsigned)), e.unsigned_item_sha256, "unsigned_item_sha256");

    const skeleton = Buffer.from(unsigned);
    skeleton.fill(0, 2, 2 + 512 + 512);
    assert.equal(hex(sha256(skeleton)), e.keyless_skeleton_sha256, "keyless_skeleton_sha256");

    // --- the deep-hash transcript, chunk by chunk (fastest way to localise a bug) ---
    const chunks = [
      Buffer.from("dataitem", "utf8"),
      Buffer.from("1", "utf8"),
      Buffer.from("1", "utf8"),
      parsed.rawOwner,
      parsed.rawTarget,
      parsed.rawAnchor,
      parsed.rawTags,
      parsed.rawData,
    ].map(hex);
    assert.deepEqual(chunks, e.deep_hash_input_chunks_hex, "deep_hash_input_chunks_hex");
    assert.equal(hex(ans104.getSignatureData(unsigned)), e.deep_hash_hex, "deep_hash_hex");

    // --- round-trip the tags back out ---
    // Only for WELL-FORMED input. A lone surrogate is encoded (as WTF-8 or as
    // U+FFFD depending on which side of the 64-byte threshold it falls) and
    // decodes back as U+FFFD either way, so the round trip is lossy by
    // construction. `lossless` below pins that; see the dedicated test after
    // this loop.
    const lossless = i.tags.every(
      (t) =>
        Buffer.from(t.name, "utf8").toString("utf8") === t.name &&
        Buffer.from(t.value, "utf8").toString("utf8") === t.value,
    );
    if (i.tags.length && lossless) {
      assert.deepEqual(ans104.deserializeTags(parsed.rawTags), i.tags, "tags round-trip");
    }

    // --- cross-implementation: a signature MADE BY ARBUNDLES must verify here ---
    // This is the assertion that matters most. Byte-equal deep hashes are
    // necessary but not sufficient; this proves we accept the reference's work.
    const spliced = Buffer.from(e.unsigned_item_hex, "hex");
    spliced.set(Buffer.from(v.sample_signature.signature_hex, "hex"), 2);
    assert.equal(ans104.verifyDataItem(spliced), true, "arbundles-made signature verifies here");
    assert.equal(
      ans104.verifyDataItem(spliced, { strictSaltLength: true }),
      true,
      "and it verifies under the strict 478-byte salt check",
    );

    // --- id derivation agrees with the reference ---
    const sig = Buffer.from(v.sample_signature.signature_hex, "hex");
    assert.equal(hex(ans104.idFromSignature(sig)), v.sample_signature.id_hex, "id = sha256(signature)");
    assert.equal(ans104.idFromSignature(sig).toString("base64url"), v.sample_signature.id_b64url, "id b64url");
  });
}

test("tag round-tripping is LOSSY for unpaired surrogates, in both encoder paths", () => {
  // Not a defect to fix: a data item carries BYTES, and neither WTF-8 nor
  // U+FFFD decodes back to the original lone surrogate. Worth pinning because
  // the tempting "fix" — making deserializeTags surrogate-preserving — would
  // change ids and break conformance. If your tags may contain unpaired
  // surrogates, reject them upstream; do not rely on reading them back.
  for (const name of ["lone-surrogate-tag-short", "lone-surrogate-tag-long"]) {
    const v = V.vectors.find((x) => x.name === name);
    const item = ans104.createDataItem({ data: "x", owner: OWNER, tags: v.input.tags });
    const back = ans104.deserializeTags(ans104.parseDataItem(item).rawTags);
    assert.notDeepEqual(back, v.input.tags, `${name}: expected a lossy round trip`);
    assert.ok(back[0].value.includes("\uFFFD"), `${name}: the surrogate decodes to U+FFFD`);
    // The item is still structurally valid and the tag COUNT still agrees,
    // which is why this passes verification rather than corrupting the item.
    assert.equal(back.length, v.expected.tag_count);
  }
});

test("tag encoding: strict UTF-8 divergence is exactly where the corpus says it is", () => {
  // 21 of 22 vectors are byte-identical under a standard UTF-8 encoder. The
  // 22nd is the lone-surrogate case, and it is the whole point: our default
  // encoder must reproduce arbundles' WTF-8 path, not standard UTF-8.
  let identical = 0;
  const diverged = [];
  for (const v of V.vectors) {
    const strict = hex(ans104.serializeTags(v.input.tags, { stringEncoding: "utf8" }));
    const matches = strict === v.expected.tag_bytes_hex;
    assert.equal(matches, v.encoding.strict_utf8_tag_bytes_match, `${v.name}: divergence recorded correctly`);
    if (matches) identical++;
    else {
      diverged.push(v.name);
      assert.equal(strict, v.encoding.strict_utf8_tag_bytes_hex, `${v.name}: strict bytes recorded correctly`);
    }
  }
  assert.equal(identical, 21);
  assert.deepEqual(diverged, ["lone-surrogate-tag-short"]);
});

test("limits: inputs the reference rejects, we reject too", () => {
  const cases = [
    [
      "tag region over MAX_TAG_BYTES (4096)",
      () =>
        ans104.createDataItem({
          data: "x",
          owner: OWNER,
          tags: Array.from({ length: 200 }, (_, i) => ({
            name: `long-tag-name-number-${i}`,
            value: `long-tag-value-number-${i}`,
          })),
        }),
    ],
    ["target that is not 32 bytes", () => ans104.createDataItem({ data: "x", owner: OWNER, target: Buffer.from("short").toString("base64url") })],
    ["anchor that is not 32 bytes", () => ans104.createDataItem({ data: "x", owner: OWNER, anchor: "too-short" })],
    [
      // The natural mistake: anchor looks like target, so people base64url it.
      "anchor supplied as 43-char base64url (a natural mistake)",
      () => ans104.createDataItem({ data: "x", owner: OWNER, anchor: Buffer.alloc(32).toString("base64url") }),
    ],
    ["non-string tag value", () => ans104.createDataItem({ data: "x", owner: OWNER, tags: [{ name: "n", value: 5 }] })],
  ];
  for (const [label, fn] of cases) {
    const recorded = V.limits.find((l) => l.case === label);
    assert.ok(recorded, `corpus records the case "${label}"`);
    assert.throws(fn, /./, `${label} must throw (arbundles: ${recorded.message})`);
  }
});

test("an over-cap tag region is rejected on READ as well as on write", () => {
  // The cap is enforced both directions; a verifier that only checks on write
  // will accept items the reference rejects.
  const item = ans104.createDataItem({ data: "x", owner: OWNER, tags: [{ name: "a", value: "b" }] });
  const parsed = ans104.parseDataItem(item);
  const forged = Buffer.from(item);
  // Declare a tag region larger than the cap.
  forged.set(ans104.longToNByteArray(8, 5000), parsed.offsets.tagsStart + 8);
  assert.equal(ans104.verifyDataItem(forged), false);
});

test("a tag region that decodes to a different count than declared is rejected", () => {
  const item = ans104.createDataItem({
    data: "x",
    owner: OWNER,
    tags: [
      { name: "a", value: "b" },
      { name: "c", value: "d" },
    ],
  });
  const parsed = ans104.parseDataItem(item);
  const forged = Buffer.from(item);
  forged.set(ans104.longToNByteArray(8, 3), parsed.offsets.tagsStart); // claim 3 tags, encode 2
  assert.equal(ans104.verifyDataItem(forged), false);
});

test("the 1044-byte floor", () => {
  const item = ans104.createDataItem({ owner: OWNER });
  assert.equal(item.length, ans104.MIN_ITEM_SIZE);
  assert.equal(item.length, 1044);
});
