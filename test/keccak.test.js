"use strict";
/**
 * Keccak-256 and the EIP-55 address checksum, the two pieces of EVM signing
 * this package writes itself.
 *
 * Known answers here; conformance/keccak.js also checks every length 0 to 699
 * against @noble/hashes, which stays out of this package's tree.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { keccak256 } = require("../src/core/keccak.js");
const { toChecksumAddress, hashMessage } = require("../src/core/ethereum.js");

const hex = (b) => Buffer.from(b).toString("hex");

test("keccak256 known answers, either side of the 136-byte rate", () => {
  assert.equal(hex(keccak256(new Uint8Array(0))), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex(keccak256(Buffer.from("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(hex(keccak256(Buffer.alloc(135, 0x61))), "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446");
  assert.equal(hex(keccak256(Buffer.alloc(136, 0x61))), "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
});

test("keccak256 is not NIST SHA3-256, which pads with 0x06", () => {
  const empty = new Uint8Array(0);
  assert.notEqual(hex(keccak256(empty)), crypto.createHash("sha3-256").update(empty).digest("hex"));
});

test("EIP-55: the test vectors from the EIP", () => {
  const vectors = [
    // all caps
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    // all lower
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    // normal
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];
  for (const v of vectors) {
    assert.equal(toChecksumAddress(v.toLowerCase()), v);
    assert.equal(toChecksumAddress(`0x${v.slice(2).toUpperCase()}`), v);
  }
  assert.throws(() => toChecksumAddress("0x1234"), /40 hex characters/);
});

test("the EIP-191 digest of 48 raw bytes matches viem's hashMessage", () => {
  // viem 2.57.2: hashMessage({ raw: new Uint8Array(48).fill(7) })
  assert.equal(
    hex(hashMessage(new Uint8Array(48).fill(7))),
    "934730faea4e1d8063f209b7a765f6d0a42f97fe54b01ed2c922cc8ea85e2c9c",
  );
});
