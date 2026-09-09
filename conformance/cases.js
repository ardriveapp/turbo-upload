"use strict";
/**
 * cases.js, the corpus definition. Shared by generate-vectors.js and (for names only) verify.js.
 * Every case is pure data: no arbundles, no reference-signer.
 */
const { Buffer } = require("node:buffer");

// A 32-byte target, expressed as base64url (ANS-104: target is a 32-byte Arweave address).
const TARGET_B64 = Buffer.from("target--------------------------").toString("base64url"); // 32 bytes
// A 32-byte anchor. NOTE arbundles takes the anchor STRING as raw UTF-8 bytes, not base64url.
const ANCHOR_STR = "anchor--------------------------"; // exactly 32 ASCII bytes

const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

// A tag set that fills the 4096-byte tag region as far as it will go.
function maxTagSet() {
  const tags = [];
  // 90 tags of ~44 bytes of payload each lands just under the 4096-byte cap.
  for (let i = 0; i < 90; i++) {
    tags.push({ name: `tag-name-${String(i).padStart(3, "0")}`, value: `value-${String(i).padStart(3, "0")}-payload` });
  }
  return tags;
}

module.exports = [
  {
    name: "empty-data-empty-tags",
    description: "The degenerate item: no data, no tags, no target, no anchor. Pins the 1044-byte floor of the format and proves absent optional fields still contribute a zero-length blob to the deep hash.",
    data: Buffer.alloc(0),
    tags: [],
  },
  {
    name: "ascii-data-no-tags",
    description: "Small ASCII payload, no tags. The simplest non-trivial item; the tag region is 16 bytes of zeroed counters and nothing else.",
    data: Buffer.from("hello world", "utf8"),
    tags: [],
  },
  {
    name: "single-byte-data",
    description: "One data byte. Catches implementations that special-case or off-by-one the data offset.",
    data: Buffer.from([0x00]),
    tags: [],
  },
  {
    name: "one-tag",
    description: "A single Content-Type tag. Pins the minimal Avro tag block: zigzag count, one name/value pair, terminating 0x00.",
    data: Buffer.from("{}", "utf8"),
    tags: [{ name: "Content-Type", value: "application/json" }],
  },
  {
    name: "several-tags",
    description: "Five tags in declared order. Tag order is significant and is never sorted or normalised.",
    data: Buffer.from("payload", "utf8"),
    tags: [
      { name: "Content-Type", value: "text/plain" },
      { name: "App-Name", value: "sanning" },
      { name: "App-Version", value: "0.1.0" },
      { name: "Unix-Time", value: "1756425600" },
      { name: "Anchor-Kind", value: "commitment" },
    ],
  },
  {
    name: "duplicate-tag-names",
    description: "The same tag name three times with different values. ANS-104 does not require unique names and no deduplication happens; all three survive in order.",
    data: Buffer.from("dupes", "utf8"),
    tags: [
      { name: "Topic", value: "alpha" },
      { name: "Topic", value: "beta" },
      { name: "Topic", value: "gamma" },
    ],
  },
  {
    name: "unicode-tags",
    description: "Non-ASCII in both tag names and values: Latin-1 accents, CJK, Cyrillic, and an astral-plane emoji (surrogate pair). The declared varint length is the UTF-8 BYTE length, not the character or UTF-16 code-unit count, this is where naive encoders break.",
    data: Buffer.from("unicode", "utf8"),
    tags: [
      { name: "Título", value: "café résumé" },
      { name: "名前", value: "値" },
      { name: "Ключ", value: "значение" },
      { name: "emoji", value: "🎉🚀" },
      { name: "🔑", value: "🗝" },
    ],
  },
  {
    name: "empty-tag-value",
    description: "A tag with a non-empty name and an empty value. The value serializes as a zero-length string: varint 0x00 and no bytes.",
    data: Buffer.from("x", "utf8"),
    tags: [{ name: "Empty-Value", value: "" }],
  },
  {
    name: "empty-tag-name",
    description: "A tag with an EMPTY NAME. arbundles permits this and round-trips it; ANS-104 does not forbid it. A validator that rejects empty names diverges from the de-facto reference.",
    data: Buffer.from("x", "utf8"),
    tags: [{ name: "", value: "orphan-value" }],
  },
  {
    name: "empty-name-and-value",
    description: "Both name and value empty. Four bytes of tag region: count, 0x00, 0x00, terminator.",
    data: Buffer.from("x", "utf8"),
    tags: [{ name: "", value: "" }],
  },
  {
    name: "tag-value-64-bytes",
    description: "A well-formed UTF-8 tag value of exactly 64 bytes, the last length that takes arbundles' hand-rolled encoder path. Must byte-match the 65-byte case's encoder.",
    data: Buffer.from("boundary", "utf8"),
    tags: [{ name: "b", value: "é".repeat(32) }], // 2 bytes each => 64
  },
  {
    name: "tag-value-65-bytes",
    description: "The same content plus one byte, which crosses arbundles' internal 64-byte threshold and switches it to Buffer.write. Both paths must agree for well-formed input; this vector is the guard on that.",
    data: Buffer.from("boundary", "utf8"),
    tags: [{ name: "b", value: "é".repeat(32) + "z" }], // 65
  },
  {
    name: "lone-surrogate-tag-short",
    description: "KNOWN DIVERGENCE. An unpaired UTF-16 high surrogate (U+D800) in a tag value under 64 bytes. arbundles' hand-rolled encoder emits the raw code point as WTF-8 (ED A0 80) while declaring Buffer.byteLength (3), which is the length of the standard-UTF-8 replacement character. Standard UTF-8 would emit EF BF BD. Same width, different bytes, so nothing desyncs and nothing errors, a reimplementation just silently produces a different id.",
    data: Buffer.from("surrogate", "utf8"),
    tags: [{ name: "s", value: "\ud800" }],
  },
  {
    name: "lone-surrogate-tag-long",
    description: "KNOWN DIVERGENCE, other side. The same unpaired surrogate in a value over 64 bytes, where arbundles falls through to Buffer.write and emits standard UTF-8 (EF BF BD). Identical logical input to the previous vector, different bytes, purely because of length. arbundles is not self-consistent here.",
    data: Buffer.from("surrogate", "utf8"),
    tags: [{ name: "s", value: "\ud800" + "x".repeat(67) }],
  },
  {
    name: "binary-data-all-bytes",
    description: "Data is all 256 byte values 0x00..0xFF, not valid UTF-8. Data is an opaque byte string and must never be routed through a text codec.",
    data: allBytes,
    tags: [{ name: "Content-Type", value: "application/octet-stream" }],
  },
  {
    name: "data-4096-bytes",
    description: "Exactly 4096 bytes of data. A size boundary that shares its number with MAX_TAG_BYTES, which is a common place to conflate two unrelated limits.",
    data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff)),
    tags: [{ name: "Size", value: "4096" }],
  },
  {
    name: "target-present",
    description: "Target present, anchor absent. Flips the target presence byte to 1 and inserts 32 bytes, shifting every subsequent offset by 32.",
    data: Buffer.from("with target", "utf8"),
    tags: [],
    target: TARGET_B64,
  },
  {
    name: "anchor-present",
    description: "Anchor present, target absent. NOTE arbundles takes the anchor argument as a raw string and Buffer.from()s it, the anchor is 32 RAW BYTES, not a base64url-decoded value the way target is. Passing a 43-char base64url anchor throws.",
    data: Buffer.from("with anchor", "utf8"),
    tags: [],
    anchor: ANCHOR_STR,
  },
  {
    name: "target-and-anchor",
    description: "Both optional fields present, no tags. The layout with the maximum optional-field displacement.",
    data: Buffer.from("both", "utf8"),
    tags: [],
    target: TARGET_B64,
    anchor: ANCHOR_STR,
  },
  {
    name: "everything-present",
    description: "Target, anchor, several unicode tags and a non-empty payload all at once. The integration case: if offsets are computed independently anywhere, this is where it shows.",
    data: Buffer.from("the full house 🏠", "utf8"),
    tags: [
      { name: "Content-Type", value: "text/plain; charset=utf-8" },
      { name: "Тема", value: "всё сразу" },
      { name: "", value: "" },
      { name: "Trailing", value: "🎯" },
    ],
    target: TARGET_B64,
    anchor: ANCHOR_STR,
  },
  {
    name: "max-tag-set",
    description: "90 tags, filling the tag region to just under the 4096-byte MAX_TAG_BYTES cap. Also crosses the 63-tag boundary where the zigzag varint for the tag count grows to two bytes.",
    data: Buffer.from("many tags", "utf8"),
    tags: maxTagSet(),
  },
  {
    name: "tag-count-varint-boundary",
    description: "Exactly 64 tags. Zigzag(64) = 128, the first count that needs a two-byte varint (0x80 0x01). A single-byte-varint assumption dies here.",
    data: Buffer.from("64 tags", "utf8"),
    tags: Array.from({ length: 64 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })),
  },
];

module.exports.TARGET_B64 = TARGET_B64;
module.exports.ANCHOR_STR = ANCHOR_STR;
