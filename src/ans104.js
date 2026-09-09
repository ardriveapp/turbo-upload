"use strict";
/**
 * ANS-104 data-item signing, signature type 1 (Arweave, RSA-4096 / RSA-PSS-SHA256).
 *
 * Dependencies: node:crypto and node:buffer. Nothing else, ever.
 *
 * Byte layout, deep-hash transcript and tag encoding are pinned by
 * vectors/vectors.json, 22 conformance vectors generated from
 * @dha-team/arbundles@1.0.4, the de-facto reference implementation that the
 * gateways and bundlers actually run. Where ANS-104 is silent, arbundles'
 * behaviour is the answer; those places are commented DE-FACTO below.
 *
 * Do not "clean up" anything marked DE-FACTO. Each one is a deliberate
 * bug-for-bug match, and each has a vector that fails if you remove it.
 */

const {
  createHash,
  createSign,
  createVerify,
  createPrivateKey,
  createPublicKey,
  constants,
} = require("node:crypto");
const { Buffer } = require("node:buffer");
const { TurboValidationError } = require("./errors.js");

/** ANS-104 §2.2 signature registry. Only type 1 (Arweave RSA) is implemented. */
const SIG_CONFIG = {
  1: { name: "arweave", sigLength: 512, ownerLength: 512, modulusBits: 4096 },
};
const SIG_TYPE_ARWEAVE = 1;

/** Cap on the serialized tag region, on BYTES, not tag count. Enforced on read and write. */
const MAX_TAG_BYTES = 4096;

/** arbundles refuses to parse anything shorter. */
const MIN_BINARY_SIZE = 80;

/** The smallest legal item: 2 + 512 + 512 + 1 + 1 + 16, no target/anchor/tags/data. */
const MIN_ITEM_SIZE = 1044;

/* ------------------------------------------------------------------ *
 * Little-endian unsigned integers                                     *
 * ------------------------------------------------------------------ */

function longToNByteArray(n, value) {
  if (value < 0) throw new TurboValidationError("unsigned only, cannot represent negative numbers");
  const out = Buffer.alloc(n);
  let v = value;
  for (let i = 0; i < n; i++) {
    const byte = v & 0xff;
    out[i] = byte;
    v = (v - byte) / 256;
  }
  if (v !== 0) throw new TurboValidationError(`value ${value} does not fit in ${n} bytes`);
  return out;
}
const shortTo2ByteArray = (v) => longToNByteArray(2, v);
const longTo8ByteArray = (v) => longToNByteArray(8, v);

function byteArrayToLong(bytes) {
  let value = 0;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + bytes[i];
  return value;
}

/* ------------------------------------------------------------------ *
 * deepHash, Arweave's SHA-384 structured transcript hash             *
 * ------------------------------------------------------------------ */

const sha384 = (b) => createHash("sha384").update(b).digest();
const sha256 = (b) => createHash("sha256").update(b).digest();

/**
 * deepHash over a tree of byte strings.
 *
 *   blob b := SHA384( SHA384("blob" || decimal_ascii(len(b))) || SHA384(b) )
 *   list L := acc = SHA384("list" || decimal_ascii(len(L)))
 *             for each child c: acc = SHA384(acc || deepHash(c))
 *
 * The length is its DECIMAL ASCII representation, concatenated with no
 * separator, the tag for a 512-byte blob is the 7 bytes `blob512`.
 *
 * @param {Buffer|Uint8Array|string|Array} chunk
 * @returns {Buffer} 48-byte SHA-384 digest
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

/* ------------------------------------------------------------------ *
 * Tags, Avro binary encoding of array<record{name:string,value:string}> *
 * ------------------------------------------------------------------ */

/** Avro zigzag varint. 1 -> 0x02, 64 -> 0x80 0x01. */
function writeVarLong(out, n) {
  let m = n >= 0 ? n * 2 : -n * 2 - 1;
  for (;;) {
    const b = m & 0x7f;
    m = Math.floor(m / 128);
    if (m === 0) {
      out.push(b);
      return;
    }
    out.push(b | 0x80);
  }
}

