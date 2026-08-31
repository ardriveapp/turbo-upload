"use strict";
/**
 * reference-signer.js — a zero-dependency ANS-104 data-item signer (signature type 1,
 * Arweave RSA-4096 / RSA-PSS-SHA256).
 *
 * Dependencies: node:crypto and node:buffer ONLY. No npm packages, at all, ever.
 * arbundles is never required from this file — it is the thing this file replaces.
 *
 * Everything here is derived from the byte layout documented in ./spec.md and
 * pinned by ./vectors.json.
 */

const { createHash, createSign, createVerify, createPrivateKey, createPublicKey, constants } = require("node:crypto");
const { Buffer } = require("node:buffer");

/* ------------------------------------------------------------------ *
 * Signature type registry (ANS-104 §2.2). Only type 1 is implemented. *
 * ------------------------------------------------------------------ */
const SIG_CONFIG = {
  1: { name: "arweave", sigLength: 512, ownerLength: 512 },
};
const SIG_TYPE_ARWEAVE = 1;

/** ANS-104 caps the tag region. arbundles enforces this on both write and read. */
const MAX_TAG_BYTES = 4096;
/** arbundles refuses to even parse anything shorter. */
const MIN_BINARY_SIZE = 80;

/* ------------------------------------------------------ *
 * Little-endian unsigned integers of fixed width          *
 * ------------------------------------------------------ */
function longToNByteArray(n, value) {
  if (value < 0) throw new Error("unsigned only, cannot represent negative numbers");
  const out = Buffer.alloc(n);
  let v = value;
  for (let i = 0; i < n; i++) {
    const byte = v & 0xff;
    out[i] = byte;
    v = (v - byte) / 256;
  }
  if (v !== 0) throw new Error(`value ${value} does not fit in ${n} bytes`);
  return out;
}
const shortTo2ByteArray = (v) => longToNByteArray(2, v);
const longTo8ByteArray = (v) => longToNByteArray(8, v);

function byteArrayToLong(bytes) {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + bytes[i];
  return value;
}

/* ------------------------------------------------------ *
 * deepHash (Arweave's SHA-384 Merkle-ish transcript hash) *
 * ------------------------------------------------------ */
const sha384 = (b) => createHash("sha384").update(b).digest();
const sha256 = (b) => createHash("sha256").update(b).digest();

/**
 * deepHash over a tree of byte strings.
 *   blob:  H( H("blob" || len_ascii) || H(data) )
 *   list:  acc = H("list" || count_ascii); acc = H(acc || deepHash(child)) for each child
 * where H = SHA-384 and the tag/length strings are ASCII.
 */
function deepHash(chunk) {
  if (Array.isArray(chunk)) {
    let acc = sha384(Buffer.from(`list${chunk.length}`, "utf8"));
    for (const child of chunk) acc = sha384(Buffer.concat([acc, deepHash(child)]));
    return acc;
  }
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const tag = Buffer.from(`blob${data.byteLength}`, "utf8");
  return sha384(Buffer.concat([sha384(tag), sha384(data)]));
}

/* ------------------------------------------------------------------------- *
 * Tag serialization — Avro binary encoding of `array<{name:string,value:string}>` *
 * ------------------------------------------------------------------------- */

/** Avro zigzag varint. */
function writeVarLong(out, n) {
  let m = n >= 0 ? n * 2 : -n * 2 - 1;
  while (true) {
    const b = m & 0x7f;
    m = Math.floor(m / 128);
    if (m === 0) { out.push(b); return; }
    out.push(b | 0x80);
  }
}

function readVarLong(buf, state) {
  let n = 0, k = 0, b;
  do {
    b = buf[state.pos++];
    if (b === undefined) throw new Error("varint ran off the end of the buffer");
    n += (b & 0x7f) * Math.pow(2, k);
    k += 7;
  } while (b & 0x80);
  return n % 2 ? -(n + 1) / 2 : n / 2;
}

/**
 * UTF-8 encode a JS string the way arbundles' AVSCTap.writeString does.
 *
 * arbundles has TWO code paths and they disagree on ill-formed input:
 *   - byteLength <= 64: a hand-rolled loop that encodes an UNPAIRED surrogate
 *     as its raw code point in 3 bytes (WTF-8, e.g. U+D800 -> ED A0 80).
 *   - byteLength  > 64: Buffer.prototype.write, i.e. standard UTF-8, which
 *     substitutes U+FFFD (EF BF BD).
 * Both produce identical output for well-formed strings. The declared length is
 * Buffer.byteLength() in both cases (3 for a lone surrogate), so the two encodings
 * are the same width and the varint framing never desyncs.
 *
 * mode "arbundles" (default) reproduces that split exactly; mode "utf8" always
 * emits standard UTF-8. See spec.md §"Known divergence: lone surrogates".
 */
