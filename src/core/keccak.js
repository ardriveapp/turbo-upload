"use strict";
/**
 * Keccak-256 in plain JavaScript, for both builds.
 *
 * Ethereum's hash is the original Keccak submission, not NIST SHA3-256: the
 * padding byte is 0x01, not 0x06, so the two disagree on every input. Node's
 * `sha3-256` is the NIST one, and OpenSSL builds commonly have no
 * `keccak-256`, so this package carries its own.
 *
 * Keccak-f[1600] with a 136-byte rate. 64-bit lanes are held as two 32-bit
 * halves (low, high), since JavaScript bitwise operators work on 32 bits.
 * `test/keccak.test.js` checks it against @noble/hashes for every length 0 to
 * 699, which crosses the rate boundary five times.
 */

/** Round constants as [low, high] pairs. */
const RC = new Uint32Array([
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
]);

/** Rotation offset of lane x + 5y. */
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const RATE = 136;

/** Rotate the 64-bit lane (lo, hi) left by n, writing it to out[i], out[i + 1]. */
function rotl(lo, hi, n, out, i) {
  if (n >= 32) {
    const t = lo;
    lo = hi;
    hi = t;
    n -= 32;
  }
  if (n === 0) {
    out[i] = lo;
    out[i + 1] = hi;
    return;
  }
  out[i] = (lo << n) | (hi >>> (32 - n));
  out[i + 1] = (hi << n) | (lo >>> (32 - n));
}

function keccakF(s) {
  const C = new Uint32Array(10);
  const D = new Uint32Array(2);
  const B = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const next = 2 * ((x + 1) % 5);
      const prev = 2 * ((x + 4) % 5);
      rotl(C[next], C[next + 1], 1, D, 0);
      const dl = C[prev] ^ D[0];
      const dh = C[prev + 1] ^ D[1];
      for (let y = 0; y < 25; y += 5) {
        s[2 * (y + x)] ^= dl;
        s[2 * (y + x) + 1] ^= dh;
      }
    }
    // rho and pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        rotl(s[2 * i], s[2 * i + 1], ROT[i], B, 2 * j);
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const a = 2 * (y + x);
        const b = 2 * (y + ((x + 1) % 5));
        const c = 2 * (y + ((x + 2) % 5));
        s[a] = B[a] ^ (~B[b] & B[c]);
        s[a + 1] = B[a + 1] ^ (~B[b + 1] & B[c + 1]);
      }
    }
    // iota
    s[0] ^= RC[2 * round];
    s[1] ^= RC[2 * round + 1];
  }
}

/**
 * Keccak-256 of a byte string.
 *
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32 bytes
 */
function keccak256(message) {
  const s = new Uint32Array(50);
  const padded = new Uint8Array(Math.floor(message.length / RATE) * RATE + RATE);
  padded.set(message);
  padded[message.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 4; i++) {
      const p = off + 4 * i;
      s[i] ^= padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = s[i];
    out[4 * i + 1] = s[i] >>> 8;
    out[4 * i + 2] = s[i] >>> 16;
    out[4 * i + 3] = s[i] >>> 24;
  }
  return out;
}

module.exports = { keccak256 };
