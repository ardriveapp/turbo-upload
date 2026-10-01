"use strict";
/**
 * SHA-256 and SHA-384 in plain JavaScript, for the web build.
 *
 * The Node build never loads this file: it injects node:crypto instead. It
 * exists because ANS-104 needs both hashes SYNCHRONOUSLY (the deep hash is a
 * chain of a few hundred small digests) and WebCrypto's digest is async, and
 * because jsdom and React Native have no WebCrypto at all.
 *
 * FIPS 180-4. SHA-384 is SHA-512 with different initial values, truncated to
 * 48 bytes. 64-bit words are held as two 32-bit halves, since JavaScript
 * bitwise operators work on 32 bits. `test/sha2.test.js` checks both against
 * node:crypto across every length boundary.
 */

/* ------------------------------ SHA-256 ------------------------------- */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.w = new Uint32Array(64);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.total = 0;
  }

  compress(b, off) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  update(data) {
    this.total += data.length;
    let pos = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      pos = take;
      if (this.blockLen < 64) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    for (; pos + 64 <= data.length; pos += 64) this.compress(data, pos);
    if (pos < data.length) {
      this.block.set(data.subarray(pos), 0);
      this.blockLen = data.length - pos;
    }
    return this;
  }

  digest() {
    const bitsHi = Math.floor(this.total / 0x20000000);
    const bitsLo = (this.total * 8) >>> 0;
    const pad = new Uint8Array(((this.blockLen < 56 ? 56 : 120) - this.blockLen) + 8);
    pad[0] = 0x80;
    const n = pad.length;
    pad[n - 8] = bitsHi >>> 24; pad[n - 7] = bitsHi >>> 16; pad[n - 6] = bitsHi >>> 8; pad[n - 5] = bitsHi;
    pad[n - 4] = bitsLo >>> 24; pad[n - 3] = bitsLo >>> 16; pad[n - 2] = bitsLo >>> 8; pad[n - 1] = bitsLo;
    this.update(pad);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = this.h[i] >>> 16;
      out[i * 4 + 2] = this.h[i] >>> 8;
      out[i * 4 + 3] = this.h[i];
    }
    return out;
  }
}

/* ------------------------------ SHA-384 ------------------------------- */

// SHA-512 round constants as [hi, lo] pairs, flattened.
const K512 = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

const IV384 = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
];

class Sha384 {
  constructor() {
    this.h = new Uint32Array(IV384);
    this.w = new Uint32Array(160);
    this.block = new Uint8Array(128);
    this.blockLen = 0;
    this.total = 0;
  }

  compress(b, off) {
    const w = this.w;
    for (let i = 0; i < 32; i++) {
      const j = off + i * 4;
      w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      // sigma0 over w[i-15]
      let xh = w[(i - 15) * 2], xl = w[(i - 15) * 2 + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      // sigma1 over w[i-2]
      xh = w[(i - 2) * 2];
      xl = w[(i - 2) * 2 + 1];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + w[(i - 7) * 2 + 1] + w[(i - 16) * 2 + 1];
      const hi = s0h + s1h + w[(i - 7) * 2] + w[(i - 16) * 2] + ((lo / 0x100000000) | 0);
      w[i * 2] = hi | 0;
      w[i * 2 + 1] = lo | 0;
    }
    const h = this.h;
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 80; i++) {
      // Sigma1(e)
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      const t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[i * 2 + 1] + w[i * 2 + 1];
      const t1h = hh + S1h + chh + K512[i * 2] + w[i * 2] + ((t1l / 0x100000000) | 0);
      // Sigma0(a)
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (majl >>> 0);
      const t2h = S0h + majh + ((t2l / 0x100000000) | 0);
      hh = gh; hl = gl;
      gh = fh; gl = fl;
      fh = eh; fl = el;
      const el2 = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((el2 / 0x100000000) | 0)) | 0;
      el = el2 | 0;
      dh = ch; dl = cl;
      ch = bh; cl = bl;
      bh = ah; bl = al;
      const al2 = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + ((al2 / 0x100000000) | 0)) | 0;
      al = al2 | 0;
    }
    const add = (k, vh, vl) => {
      const lo = h[k + 1] + (vl >>> 0);
      h[k] = h[k] + vh + ((lo / 0x100000000) | 0);
      h[k + 1] = lo;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl);
    add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }

  update(data) {
    this.total += data.length;
    let pos = 0;
    if (this.blockLen > 0) {
      const take = Math.min(128 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      pos = take;
      if (this.blockLen < 128) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    for (; pos + 128 <= data.length; pos += 128) this.compress(data, pos);
    if (pos < data.length) {
      this.block.set(data.subarray(pos), 0);
      this.blockLen = data.length - pos;
    }
    return this;
  }

  digest() {
    // The length field is 128 bits; anything this library hashes fits in 53.
    const bitsHi = Math.floor(this.total / 0x20000000);
    const bitsLo = (this.total * 8) >>> 0;
    const pad = new Uint8Array(((this.blockLen < 112 ? 112 : 240) - this.blockLen) + 16);
    pad[0] = 0x80;
    const n = pad.length;
    pad[n - 8] = bitsHi >>> 24; pad[n - 7] = bitsHi >>> 16; pad[n - 6] = bitsHi >>> 8; pad[n - 5] = bitsHi;
    pad[n - 4] = bitsLo >>> 24; pad[n - 3] = bitsLo >>> 16; pad[n - 2] = bitsLo >>> 8; pad[n - 1] = bitsLo;
    this.update(pad);
    const out = new Uint8Array(48);
    for (let i = 0; i < 12; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = this.h[i] >>> 16;
      out[i * 4 + 2] = this.h[i] >>> 8;
      out[i * 4 + 3] = this.h[i];
    }
    return out;
  }
}

const sha256 = (bytes) => new Sha256().update(bytes).digest();
const sha384 = (bytes) => new Sha384().update(bytes).digest();

/** The hash set the web build injects into the core. */
const jsHashes = Object.freeze({
  sha256,
  sha384,
  createSha384: () => new Sha384(),
});

module.exports = { sha256, sha384, Sha256, Sha384, jsHashes };