function encodeStringBytes(s, mode) {
  const len = Buffer.byteLength(s, "utf8");
  if (mode === "utf8" || len > 64) return Buffer.from(s, "utf8");
  const buf = Buffer.alloc(len);
  let pos = 0;
  for (let i = 0; i < s.length; i++) {
    let c1 = s.charCodeAt(i);
    let c2;
    if (c1 < 0x80) {
      buf[pos++] = c1;
    } else if (c1 < 0x800) {
      buf[pos++] = (c1 >> 6) | 0xc0;
      buf[pos++] = (c1 & 0x3f) | 0x80;
    } else if ((c1 & 0xfc00) === 0xd800 && ((c2 = s.charCodeAt(i + 1)) & 0xfc00) === 0xdc00) {
      c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff);
      i++;
      buf[pos++] = (c1 >> 18) | 0xf0;
      buf[pos++] = ((c1 >> 12) & 0x3f) | 0x80;
      buf[pos++] = ((c1 >> 6) & 0x3f) | 0x80;
      buf[pos++] = (c1 & 0x3f) | 0x80;
    } else {
      buf[pos++] = (c1 >> 12) | 0xe0;
      buf[pos++] = ((c1 >> 6) & 0x3f) | 0x80;
      buf[pos++] = (c1 & 0x3f) | 0x80;
    }
  }
  return buf.subarray(0, pos);
}

/**
 * Serialize tags to the ANS-104 tag region.
 * Layout: zigzag(count) || (varlen(name) name varlen(value) value)* || 0x00
 * An empty array serializes to zero bytes (NOT to a bare 0x00 terminator).
 */
function serializeTags(tags, opts = {}) {
  const mode = opts.stringEncoding || "arbundles";
  if (!Array.isArray(tags)) throw new Error("tags must be an array");
  if (tags.length === 0) return Buffer.alloc(0);
  const out = [];
  writeVarLong(out, tags.length);
  for (const tag of tags) {
    if (typeof tag?.name !== "string" || typeof tag?.value !== "string")
      throw new Error("each tag must be {name:string, value:string}");
    for (const s of [tag.name, tag.value]) {
      const bytes = encodeStringBytes(s, mode);
      writeVarLong(out, Buffer.byteLength(s, "utf8"));
      for (const b of bytes) out.push(b);
    }
  }
  writeVarLong(out, 0); // terminating zero-length block
  const buf = Buffer.from(out);
  if (buf.length > MAX_TAG_BYTES)
    throw new Error(`Too many tag bytes (${buf.length} > ${MAX_TAG_BYTES})`);
  return buf;
}

function deserializeTags(buf) {
  const state = { pos: 0 };
  const tags = [];
  let n;
  while ((n = readVarLong(buf, state))) {
    if (n < 0) { n = -n; readVarLong(buf, state); } // negative count => a byte-size follows
    while (n--) {
      const readString = () => {
        const len = readVarLong(buf, state);
        const s = buf.subarray(state.pos, state.pos + len);
        if (state.pos + len > buf.length) throw new Error("tag string runs past end of buffer");
        state.pos += len;
        return s.toString("utf8");
      };
      const name = readString();
      const value = readString();
      tags.push({ name, value });
    }
  }
  return tags;
}

/* ---------------------------- *
 * Key handling (JWK, no deps)  *
 * ---------------------------- */

/** The 512-byte raw owner field is the RSA modulus, big-endian. */
function ownerFromJwk(jwk) {
  const n = Buffer.from(jwk.n, "base64url");
  if (n.length !== SIG_CONFIG[SIG_TYPE_ARWEAVE].ownerLength)
    throw new Error(`owner must be 512 bytes, got ${n.length}`);
  return n;
}

function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: { ...jwk, kty: "RSA" }, format: "jwk" });
}

/**
 * Build a public key from the raw owner field alone.
 * NOTE: the public exponent is NOT carried on the wire. Every Arweave
 * implementation hardcodes e = 65537 ("AQAB"). See spec.md.
 */
function publicKeyFromOwner(rawOwner) {
  return createPublicKey({
    key: { kty: "RSA", n: Buffer.from(rawOwner).toString("base64url"), e: "AQAB" },
    format: "jwk",
  });
}

