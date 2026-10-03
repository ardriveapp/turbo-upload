"use strict";
/**
 * Byte helpers on plain Uint8Array.
 *
 * Everything under src/core/ runs unchanged in Node, in a browser, in a worker
 * and in jsdom, so nothing here may touch `Buffer`, `process` or a `node:`
 * module. `test/zero-deps.test.js` enforces that.
 *
 * UTF-8 is encoded by hand rather than through TextEncoder. jsdom, which is
 * what Jest's browser environment runs, has no TextEncoder, and the encoder
 * here also has to reproduce the exact bytes Node's Buffer produces for a lone
 * UTF-16 surrogate (EF BF BD), because tag bytes are part of what gets signed.
 */

/** A Uint8Array view of any byte-like input, without copying. */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (typeof input === "string") return utf8Encode(input);
  throw new TypeError(`expected bytes or a string, got ${input === null ? "null" : typeof input}`);
}

/**
 * Standard UTF-8, matching Buffer.from(s, "utf8") byte for byte: an unpaired
 * surrogate becomes U+FFFD (EF BF BD).
 */
function utf8Encode(s) {
  const out = new Uint8Array(utf8ByteLength(s));
  let pos = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) {
      out[pos++] = c;
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6);
      out[pos++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[pos++] = 0xe0 | (c >> 12);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    } else {
      out[pos++] = 0xf0 | (c >> 18);
      out[pos++] = 0x80 | ((c >> 12) & 0x3f);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return out;
}

/** The UTF-8 byte length of a string, as Buffer.byteLength(s, "utf8") counts it. */
function utf8ByteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else n += 3;
  }
  return n;
}

/**
 * Decode UTF-8, replacing ill-formed sequences with U+FFFD the way the WHATWG
 * decoder does. TextDecoder is used when the runtime has one; the fallback is
 * for jsdom.
 */
function utf8Decode(bytes) {
  if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp = 0xfffd;
    let need = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      if (b0 === 0xe0) lower = 0xa0;
      if (b0 === 0xed) upper = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      if (b0 === 0xf0) lower = 0x90;
      if (b0 === 0xf4) upper = 0x8f;
    }
    i++;
    if (need > 0) {
      let ok = true;
      for (let k = 0; k < need; k++) {
        const b = bytes[i];
        const lo = k === 0 ? lower : 0x80;
        const hi = k === 0 ? upper : 0xbf;
        if (b === undefined || b < lo || b > hi) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (b & 0x3f);
        i++;
      }
      if (!ok) cp = 0xfffd;
    } else if (b0 >= 0x80) {
      cp = 0xfffd;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const HEX = "0123456789abcdef";

/** Lowercase hex, as Buffer#toString("hex") writes it. */
function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new TypeError("expected an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding, as Buffer#toString("base64url") writes it. */
function toBase64Url(bytes) {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    s += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return s;
}

/**
 * Decode base64url (standard base64 characters and padding also accepted).
 * Strict: any other character throws, rather than being skipped.
 */
function fromBase64Url(s) {
  if (typeof s !== "string") throw new TypeError("expected a base64url string");
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let pos = 0;
  for (const ch of clean) {
    let v = B64URL.indexOf(ch);
    if (ch === "+") v = 62;
    if (ch === "/") v = 63;
    if (v < 0) throw new TypeError(`invalid base64url character ${JSON.stringify(ch)}`);
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

module.exports = {
  toBytes,
  utf8Encode,
  utf8ByteLength,
  utf8Decode,
  concatBytes,
  bytesEqual,
  toHex,
  fromHex,
  toBase64Url,
  fromBase64Url,
};
