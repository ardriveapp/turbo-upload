"use strict";
/**
 * @ardrive/turbo-upload, the web build: browsers, workers, jsdom. Signs ANS-104
 * type 4 data items through a wallet-style signer and uploads them to Turbo.
 * Zero dependencies, no polyfills: it never touches Buffer, process or a
 * `node:` module, and bytes come back as Uint8Array.
 *
 * Bundlers pick this file through the `browser` export condition, or import
 * it directly as "@ardrive/turbo-upload/web". It is CommonJS, like the Node
 * build, which every bundler that honours export conditions consumes.
 *
 * Exports are destructured into local identifiers and re-exported as
 * shorthand, for the reason index.js gives: it keeps them importable by name
 * from ESM.
 */

const { TurboUpload, verifyDataItem } = require("./src/web/client.js");
const { PRODUCTION, TESTNET } = require("./src/core/endpoints.js");
const { DEFAULT_TIMEOUT_MS, DEFAULT_RETRY } = require("./src/core/http.js");
const { jsHashes } = require("./src/core/sha2.js");
const core = require("./src/core/ans104.js");
const { toBase64Url } = require("./src/core/bytes.js");

const {
  TurboError,
  TurboConfigError,
  TurboKeyError,
  TurboValidationError,
  TurboNetworkError,
  TurboTimeoutError,
  TurboHTTPError,
  TurboPaymentError,
  TurboVerificationError,
  TurboSignerError,
  TurboChunkedUploadError,
} = require("./src/core/errors.js");

const {
  createDataItem,
  parseDataItem,
  serializeTags,
  deserializeTags,
  MAX_TAG_BYTES,
  MIN_ITEM_SIZE,
  SIG_TYPE_ARWEAVE: SIGNATURE_TYPE_ARWEAVE,
  SIG_TYPE_SOLANA: SIGNATURE_TYPE_SOLANA,
} = core;

/** The 48-byte message a given item's signature covers. */
const getSignatureData = (binary) => core.getSignatureData(binary, jsHashes);

/** Arweave's SHA-384 structured transcript hash. */
const deepHash = (chunk) => core.deepHash(chunk, jsHashes);

/** id = SHA-256 of the raw signature bytes. */
const idFromSignature = (signature) => jsHashes.sha256(signature);

/** base64url(SHA-256(owner)), the normalised address the upload service reports as `owner`. */
const addressFromOwner = (owner) => toBase64Url(jsHashes.sha256(owner));

module.exports = {
  // The client
  TurboUpload,

  // Endpoint configs
  PRODUCTION,
  TESTNET,

  // Low-level ANS-104
  createDataItem,
  parseDataItem,
  getSignatureData,
  deepHash,
  serializeTags,
  deserializeTags,
  idFromSignature,
  addressFromOwner,
  verifyDataItem,

  // Constants
  MAX_TAG_BYTES,
  MIN_ITEM_SIZE,
  SIGNATURE_TYPE_ARWEAVE,
  SIGNATURE_TYPE_SOLANA,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY,

  // Errors
  TurboError,
  TurboConfigError,
  TurboKeyError,
  TurboValidationError,
  TurboNetworkError,
  TurboTimeoutError,
  TurboHTTPError,
  TurboPaymentError,
  TurboVerificationError,
  TurboSignerError,
  TurboChunkedUploadError,
};
