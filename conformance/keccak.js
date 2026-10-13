"use strict";
/**
 * keccak.js, the package's Keccak-256 and EIP-55 against @noble/hashes and
 * ethers.
 *
 *   node keccak.js
 *
 * Every length 0 to 699, which crosses the 136-byte rate five times, over two
 * inputs each: one byte pattern fixed by the length and one random. Then the
 * EIP-55 address of 1000 random keys against ethers. Exits non-zero on any
 * difference.
 */
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { keccak_256: nobleKeccak } = require("@noble/hashes/sha3");
const ethers = require("ethers");
const { keccak256 } = require("../src/core/keccak.js");
const { toChecksumAddress } = require("../src/core/ethereum.js");

const hex = (b) => Buffer.from(b).toString("hex");
const failures = [];
let checked = 0;

for (let n = 0; n < 700; n++) {
  for (const input of [Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff)), crypto.randomBytes(n)]) {
    checked++;
    if (hex(keccak256(input)) !== hex(nobleKeccak(input))) failures.push(`keccak256, ${n} bytes`);
  }
}

for (let i = 0; i < 1000; i++) {
  const address = ethers.computeAddress(`0x${crypto.randomBytes(32).toString("hex")}`);
  checked++;
  if (toChecksumAddress(address.toLowerCase()) !== address) failures.push(`EIP-55 ${address}`);
}

console.log(`keccak256 and EIP-55: ${checked - failures.length}/${checked} agree with @noble/hashes and ethers`);
for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
