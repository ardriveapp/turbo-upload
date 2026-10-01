"use strict";
/**
 * ANS-104 data-item signing for the Node build: signature type 1 (Arweave,
 * RSA-4096 / RSA-PSS-SHA256) and type 4 (Solana, Ed25519, in ./ed25519.js).
 *
 * Dependencies: node:crypto and node:buffer. Nothing else, ever.
 *
 * The format itself, byte layout, tag encoding and the deep hash, lives in
 * ./core/ans104.js, which the web build shares. This file injects node:crypto
 * as the hash, adds RSA signing and verification, and returns a Buffer
 * wherever it always has: every function here keeps the signature and return
 * type it had before the core was extracted.
 *
 * Do not "clean up" anything marked DE-FACTO, here or in the core. Each one is
 * a deliberate bug-for-bug match with @dha-team/arbundles@1.0.4, and each has a
 * vector that fails if you remove it.
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
const core = require("./core/ans104.js");

const {
  SIG_CONFIG,
  SIG_TYPE_ARWEAVE,
  SIG_TYPE_SOLANA,
  MAX_TAG_BYTES,
  MIN_BINARY_SIZE,
  MIN_ITEM_SIZE,
  longToNByteArray: coreLongToNByteArray,
  byteArrayToLong,
} = core;

/** A Buffer view of a Uint8Array, no copy. The core returns Uint8Array; this build returns Buffer. */
const asBuffer = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));

const sha384 = (b) => createHash("sha384").update(b).digest();
const sha256 = (b) => createHash("sha256").update(b).digest();

/** The hash set this build injects into the core: node:crypto, synchronous. */
const nodeHashes = Object.freeze({
  sha256,
  sha384,
  createSha384: () => createHash("sha384"),
});

const longToNByteArray = (n, value) => asBuffer(coreLongToNByteArray(n, value));

/**
 * deepHash over a tree of byte strings. The transcript is documented in
 * ./core/ans104.js.
 *
 * @param {Buffer|Uint8Array|string|Array} chunk
 * @returns {Buffer} 48-byte SHA-384 digest
 */
const deepHash = (chunk) => asBuffer(core.deepHash(chunk, nodeHashes));

/**
 * Serialize tags to the ANS-104 tag region. See ./core/ans104.js.
 *
 * @param {Array<{name:string,value:string}>} tags
 * @param {{stringEncoding?: "arbundles"|"utf8"}} [opts]
 * @returns {Buffer}
 */
const serializeTags = (tags, opts) => asBuffer(core.serializeTags(tags, opts));

/** Parse a serialized tag region back into tags. */
const deserializeTags = (buf) => core.deserializeTags(buf);

/** arbundles' tag string encoder, DE-FACTO quirks and all. See ./core/ans104.js. */
const encodeStringBytes = (s, mode) => asBuffer(core.encodeStringBytes(s, mode));

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
 * A `target` given as a string is decoded here, with Buffer's base64url
 * decoder, rather than in the core: Buffer skips characters outside the
 * alphabet where the core's decoder refuses them, and this build keeps the
 * behaviour it has always had.
 */
const nodeTarget = (target) => (typeof target === "string" ? Buffer.from(target, "base64url") : target);

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
  return asBuffer(core.createDataItem({ ...opts, target: nodeTarget(opts.target) }));
}

/**
 * Resolve every field offset of a serialized item.
 *
 * Every raw field is a Buffer view into the input, as it always was.
 */
function parseDataItem(binary) {
  const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary.buffer ?? binary, binary.byteOffset ?? 0, binary.length);
  const it = core.parseDataItem(buf);
  for (const field of ["rawSignature", "rawOwner", "rawTarget", "rawAnchor", "rawTags", "rawData"]) {
    it[field] = asBuffer(it[field]);
  }
  return it;
}

/**
 * The exact 48-byte message that gets signed: deepHash over the 8-element list
 *   ["dataitem", "1", String(sigType), owner, target, anchor, tags, data]
 *
 * DE-FACTO details are in ./core/ans104.js.
 */
function getSignatureData(binary) {
  const it = parseDataItem(binary);
  return asBuffer(core.deepHash(core.signatureDataChunks({ ...it, data: it.rawData }), nodeHashes));
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
  // A Solana key arrives as a seed rather than a JWK, and signs the hex of the
  // signature data. ed25519.js owns that step so no caller can skip it.
  const signature =
    opts.signatureType === SIG_TYPE_SOLANA
      ? require("./ed25519.js").signEd25519(opts.seed, signatureData)
      : signMessage(jwk, signatureData, opts);
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
    const signatureData = getSignatureData(binary);
    if (it.signatureType === SIG_TYPE_SOLANA) {
      // Lazily required: ed25519.js imports errors.js, and importing it at the
      // top of this file would close a cycle.
      const { verifyEd25519 } = require("./ed25519.js");
      return verifyEd25519(Buffer.from(it.rawOwner), signatureData, Buffer.from(it.rawSignature));
    }
    return verifyMessage(it.rawOwner, signatureData, it.rawSignature, opts);
  } catch {
    return false;
  }
}

module.exports = {
  SIG_CONFIG,
  SIG_TYPE_ARWEAVE,
  SIG_TYPE_SOLANA,
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
  nodeHashes,
  asBuffer,
};
