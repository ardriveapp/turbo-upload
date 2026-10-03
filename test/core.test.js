"use strict";
/**
 * The shared core, src/core/: byte helpers checked against Buffer, which is
 * what the Node build used before the core existed, and the malformed-input
 * cases the core now refuses.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const bytes = require("../src/core/bytes.js");
const core = require("../src/core/ans104.js");
const { verifyDataItem, deserializeTags } = require("../index.js");

/** Strings that include every UTF-8 width and unpaired surrogates of both kinds. */
function awkwardStrings() {
  const out = ["", "a", "é", "日本語", "🎉", "\ud800", "\udc00", "a\ud800b", "\ud83c", "x\udfffy", "🎉\ud800🎉"];
  for (let i = 0; i < 200; i++) {
    let s = "";
    for (let j = 0; j < 1 + (i % 40); j++) {
      const r = crypto.randomInt(5);
      s += r === 0 ? String.fromCharCode(0xd800 + crypto.randomInt(2048))
        : r === 1 ? String.fromCharCode(crypto.randomInt(128))
          : String.fromCodePoint(crypto.randomInt(0x10ffff + 1) & 0x10ffff);
    }
    out.push(s);
  }
  return out;
}

test("utf8Encode and utf8ByteLength match Buffer, lone surrogates included", () => {
  for (const s of awkwardStrings()) {
    assert.equal(Buffer.from(bytes.utf8Encode(s)).toString("hex"), Buffer.from(s, "utf8").toString("hex"), JSON.stringify(s));
    assert.equal(bytes.utf8ByteLength(s), Buffer.byteLength(s, "utf8"), JSON.stringify(s));
  }
});

test("utf8Decode matches Buffer on arbitrary bytes, including the jsdom fallback", () => {
  const saved = globalThis.TextDecoder;
  try {
    for (let i = 0; i < 2000; i++) {
      const b = crypto.randomBytes(crypto.randomInt(1, 24));
      const want = b.toString("utf8");
      globalThis.TextDecoder = saved;
      assert.equal(bytes.utf8Decode(b), want);
      // jsdom has no TextDecoder; the hand-rolled path must agree too.
      globalThis.TextDecoder = undefined;
      assert.equal(bytes.utf8Decode(b), want, `fallback differs on ${b.toString("hex")}`);
    }
  } finally {
    globalThis.TextDecoder = saved;
  }
});

test("hex and base64url round trip and match Buffer", () => {
  for (let n = 0; n < 70; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(bytes.toHex(b), b.toString("hex"));
    assert.equal(bytes.toBase64Url(b), b.toString("base64url"));
    assert.deepEqual(Buffer.from(bytes.fromBase64Url(b.toString("base64url"))), b);
    assert.deepEqual(Buffer.from(bytes.fromBase64Url(b.toString("base64"))), b, "standard base64 is accepted too");
    assert.deepEqual(Buffer.from(bytes.fromHex(b.toString("hex"))), b);
  }
  assert.throws(() => bytes.fromBase64Url("ab$d"), /invalid base64url character/);
});

test("a tag region with a negative string length is refused, not looped on", () => {
  // Found by fuzzing during the core extraction: these six bytes declare a
  // string of length -1, the cursor walks backwards, and the previous parser
  // never returned. verifyDataItem parses tags, so one crafted item hung it.
  const evil = Buffer.from("0604000e0902", "hex");
  assert.throws(() => deserializeTags(evil), /negative length/);
  assert.throws(() => core.deserializeTags(new Uint8Array(evil)), /negative length/);

  const item = core.createDataItem({ owner: new Uint8Array(32), signatureType: 4, tags: [{ name: "a", value: "b" }] });
  const parsed = core.parseDataItem(item);
  // Overwrite the six-byte tag region (count 1, "a", "b", terminator) with the evil bytes.
  assert.equal(parsed.rawTags.length, 6);
  item.set(evil, parsed.offsets.tagsStart + 16);
  assert.equal(verifyDataItem(Buffer.from(item)), false);
});

test("dataItemByteLength agrees with the item createDataItem builds", () => {
  const cases = [
    { signatureType: 1, owner: new Uint8Array(512) },
    { signatureType: 4, owner: new Uint8Array(32) },
  ];
  for (const base of cases) {
    for (const extra of [{}, { tags: [{ name: "Content-Type", value: "text/plain" }] }, { target: new Uint8Array(32) }, { anchor: "a".repeat(32) }]) {
      for (const n of [0, 1, 1000]) {
        const item = core.createDataItem({ ...base, ...extra, data: new Uint8Array(n) });
        assert.equal(core.dataItemByteLength({ ...base, ...extra, dataSize: n }), item.length);
      }
    }
  }
});