function readVarLong(buf, state) {
  let n = 0;
  let k = 0;
  let b;
  do {
    b = buf[state.pos++];
    if (b === undefined) throw new TurboValidationError("varint ran off the end of the buffer");
    n += (b & 0x7f) * Math.pow(2, k);
    k += 7;
  } while (b & 0x80);
  return n % 2 ? -(n + 1) / 2 : n / 2;
}

/**
 * UTF-8 encode a tag string the way arbundles' AVSCTap.writeString does.
 *
 * DE-FACTO: arbundles has TWO encoders and they disagree on ill-formed input.
 *   byteLength <= 64 -> a hand-rolled loop that writes an UNPAIRED UTF-16
 *                       surrogate as its raw code point (WTF-8: U+D800 -> ED A0 80)
 *   byteLength  > 64 -> Buffer.prototype.write, i.e. standard UTF-8, which
 *                       substitutes U+FFFD (EF BF BD)
 *
 * For every well-formed string the two agree with each other and with standard
 * UTF-8, so this only matters for lone surrogates, which JS strings can hold
 * and most other languages' strings cannot. The declared length is
 * Buffer.byteLength (3 either way), so the varint framing never desyncs: the
 * item stays structurally valid and verifiable, it just gets a DIFFERENT ID
 * than a strict-UTF-8 implementation would produce for the same input.
 *
 * Vectors `lone-surrogate-tag-short` / `lone-surrogate-tag-long` pin both sides.
 * mode "utf8" forces standard UTF-8 and is only useful for comparing against
 * a strict implementation.
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
 *
 *   zigzag(count) || (varint(len(name)) name varint(len(value)) value)* || 0x00
 *
 * DE-FACTO: an EMPTY tag list serializes to ZERO bytes, not to a bare 0x00
 * terminator. Order is preserved and never sorted; duplicate names are legal;
 * empty names and empty values are legal.
 *
 * @param {Array<{name:string,value:string}>} tags
 * @param {{stringEncoding?: "arbundles"|"utf8"}} [opts]
 * @returns {Buffer}
 */
function serializeTags(tags, opts = {}) {
  const mode = opts.stringEncoding || "arbundles";
  if (!Array.isArray(tags)) throw new TurboValidationError("tags must be an array of {name, value}");
  if (tags.length === 0) return Buffer.alloc(0);
  const out = [];
  writeVarLong(out, tags.length);
  for (const tag of tags) {
    if (typeof tag?.name !== "string" || typeof tag?.value !== "string") {
      throw new TurboValidationError(
        `Invalid tag format for ${JSON.stringify(tag)}, expected {name: string, value: string}`,
      );
    }
    for (const s of [tag.name, tag.value]) {
      const bytes = encodeStringBytes(s, mode);
      // The declared length is the UTF-8 BYTE length, not the character count
      // and not the UTF-16 code-unit count.
      writeVarLong(out, Buffer.byteLength(s, "utf8"));
      for (const b of bytes) out.push(b);
    }
  }
  writeVarLong(out, 0); // terminating zero-length block
  const buf = Buffer.from(out);
  if (buf.length > MAX_TAG_BYTES) {
    throw new TurboValidationError(`Too many tag bytes (${buf.length} > ${MAX_TAG_BYTES})`);
  }
  return buf;
}

