"use strict";
/**
 * TurboUpload for browsers, workers and jsdom: the shared client with plain
 * JavaScript hashing and Uint8Array in place of Buffer.
 *
 * It signs through a wallet-style signer only. A raw key is refused: a secret
 * key held in a page is readable by every script on it, and the wallet is the
 * thing designed to hold it. Signing is the only async step, so the core stays
 * synchronous and there is no browser version floor beyond fetch and
 * Uint8Array.
 *
 * Nothing reachable from here may use a `node:` module, Buffer or process;
 * test/zero-deps.test.js checks the whole graph and test/web.test.js runs it in
 * a context that has none of them.
 */

const core = require("../core/ans104.js");
const { jsHashes } = require("../core/sha2.js");
const { utf8Encode, toHex } = require("../core/bytes.js");
const { TurboUploadCore, assertKnownOptions } = require("../core/client.js");
const { webCryptoVerifyEd25519 } = require("../core/signer.js");
const { TurboConfigError, TurboValidationError } = require("../core/errors.js");

const WEB_PLATFORM = Object.freeze({
  hashes: jsHashes,
  output: (bytes) => bytes,
  createDataItem: (opts) => core.createDataItem(opts),
  getSignatureData: (binary) => core.getSignatureData(binary, jsHashes),
  // No synchronous Ed25519 here: a wallet's signature is checked by the
  // signer's own `verify`, or WebCrypto where the runtime has Ed25519.
  verifyEd25519Raw: undefined,
  signSync: undefined,
  signSignatureData: undefined,
  loadKey() {
    throw new TurboConfigError(
      "The web build signs through a wallet-style `signer` ({ publicKey, signMessage }), not a raw key: " +
        "a secret key in a page is readable by every script on it. Pass `signer`, or use the Node build " +
        "(@ardrive/turbo-upload/node) on a server.",
    );
  },
});

class TurboUpload extends TurboUploadCore {
  /**
   * @param {object} options
   * @param {object} options.signer { publicKey, signMessage, verify? }, a wallet adapter works as is
   * @param {string} [options.uploadUrl]  default https://upload.ardrive.io
   * @param {string} [options.paymentUrl] default https://payment.ardrive.io
   * @param {number} [options.timeoutMs]  default 60000, per request
   * @param {object|false} [options.retry]
   * @param {"solana"} [options.token]
   * @param {typeof fetch} [options.fetch]
   */
  constructor(options = {}) {
    super(options, WEB_PLATFORM);
  }

  /**
   * Verify a serialized type 4 item. Asynchronous here, unlike the Node build,
   * because the browser's Ed25519 is: it uses the signer's `verify` when this
   * client has one, otherwise WebCrypto.
   *
   * @returns {Promise<boolean>}
   */
  async verify(binary, opts = {}) {
    assertKnownOptions(opts, [], "verify()", TurboValidationError);
    const signer = this._walletSigner;
    return verifyDataItem(binary, { verify: signer && signer.verify });
  }
}

/**
 * Verify a serialized type 4 (Solana) data item, in any runtime.
 *
 * Structure first (offsets, the tag count re-parsed against the declared
 * one), then the signature over the hex of the deep hash. `verify` is an
 * Ed25519 verifier `(message, signature, publicKey) => boolean | Promise`;
 * without one, WebCrypto is used, and a runtime with neither throws rather
 * than answering false for an item it never checked.
 *
 * Type 1 (Arweave RSA) items are refused: verifying RSA-PSS with a 478-byte
 * salt is a Node build feature.
 *
 * @returns {Promise<boolean>}
 */
async function verifyDataItem(binary, opts = {}) {
  assertKnownOptions(opts, ["verify"], "verifyDataItem()", TurboValidationError);
  const it = core.parseAndCheckStructure(binary);
  if (!it) return false;
  if (it.signatureType !== core.SIG_TYPE_SOLANA) {
    throw new TurboValidationError(
      `The web build verifies type 4 (Solana) items only; this is type ${it.signatureType}. Use the Node build.`,
    );
  }
  const signatureData = core.deepHash(core.signatureDataChunks({ ...it, data: it.rawData }), jsHashes);
  const message = utf8Encode(toHex(signatureData));
  const publicKey = Uint8Array.from(it.rawOwner);
  const signature = Uint8Array.from(it.rawSignature);
  const verified = opts.verify
    ? await opts.verify(message, signature, publicKey)
    : await webCryptoVerifyEd25519(publicKey, message, signature);
  if (verified === undefined) {
    throw new TurboValidationError(
      "This runtime cannot verify Ed25519 (no WebCrypto Ed25519). Pass `verify`, for example @noble/ed25519's.",
    );
  }
  return verified === true;
}

module.exports = { TurboUpload, verifyDataItem };
