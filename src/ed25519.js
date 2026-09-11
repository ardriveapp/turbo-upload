"use strict";
/**
 * Ed25519 signing for Solana keys, ANS-104 signature type 4.
 *
 * No dependency, because Node has done Ed25519 natively since v12 and the
 * algorithm is deterministic (RFC 8032): the same key and message always give
 * the same 64 bytes. Verified against `@noble/ed25519`, which the reference
 * implementation uses, and the signatures are byte-identical.
 *
 * THE THING THAT GETS WRITTEN WRONG. Type 4 signs the LOWERCASE HEX STRING of
 * the signature data, not the signature data itself. `@dha-team/arbundles`'
 * `HexSolanaSigner` does `sign(Buffer.from(Buffer.from(message).toString("hex")))`,
 * and `@ardrive/turbo-sdk` uses that signer for `token: "solana"`. Signing the
 * raw bytes instead produces a valid Ed25519 signature over the wrong message,
 * which yields a different id, verifies nowhere, and costs money to discover.
 * `signEd25519` therefore takes the signature data and does the hex step
 * itself, so no caller can skip it.
 */
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { decodeBase58, encodeBase58 } = require("./base58.js");
const { TurboKeyError } = require("./errors.js");

/** Raw Ed25519 key material is 32 bytes in both directions. */
const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
/** A Solana secret key is the seed followed by the public key. */
const SECRET_KEY_BYTES = SEED_BYTES + PUBLIC_KEY_BYTES;

/** DER prefixes that turn raw 32-byte key material into something node:crypto accepts. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Derives the public key for a seed.
 *
 * @param {Buffer} seed 32 bytes
 * @returns {Buffer} 32 bytes
 */
function publicKeyFromSeed(seed) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = crypto.createPublicKey(key).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

/**
 * Parses a Solana key into its seed and public key.
 *
 * Accepts what a Solana user actually holds: a base58 secret key (64 bytes, the
 * Phantom and solana-keygen format), the same 64 bytes raw, or a bare 32-byte
 * seed. A JSON array of 64 numbers is also accepted, because that is what
 * `solana-keygen` writes to disk.
 *
 * A 64-byte key carries its own public key, and that half is CHECKED rather
 * than trusted: a key whose halves disagree is corrupt, and the failure it
 * would otherwise cause is a signature nobody can verify, discovered after
 * paying to upload it.
 *
 * @param {string|Buffer|Uint8Array|number[]} input
 * @returns {{ seed: Buffer, publicKey: Buffer, address: string }}
 */
function parseSolanaKey(input) {
  if (input === undefined || input === null || input === "") {
    throw new TurboKeyError("A Solana key is required: pass a base58 secret key, a 64-byte secret key, or a 32-byte seed.");
  }

  let bytes;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (cause) {
        throw new TurboKeyError("The Solana key looks like a JSON array but is not valid JSON.", { cause });
      }
      bytes = Buffer.from(parsed);
    } else {
      try {
        bytes = decodeBase58(trimmed);
      } catch (cause) {
        throw new TurboKeyError(`The Solana key is not valid base58: ${cause.message}`, { cause });
      }
    }
  } else if (Array.isArray(input)) {
    bytes = Buffer.from(input);
  } else if (Buffer.isBuffer(input) || ArrayBuffer.isView(input)) {
    bytes = Buffer.from(input);
  } else {
    throw new TurboKeyError(`A Solana key must be a string, Buffer or array, got ${typeof input}.`);
  }

  if (bytes.length !== SECRET_KEY_BYTES && bytes.length !== SEED_BYTES) {
    throw new TurboKeyError(
      `A Solana key must be ${SECRET_KEY_BYTES} bytes (secret key) or ${SEED_BYTES} bytes (seed), got ${bytes.length}.`,
    );
  }

  const seed = bytes.subarray(0, SEED_BYTES);
  const publicKey = publicKeyFromSeed(seed);

  if (bytes.length === SECRET_KEY_BYTES) {
    const supplied = bytes.subarray(SEED_BYTES);
    if (!supplied.equals(publicKey)) {
      throw new TurboKeyError(
        "This Solana key is corrupt: the public key it carries is not the one its seed derives. " +
          "Signing with it would produce items nothing can verify.",
      );
    }
  }

  return { seed: Buffer.from(seed), publicKey, address: encodeBase58(publicKey) };
}

/**
 * Signs ANS-104 signature data as type 4.
 *
 * Takes the signature data and applies the hex step itself. Do not pre-encode.
 *
 * @param {Buffer} seed 32 bytes
 * @param {Buffer} signatureData the deep-hash output being signed
 * @returns {Buffer} 64 bytes
 */
function signEd25519(seed, signatureData) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, hexMessage(signatureData), key);
}

/**
 * Verifies a type 4 signature. Applies the same hex step as `signEd25519`.
 *
 * @param {Buffer} publicKey 32 bytes
 * @param {Buffer} signatureData
 * @param {Buffer} signature 64 bytes
 * @returns {boolean}
 */
function verifyEd25519(publicKey, signatureData, signature) {
  if (publicKey.length !== PUBLIC_KEY_BYTES || signature.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, hexMessage(signatureData), key, signature);
  } catch {
    return false;
  }
}

/** The type 4 convention: sign the lowercase hex of the bytes, not the bytes. */
function hexMessage(signatureData) {
  return Buffer.from(Buffer.from(signatureData).toString("hex"));
}

module.exports = {
  parseSolanaKey,
  signEd25519,
  verifyEd25519,
  publicKeyFromSeed,
  SEED_BYTES,
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
};