/** Parse a serialized tag region back into tags. */
function deserializeTags(buf) {
  const state = { pos: 0 };
  const tags = [];
  let n;
  while ((n = readVarLong(buf, state))) {
    if (n < 0) {
      // A negative count means a byte-size follows (Avro blocked-array form).
      n = -n;
      readVarLong(buf, state);
    }
    while (n--) {
      const readString = () => {
        const len = readVarLong(buf, state);
        if (state.pos + len > buf.length) {
          throw new TurboValidationError("tag string runs past the end of the buffer");
        }
        const s = buf.subarray(state.pos, state.pos + len);
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

/* ------------------------------------------------------------------ *
 * Keys                                                                *
 * ------------------------------------------------------------------ */

/** The 512-byte owner field is the RSA modulus `n`, big-endian. */
function ownerFromJwk(jwk) {
  const n = Buffer.from(jwk.n, "base64url");
  if (n.length !== SIG_CONFIG[SIG_TYPE_ARWEAVE].ownerLength) {
    throw new TurboValidationError(
      `owner must be ${SIG_CONFIG[SIG_TYPE_ARWEAVE].ownerLength} bytes (a 4096-bit RSA modulus), got ${n.length}`,
    );
  }
  return n;
}

function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: { ...jwk, kty: "RSA" }, format: "jwk" });
}

/**
 * Rebuild the public key from the raw owner field alone.
 *
 * DE-FACTO: the public exponent is NOT carried on the wire. Every Arweave
 * implementation hardcodes e = 65537 ("AQAB"). A key with any other exponent
 * cannot be represented in this format.
 */
function publicKeyFromOwner(rawOwner) {
  return createPublicKey({
    key: { kty: "RSA", n: Buffer.from(rawOwner).toString("base64url"), e: "AQAB" },
    format: "jwk",
  });
}

/** The Arweave wallet address: base64url(SHA-256(owner)). Distinct from a data-item id. */
function addressFromOwner(rawOwner) {
  return sha256(Buffer.from(rawOwner)).toString("base64url");
}

/* ------------------------------------------------------------------ *
 * Item layout                                                         *
 * ------------------------------------------------------------------ */

/**
 * Build the unsigned data-item binary: all fields populated, signature zeroed.
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array|string} [opts.data]
 * @param {Array<{name:string,value:string}>} [opts.tags]
 * @param {string|Buffer} [opts.target] base64url string decoding to exactly 32 bytes
 * @param {string|Buffer} [opts.anchor] 32 RAW bytes, a string is its UTF-8 bytes, NOT base64url
 * @param {Buffer} opts.owner 512-byte raw modulus
 * @returns {Buffer}
 */
function createDataItem(opts) {
  const sigType = opts.signatureType ?? SIG_TYPE_ARWEAVE;
  const cfg = SIG_CONFIG[sigType];
  if (!cfg) throw new TurboValidationError(`unsupported signature type ${sigType} (only 1 / arweave is implemented)`);

  const owner = Buffer.from(opts.owner);
  if (owner.length !== cfg.ownerLength) {
    throw new TurboValidationError(`Owner must be ${cfg.ownerLength} bytes, but was incorrectly ${owner.length}`);
  }

  // DE-FACTO, and the trap everybody hits: `target` is base64url-decoded but
  // `anchor` is taken as RAW BYTES. Two adjacent 32-byte fields, two opposite
  // string conventions. A 43-char base64url anchor therefore throws.
  const target =
    opts.target == null
      ? null
      : Buffer.isBuffer(opts.target)
        ? opts.target
        : ArrayBuffer.isView(opts.target)
          ? Buffer.from(opts.target.buffer, opts.target.byteOffset, opts.target.byteLength)
          : Buffer.from(opts.target, "base64url");
  if (target && target.length !== 32) {
    throw new TurboValidationError(
      `Target must be 32 bytes but was incorrectly ${target.length}. ` +
        `A string target is base64url-decoded (43 characters).`,
    );
  }

  const anchor =
    opts.anchor == null
      ? null
      : Buffer.isBuffer(opts.anchor)
        ? opts.anchor
        : ArrayBuffer.isView(opts.anchor)
          ? Buffer.from(opts.anchor.buffer, opts.anchor.byteOffset, opts.anchor.byteLength)
          : Buffer.from(opts.anchor); // raw UTF-8 bytes, NOT base64url
  if (anchor && anchor.length !== 32) {
    throw new TurboValidationError(
      `Anchor must be 32 bytes, got ${anchor.length}. ` +
        `Unlike target, a string anchor is used as RAW BYTES, not base64url, ` +
        `pass 32 raw bytes or a 32-character string.`,
    );
  }

  const tags = opts.tags ?? [];
  const tagBytes = tags.length > 0 ? serializeTags(tags, opts) : Buffer.alloc(0);

  const data =
    opts.data == null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(opts.data)
        ? opts.data
        : ArrayBuffer.isView(opts.data)
          ? Buffer.from(opts.data.buffer, opts.data.byteOffset, opts.data.byteLength)
          : Buffer.from(opts.data);

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

/**
 * Resolve every field offset of a serialized item.
 *
 * Offsets past byte 1026 are CHAINED, not fixed: walk the presence bytes.
 * DE-FACTO: a presence byte is tested `=== 1`; any other value means absent.
 */
function parseDataItem(binary) {
  const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary.buffer ?? binary, binary.byteOffset ?? 0, binary.length);
  if (buf.length < MIN_BINARY_SIZE) throw new TurboValidationError("binary too short to be a data item");
  const sigType = byteArrayToLong(buf.subarray(0, 2));
  const cfg = SIG_CONFIG[sigType];
  if (!cfg) throw new TurboValidationError(`Unknown signature type: ${sigType}`);

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
 * The exact 48-byte message that gets signed: deepHash over the 8-element list
 *   ["dataitem", "1", String(sigType), owner, target, anchor, tags, data]
 *
 * DE-FACTO: absent target/anchor participate as ZERO-LENGTH blobs, they are not
 * skipped, the list is always 8 long. Element 2 is the ANS-104 format version
 * and element 3 is the signature type as DECIMAL ASCII; both are "1" for type 1
 * and they are different things.
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

/* ------------------------------------------------------------------ *
 * Signing                                                             *
 * ------------------------------------------------------------------ */

/** emLen - hLen - 2, where emLen = ceil((modBits - 1) / 8). */
function maxSaltLength(modBits, hLen) {
  const emBits = modBits - 1;
  let emLen = Math.ceil(emBits / 8);
  if ((emBits & 7) === 0) emLen -= 1;
  return emLen - hLen - 2;
}

/**
 * 478 bytes. THE most important constant in this package.
 *
 * WHY 478 AND NOT 32, read this before changing anything here.
 *
 * arbundles signs with Node's `createSign("sha256").sign({key, padding:
 * RSA_PKCS1_PSS_PADDING})` and does NOT set saltLength. Node's default for
 * SIGNING is RSA_PSS_SALTLEN_MAX_SIGN, the maximum the modulus allows:
 *
 *     emBits = modBits - 1     = 4095
 *     emLen  = ceil(emBits/8)  = 512
 *     sLen   = emLen - hLen - 2 = 512 - 32 - 2 = 478
 *
 * Almost every other crypto library defaults PSS to the DIGEST length (32).
 * That produces a structurally valid signature that verifies fine today, and
 * is non-conformant. It does not fail loudly, because verification is
 * salt-agnostic: arbundles verifies through arweave.js, which also passes no
 * saltLength, and Node's default for VERIFYING is RSA_PSS_SALTLEN_AUTO, which
 * recovers the salt length from the encoded message and accepts ANY value. In
 * Node both constants are literally -2, which is how one omitted parameter
 * means "maximum" when signing and "anything" when verifying.
 *
 * So: a 32-byte-salt signature passes every round-trip test, passes
 * cross-verification against the reference implementation, and is accepted by
 * the live service today. It would only fail later, at a stricter verifier.
 * That is why this is set EXPLICITLY rather than inherited from a Node default,
 * and why the test suite recovers the salt length off the wire (sig^e mod n,
 * unmask the DB with MGF1, count the bytes) instead of trusting this constant.
 */
const PSS_SALT_LENGTH_BYTES = maxSaltLength(SIG_CONFIG[SIG_TYPE_ARWEAVE].modulusBits, 32);

/**
 * Sign a message with RSA-PSS-SHA256, MGF1-SHA256, salt length 478.
 *
 * The message is the 48-byte deep hash, which PSS then hashes AGAIN with
 * SHA-256. Do not pre-hash it yourself and do not sign the item bytes.
 */
function signMessage(jwk, message, opts = {}) {
  return createSign("sha256")
    .update(message)
    .sign({
      key: opts.privateKey ?? privateKeyFromJwk(jwk),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: opts.saltLength ?? PSS_SALT_LENGTH_BYTES,
    });
}

/**
 * Verify a signature over a message given the raw owner bytes.
 *
 * Default (strictSaltLength: false) mirrors arbundles / arweave.js / the
 * gateways: no explicit saltLength, so OpenSSL auto-recovers it and accepts any
 * value. strictSaltLength: true pins 478 and is the ONLY check that catches a
 * non-conformant salt length.
 */
function verifyMessage(rawOwner, message, signature, opts = {}) {
  const params = { key: publicKeyFromOwner(rawOwner), padding: constants.RSA_PKCS1_PSS_PADDING };
  if (opts.strictSaltLength) params.saltLength = PSS_SALT_LENGTH_BYTES;
  try {
    return createVerify("sha256").update(message).verify(params, signature);
  } catch {
    return false;
  }
}

/** id = SHA-256 of the 512 raw signature bytes. Not of the item, not of the deep hash. */
const idFromSignature = (sig) => sha256(sig);

/**
 * Build, sign and stamp a data item.
 *
 * RSA-PSS draws a fresh random salt per signature, so signing identical input
 * twice yields different bytes and therefore a DIFFERENT ID. Ids are not
 * reproducible from the inputs alone.
 *
 * @returns {{binary: Buffer, signature: Buffer, id: Buffer, idB64Url: string, signatureData: Buffer}}
 */
function signDataItem(jwk, opts = {}) {
  const binary = createDataItem({ ...opts, owner: opts.owner ?? ownerFromJwk(jwk) });
  const signatureData = getSignatureData(binary);
  const signature = signMessage(jwk, signatureData, opts);
  binary.set(signature, 2);
  const id = idFromSignature(signature);
  return { binary, signature, id, idB64Url: id.toString("base64url"), signatureData };
}

/**
 * Full structural + cryptographic verification of a serialized item.
 *
 * Step order matters. Re-parsing the tag region and confirming the recovered
 * count equals the declared tag_count is not optional: without it, an item
 * whose tag region decodes to a different number of tags than it declares is
 * accepted, and two implementations disagree about what the item SAYS while
 * both agree the signature is valid.
 *
 * @param {Buffer|Uint8Array} binary
 * @param {{strictSaltLength?: boolean}} [opts]
 * @returns {boolean}
 */
function verifyDataItem(binary, opts = {}) {
  let it;
  try {
    it = parseDataItem(binary);
  } catch {
    return false;
  }
  if (it.rawTags.length > MAX_TAG_BYTES) return false;
  if (it.tagCount > 0) {
    try {
      if (deserializeTags(Buffer.from(it.rawTags)).length !== it.tagCount) return false;
    } catch {
      return false;
    }
  }
  try {
    return verifyMessage(it.rawOwner, getSignatureData(binary), it.rawSignature, opts);
  } catch {
    return false;
  }
}

module.exports = {
  SIG_CONFIG,
  SIG_TYPE_ARWEAVE,
  MAX_TAG_BYTES,
  MIN_BINARY_SIZE,
  MIN_ITEM_SIZE,
  PSS_SALT_LENGTH_BYTES,
  deepHash,
  serializeTags,
  deserializeTags,
  encodeStringBytes,
  longToNByteArray,
  byteArrayToLong,
  ownerFromJwk,
  privateKeyFromJwk,
  publicKeyFromOwner,
  addressFromOwner,
  createDataItem,
  parseDataItem,
  getSignatureData,
  signMessage,
  verifyMessage,
  maxSaltLength,
  idFromSignature,
  signDataItem,
  verifyDataItem,
};
