"use strict";
/**
 * The web build's plain JavaScript SHA-256 and SHA-384, against node:crypto.
 *
 * Every length from 0 to 300 bytes crosses both padding boundaries of both
 * block sizes (55/56/64 for SHA-256, 111/112/128 for SHA-384) several times.
 * The incremental API is fed the same input in uneven pieces, because a
 * streamed upload hashes its data that way.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { sha256, sha384, Sha384, Sha256 } = require("../src/core/sha2.js");

const hex = (b) => Buffer.from(b).toString("hex");

test("SHA-256 and SHA-384 match node:crypto for every length 0..300", () => {
  for (let n = 0; n <= 300; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(hex(sha256(b)), crypto.createHash("sha256").update(b).digest("hex"), `sha256, ${n} bytes`);
    assert.equal(hex(sha384(b)), crypto.createHash("sha384").update(b).digest("hex"), `sha384, ${n} bytes`);
  }
});

test("the incremental hashers give the same digest however the input is split", () => {
  const b = crypto.randomBytes(200_003);
  for (const [Ctor, name] of [[Sha256, "sha256"], [Sha384, "sha384"]]) {
    const h = new Ctor();
    let pos = 0;
    let step = 1;
    while (pos < b.length) {
      h.update(b.subarray(pos, pos + step));
      pos += step;
      step = (step * 7 + 3) % 4099 + 1;
    }
    assert.equal(hex(h.digest()), crypto.createHash(name).update(b).digest("hex"), name);
  }
});

test("known answers: the empty string and 'abc'", () => {
  assert.equal(hex(sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    hex(sha384(new TextEncoder().encode("abc"))),
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  );
});