/* -------------------------------- *
 * Data-item serialization & layout *
 * -------------------------------- */

/**
 * Build the unsigned data-item binary: every field populated, signature all zeroes.
 *   opts.data   Buffer | string | Uint8Array
 *   opts.tags   [{name,value}]         (optional)
 *   opts.target base64url string decoding to exactly 32 bytes (optional)
 *   opts.anchor 32-byte value; a string is taken as RAW UTF-8 BYTES, not base64url (optional)
 *   opts.owner  512-byte raw modulus
 */
function createDataItem(opts) {
  const sigType = opts.signatureType ?? SIG_TYPE_ARWEAVE;
  const cfg = SIG_CONFIG[sigType];
  if (!cfg) throw new Error(`unsupported signature type ${sigType}`);

  const owner = Buffer.from(opts.owner);
  if (owner.length !== cfg.ownerLength)
    throw new Error(`Owner must be ${cfg.ownerLength} bytes, but was incorrectly ${owner.length}`);

  const target = opts.target == null ? null
    : Buffer.isBuffer(opts.target) ? opts.target : Buffer.from(opts.target, "base64url");
  if (target && target.length !== 32)
    throw new Error(`Target must be 32 bytes but was incorrectly ${target.length}`);

  const anchor = opts.anchor == null ? null
    : Buffer.isBuffer(opts.anchor) ? opts.anchor : Buffer.from(opts.anchor); // raw bytes, not base64url
  if (anchor && anchor.length !== 32) throw new Error("Anchor must be 32 bytes");

  const tags = opts.tags ?? [];
  const tagBytes = tags.length > 0 ? serializeTags(tags, opts) : Buffer.alloc(0);

  const data = opts.data == null ? Buffer.alloc(0)
    : Buffer.isBuffer(opts.data) ? opts.data : Buffer.from(opts.data);

  const targetLength = 1 + (target ? target.length : 0);
  const anchorLength = 1 + (anchor ? anchor.length : 0);
  const tagsLength = 16 + tagBytes.length;

  const total = 2 + cfg.sigLength + cfg.ownerLength + targetLength + anchorLength + tagsLength + data.length;
  const bytes = Buffer.alloc(total); // signature region stays zero

  bytes.set(shortTo2ByteArray(sigType), 0);
  bytes.set(owner, 2 + cfg.sigLength);

  const targetStart = 2 + cfg.sigLength + cfg.ownerLength;
  bytes[targetStart] = target ? 1 : 0;
  if (target) bytes.set(target, targetStart + 1);

  const anchorStart = targetStart + targetLength;
  bytes[anchorStart] = anchor ? 1 : 0;
  if (anchor) bytes.set(anchor, anchorStart + 1);

  const tagsStart = anchorStart + anchorLength;
  bytes.set(longTo8ByteArray(tags.length), tagsStart);
  bytes.set(longTo8ByteArray(tagBytes.length), tagsStart + 8);
  if (tagBytes.length) bytes.set(tagBytes, tagsStart + 16);

  bytes.set(data, tagsStart + tagsLength);
  return bytes;
}

/** Resolve every field offset of a serialized item. */
function parseDataItem(binary) {
  const buf = Buffer.from(binary.buffer ?? binary, binary.byteOffset ?? 0, binary.length);
  if (buf.length < MIN_BINARY_SIZE) throw new Error("binary too short to be a data item");
  const sigType = byteArrayToLong(buf.subarray(0, 2));
  const cfg = SIG_CONFIG[sigType];
  if (!cfg) throw new Error("Unknown signature type: " + sigType);

  const sigStart = 2;
  const ownerStart = 2 + cfg.sigLength;
  const targetStart = ownerStart + cfg.ownerLength;
  const targetPresent = buf[targetStart] === 1;
  const anchorStart = targetStart + (targetPresent ? 33 : 1);
  const anchorPresent = buf[anchorStart] === 1;
  const tagsStart = anchorStart + (anchorPresent ? 33 : 1);
  const tagCount = byteArrayToLong(buf.subarray(tagsStart, tagsStart + 8));
  const tagBytesLen = byteArrayToLong(buf.subarray(tagsStart + 8, tagsStart + 16));
  const dataStart = tagsStart + 16 + tagBytesLen;

  return {
    signatureType: sigType,
    signatureLength: cfg.sigLength,
    ownerLength: cfg.ownerLength,
    offsets: { sigStart, ownerStart, targetStart, anchorStart, tagsStart, dataStart, totalLength: buf.length },
    rawSignature: buf.subarray(sigStart, sigStart + cfg.sigLength),
    rawOwner: buf.subarray(ownerStart, targetStart),
    rawTarget: targetPresent ? buf.subarray(targetStart + 1, targetStart + 33) : Buffer.alloc(0),
    rawAnchor: anchorPresent ? buf.subarray(anchorStart + 1, anchorStart + 33) : Buffer.alloc(0),
    tagCount,
    rawTags: buf.subarray(tagsStart + 16, tagsStart + 16 + tagBytesLen),
    rawData: buf.subarray(dataStart),
  };
}

