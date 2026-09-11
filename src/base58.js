"use strict";
/**
 * Base58 (Bitcoin alphabet), which is how Solana keys and addresses are written.
 *
 * Here rather than as a dependency because it is integer arithmetic with no
 * cryptography in it: a wrong result is a decode failure, not a silently weak
 * signature. Every other primitive this package needs is in node:crypto, and
 * this is the one gap.
 */
const { Buffer } = require("node:buffer");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58;

/** Reverse lookup, so decode does not scan the alphabet per character. */
const INDEX = new Map();
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i);

/**
 * Decodes a base58 string to bytes.
 *
 * Leading `1` characters are leading zero bytes, not digits, which is the part
 * a naive implementation drops. A 32-byte key beginning with a zero byte would
 * decode to 31 bytes and then fail a length check somewhere unrelated.
 *
 * @param {string} input
 * @returns {Buffer}
 */
function decodeBase58(input) {
  if (typeof input !== "string") {
    throw new TypeError(`base58 input must be a string, got ${typeof input}`);
  }
  if (input.length === 0) return Buffer.alloc(0);

  // Leading '1's are zero bytes, not digits. Count them first and convert only
  // the rest, otherwise the accumulator's own initial zero is emitted as an
  // extra byte and every all-zero-prefixed key decodes one byte too long.
  let zeros = 0;
  while (zeros < input.length && input[zeros] === ALPHABET[0]) zeros++;

  const bytes = [];
  for (const char of input.slice(zeros)) {
    const value = INDEX.get(char);
    if (value === undefined) {
      throw new Error(`invalid base58 character ${JSON.stringify(char)}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  bytes.reverse();
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

/**
 * Encodes bytes as base58.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {string}
 */
function encodeBase58(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0) return "";

  // Same asymmetry as decode: leading zero bytes are written as '1' and carry no
  // numeric value, so they are counted and skipped rather than fed through the
  // accumulator, which would otherwise emit its own initial zero as a digit.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits = [];
  for (const byte of bytes.subarray(zeros)) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % BASE;
      carry = (carry / BASE) | 0;
    }
    while (carry > 0) {
      digits.push(carry % BASE);
      carry = (carry / BASE) | 0;
    }
  }

  let out = ALPHABET[0].repeat(zeros);
  for (let j = digits.length - 1; j >= 0; j--) out += ALPHABET[digits[j]];
  return out;
}

module.exports = { decodeBase58, encodeBase58, ALPHABET };
