"use strict";
/**
 * Wallet-style signers: anything with a Solana `publicKey` and an async
 * `signMessage`, the shape every Solana wallet adapter has.
 *
 * The client calls `signMessage` exactly once per item, with the 96 ASCII bytes
 * of the lowercase hex of the item's 48-byte deep hash. That is the ANS-104
 * type 4 convention, the same bytes @ardrive/turbo-sdk hands a wallet adapter.
 *
 * EVERY SIGNATURE IS VERIFIED BEFORE IT IS USED. Wallets that sign those bytes
 * raw (Phantom, Backpack and Solflare, observed) produce a valid item. But the
 * wallet-standard `signMessage` lets a wallet prefix or wrap a message, and a
 * hardware wallet refuses bytes that are not a transaction or an off-chain
 * message. An unverified signature would become an item that verifies nowhere,
 * found out after paying for it. So a signature that does not verify, a
 * `signMessage` that throws, and a result that is not 64 bytes are all one
 * error, TurboSignerError, and nothing is uploaded.
 */

const { decodeBase58 } = require("./base58.js");
const { toBytes, toHex, utf8Encode } = require("./bytes.js");
const { TurboConfigError, TurboSignerError } = require("./errors.js");

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** Appended to every TurboSignerError: the usual cause, and that nothing was spent. */
const WHY =
  " A hardware wallet (a Ledger, directly or as an account inside a browser wallet) " +
  "cannot sign data items: it signs transactions and off-chain messages, not raw bytes. " +
  "Nothing was uploaded and nothing was charged.";

/**
 * A public key as 32 bytes, from the forms wallets and libraries use: raw
 * bytes, a base58 string, or an object with
 * `toBytes()` (web3.js PublicKey) or `toBuffer()`.
 */
function publicKeyBytes(publicKey) {
  if (publicKey == null) {
    throw new TurboConfigError(
      "`signer.publicKey` is missing. A wallet adapter has no public key until it is connected: connect it first.",
    );
  }
  let bytes;
  if (typeof publicKey === "string") {
    try {
      bytes = decodeBase58(publicKey.trim());
    } catch (cause) {
      throw new TurboConfigError(`\`signer.publicKey\` is not valid base58: ${cause.message}`, { cause });
    }
  } else if (publicKey instanceof Uint8Array || ArrayBuffer.isView(publicKey) || Array.isArray(publicKey)) {
    bytes = toBytes(publicKey);
  } else if (typeof publicKey.toBytes === "function") {
    bytes = toBytes(publicKey.toBytes());
  } else if (typeof publicKey.toBuffer === "function") {
    bytes = toBytes(publicKey.toBuffer());
  } else {
    throw new TurboConfigError(
      "`signer.publicKey` must be 32 bytes, a base58 string, or an object with toBytes(), " +
        `got ${typeof publicKey}.`,
    );
  }
  if (bytes.length !== PUBLIC_KEY_BYTES) {
    throw new TurboConfigError(`\`signer.publicKey\` must be ${PUBLIC_KEY_BYTES} bytes, got ${bytes.length}.`);
  }
  return Uint8Array.from(bytes);
}

/**
 * Validate a wallet-style signer and read its public key once.
 *
 * Unknown keys are deliberately allowed, unlike every other options object in
 * this package: a wallet adapter carries dozens of its own (name, icon,
 * connect, ...), and passing the adapter itself is the common case.
 *
 * @returns {{publicKey: Uint8Array, signMessage: Function, verify?: Function}}
 */
function normalizeSigner(signer) {
  if (signer === null || typeof signer !== "object") {
    throw new TurboConfigError(`\`signer\` must be an object with publicKey and signMessage, got ${signer === null ? "null" : typeof signer}.`);
  }
  if (typeof signer.signMessage !== "function") {
    throw new TurboConfigError("`signer.signMessage` must be a function: (message: Uint8Array) => Promise<Uint8Array>.");
  }
  if (signer.verify !== undefined && typeof signer.verify !== "function") {
    throw new TurboConfigError("`signer.verify` must be a function: (message, signature, publicKey) => boolean | Promise<boolean>.");
  }
  return {
    publicKey: publicKeyBytes(signer.publicKey),
    signMessage: (message) => signer.signMessage(message),
    verify: signer.verify ? (message, signature, publicKey) => signer.verify(message, signature, publicKey) : undefined,
  };
}

/** The 64 signature bytes out of whatever a wallet returned. */
function signatureFrom(result) {
  if (result instanceof Uint8Array || ArrayBuffer.isView(result)) return toBytes(result);
  if (Array.isArray(result) && result.length === SIGNATURE_BYTES) return Uint8Array.from(result);
  // Phantom's injected provider returns { signature, publicKey }.
  if (result && typeof result === "object" && result.signature != null) return signatureFrom(result.signature);
  return null;
}

/**
 * Ed25519 verification through WebCrypto, where the runtime has it.
 *
 * @returns {Promise<boolean|undefined>} undefined when the runtime cannot verify Ed25519
 */
async function webCryptoVerifyEd25519(publicKey, message, signature) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return undefined;
  let key;
  try {
    key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch (err) {
    // NotSupportedError: this runtime has no Ed25519. Anything else is a key
    // that is not a curve point, which cannot verify anything.
    return err && err.name === "NotSupportedError" ? undefined : false;
  }
  try {
    return await subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

/**
 * Have the wallet sign one item's signature data, and verify the result.
 *
 * @param {{publicKey: Uint8Array, signMessage: Function, verify?: Function}} signer normalized
 * @param {Uint8Array} signatureData the 48-byte deep hash
 * @param {(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean} [platformVerify]
 *   synchronous Ed25519 the build carries (Node has one; the web build does not)
 * @returns {Promise<Uint8Array>} the 64-byte signature, verified
 */
async function signWithWallet(signer, signatureData, platformVerify) {
  const message = utf8Encode(toHex(signatureData));

  let result;
  try {
    result = await signer.signMessage(message);
  } catch (cause) {
    throw new TurboSignerError(`The signer's signMessage failed: ${cause && cause.message ? cause.message : cause}.${WHY}`, { cause });
  }
  const signature = signatureFrom(result);
  if (!signature || signature.length !== SIGNATURE_BYTES) {
    throw new TurboSignerError(
      `The signer's signMessage returned ${signature ? `${signature.length} bytes` : typeof result}, ` +
        `not a ${SIGNATURE_BYTES}-byte Ed25519 signature.${WHY}`,
    );
  }

  let verified;
  try {
    if (platformVerify) verified = platformVerify(signer.publicKey, message, signature);
    else if (signer.verify) verified = await signer.verify(message, signature, signer.publicKey);
    else verified = await webCryptoVerifyEd25519(signer.publicKey, message, signature);
  } catch (cause) {
    throw new TurboSignerError(`Verifying the signer's signature threw: ${cause && cause.message ? cause.message : cause}.`, { cause });
  }
  if (verified === undefined) {
    throw new TurboSignerError(
      "This runtime cannot verify an Ed25519 signature (no WebCrypto Ed25519), and every wallet " +
        "signature is verified before upload. Pass `signer.verify(message, signature, publicKey)`, " +
        "for example a wrapper over @noble/ed25519's `verify`.",
    );
  }
  if (verified !== true) {
    throw new TurboSignerError(
      "The signer returned a signature that does not verify against its public key over the " +
        "message it was given. The wallet most likely signed something else: some wallets prefix " +
        `or wrap a message before signing it.${WHY}`,
    );
  }
  return signature;
}

module.exports = {
  normalizeSigner,
  publicKeyBytes,
  signWithWallet,
  webCryptoVerifyEd25519,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
};