/**
 * The exact message that gets signed: deepHash over the 8-element list
 * ["dataitem", "1", sigType, owner, target, anchor, tags, data].
 * Absent target/anchor participate as zero-length blobs — they are NOT skipped.
 */
function getSignatureData(binary) {
  const it = parseDataItem(binary);
  return deepHash([
    Buffer.from("dataitem", "utf8"),
    Buffer.from("1", "utf8"),
    Buffer.from(String(it.signatureType), "utf8"),
    it.rawOwner,
    it.rawTarget,
    it.rawAnchor,
    it.rawTags,
    it.rawData,
  ]);
}

/* --------------- *
 * Sign and verify *
 * --------------- */

/**
 * RSA-PSS as arbundles emits it:
 *   digest MGF1 = SHA-256, salt length = RSA_PSS_SALTLEN_MAX_SIGN.
 * For a 4096-bit modulus and SHA-256 that is emLen - hLen - 2 = 512 - 32 - 2 = 478 bytes.
 * NOT the digest length. This is the single most likely place a reimplementation
 * silently produces signatures the reference verifier rejects.
 */
function signMessage(jwk, message, opts = {}) {
  return createSign("sha256").update(message).sign({
    key: privateKeyFromJwk(jwk),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: opts.saltLength ?? constants.RSA_PSS_SALTLEN_MAX_SIGN,
  });
}

/**
 * strict:false (default) mirrors arbundles/arweave.js: no explicit saltLength, so
 * OpenSSL auto-recovers it and ANY salt length is accepted.
 * strict:true pins the salt length to the max, matching what a conformant signer emits.
 */
function verifyMessage(rawOwner, message, signature, opts = {}) {
  const params = { key: publicKeyFromOwner(rawOwner), padding: constants.RSA_PKCS1_PSS_PADDING };
  if (opts.strictSaltLength) params.saltLength = maxSaltLength(4096, 32);
  return createVerify("sha256").update(message).verify(params, signature);
}

/** emLen - hLen - 2, where emLen = ceil((modBits-1)/8). */
function maxSaltLength(modBits, hLen) {
  const emBits = modBits - 1;
  let emLen = Math.ceil(emBits / 8);
  if ((emBits & 7) === 0) emLen -= 1;
  return emLen - hLen - 2;
}

/** id = SHA-256 of the raw signature bytes. */
const idFromSignature = (sig) => sha256(sig);

/** Build, sign and stamp a data item. Returns the wire bytes plus id/signature. */
function signDataItem(jwk, opts = {}) {
  const binary = createDataItem({ ...opts, owner: opts.owner ?? ownerFromJwk(jwk) });
  const message = getSignatureData(binary);
  const signature = signMessage(jwk, message, opts);
  binary.set(signature, 2);
  const id = idFromSignature(signature);
  return { binary, signature, id, idB64Url: id.toString("base64url"), signatureData: message };
}

/** Full structural + cryptographic verification of a serialized item. */
function verifyDataItem(binary, opts = {}) {
  let it;
  try { it = parseDataItem(binary); } catch { return false; }
  if (it.rawTags.length > MAX_TAG_BYTES) return false;
  if (it.tagCount > 0) {
    try {
      if (deserializeTags(Buffer.from(it.rawTags)).length !== it.tagCount) return false;
    } catch { return false; }
  }
  return verifyMessage(it.rawOwner, getSignatureData(binary), it.rawSignature, opts);
}

module.exports = {
  SIG_CONFIG, MAX_TAG_BYTES, MIN_BINARY_SIZE,
  deepHash, serializeTags, deserializeTags, encodeStringBytes,
  longToNByteArray, byteArrayToLong,
  ownerFromJwk, privateKeyFromJwk, publicKeyFromOwner,
  createDataItem, parseDataItem, getSignatureData,
  signMessage, verifyMessage, maxSaltLength,
  idFromSignature, signDataItem, verifyDataItem,
};
