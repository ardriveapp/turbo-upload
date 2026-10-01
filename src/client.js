"use strict";
/**
 * TurboUpload for Node: sign ANS-104 data items with an Arweave JWK, a Solana
 * key, or a wallet-style signer, and upload them to a Turbo upload service.
 *
 * The client itself is shared with the web build (src/core/client.js). What
 * this file adds is what only Node has: node:crypto for hashing and for RSA
 * and Ed25519, the key formats that go with them, and Buffer as the type every
 * method has always returned. See README for when to reach for
 * @ardrive/turbo-sdk instead.
 */

const { Buffer } = require("node:buffer");
const ans104 = require("./ans104.js");
const { loadJwk } = require("./jwk.js");
const { parseSolanaKey, verifyEd25519Raw, signEd25519 } = require("./ed25519.js");
const { TurboUploadCore, assertKnownOptions } = require("./core/client.js");
const { TurboValidationError } = require("./errors.js");

/** What the Node build provides the shared client. */
const NODE_PLATFORM = Object.freeze({
  hashes: ans104.nodeHashes,
  output: ans104.asBuffer,
  createDataItem: (opts) => ans104.createDataItem(opts),
  getSignatureData: (binary) => ans104.getSignatureData(binary),
  // Node checks a wallet's signature itself, rather than trusting the
  // signer's own `verify`: node:crypto is always here.
  verifyEd25519Raw: (publicKey, message, signature) => verifyEd25519Raw(publicKey, message, signature),

  /**
   * A Solana key is a seed, not a JWK, so it takes a different loader and a
   * different signature type. Everything downstream reads widths from
   * SIG_CONFIG, so only these fields differ.
   */
  loadKey(jwk, token) {
    if (token === "solana") {
      const solana = parseSolanaKey(jwk);
      return {
        signatureType: ans104.SIG_TYPE_SOLANA,
        owner: solana.publicKey,
        address: solana.address,
        fields: { jwk: null, seed: solana.seed, privateKey: null },
      };
    }
    const loaded = loadJwk(jwk, { token });
    return {
      signatureType: ans104.SIG_TYPE_ARWEAVE,
      owner: loaded.owner,
      /** The Arweave wallet address: base64url(SHA-256(owner)). */
      address: loaded.address,
      fields: { jwk: loaded.jwk, seed: null, privateKey: loaded.privateKey },
    };
  },

  /** Sign a deep hash computed elsewhere (a streamed item's), with the key this client holds. */
  signSignatureData(client, signatureData) {
    return client.signatureType === ans104.SIG_TYPE_SOLANA
      ? signEd25519(client.seed, signatureData)
      : ans104.signMessage(client.jwk, signatureData, { privateKey: client.privateKey });
  },

  signSync(client, { data, tags, target, anchor }) {
    return ans104.signDataItem(client.jwk, {
      data,
      tags,
      target,
      anchor,
      owner: client.owner,
      privateKey: client.privateKey,
      signatureType: client.signatureType,
      seed: client.seed,
    });
  },
});

class TurboUpload extends TurboUploadCore {
  /**
   * @param {object} options
   * @param {object|string} [options.jwk] Arweave JWK (object or JSON string), or a Solana key with token "solana"
   * @param {object} [options.signer] a wallet-style signer: { publicKey, signMessage, verify? }
   * @param {string} [options.uploadUrl]  default https://upload.ardrive.io
   * @param {string} [options.paymentUrl] default https://payment.ardrive.io
   * @param {number} [options.timeoutMs]  default 60000, per request
   * @param {object|false} [options.retry] partial retry config; merged over defaults
   * @param {string} [options.token] "arweave" (default with jwk) or "solana" (default with signer)
   * @param {typeof fetch} [options.fetch] injectable for tests/proxies
   */
  constructor(options = {}) {
    super(options, NODE_PLATFORM);
  }

  /** Verify a serialized data item. Pass `{strictSaltLength:true}` to also pin the PSS salt length. */
  verify(binary, opts = {}) {
    assertKnownOptions(opts, ["strictSaltLength"], "verify()", TurboValidationError);
    return ans104.verifyDataItem(Buffer.isBuffer(binary) ? binary : Buffer.from(binary), opts);
  }
}

module.exports = { TurboUpload };
