"use strict";
/**
 * @ardrive/turbo-upload, sign ANS-104 data items with an Arweave JWK and upload
 * them to a Turbo upload service. Zero runtime dependencies.
 *
 * NOTE ON THE SHAPE OF THIS FILE. Everything is destructured into a local
 * identifier and re-exported as SHORTHAND. That is not a style choice: Node
 * determines which named exports an ESM consumer may import from a CJS module
 * by running cjs-module-lexer over this source, and the lexer only recognises
 * simple identifiers. A member-expression value (`foo: ans104.foo`) or a spread
 * (`...errors`) makes the whole export list undetectable, so
 *
 *     import { TurboHTTPError } from "@ardrive/turbo-upload";
 *
 * becomes a SyntaxError for an ESM caller while `require()` keeps working, a
 * failure that only shows up in someone else's project. The
 * "every public export is importable BY NAME from ESM" test pins this.
 */

const { TurboUpload } = require("./src/client.js");
const { PRODUCTION, TESTNET } = require("./src/endpoints.js");
const { parseJwk } = require("./src/jwk.js");
const { DEFAULT_TIMEOUT_MS, DEFAULT_RETRY } = require("./src/http.js");

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
} = require("./src/errors.js");

const {
  signDataItem,
  verifyDataItem,
  createDataItem,
  parseDataItem,
  getSignatureData,
  deepHash,
  serializeTags,
  deserializeTags,
  signMessage,
  verifyMessage,
  idFromSignature,
  ownerFromJwk,
  addressFromOwner,
  publicKeyFromOwner,
  MAX_TAG_BYTES,
  MIN_ITEM_SIZE,
  PSS_SALT_LENGTH_BYTES,
  SIG_TYPE_ARWEAVE: SIGNATURE_TYPE_ARWEAVE,
  SIG_TYPE_SOLANA: SIGNATURE_TYPE_SOLANA,
} = require("./src/ans104.js");

module.exports = {
  // The client
  TurboUpload,

  // Endpoint configs, exported so nobody has to guess a hostname
  PRODUCTION,
  TESTNET,

  // Low-level ANS-104, for signing without uploading
  signDataItem,
  verifyDataItem,
  createDataItem,
  parseDataItem,
  getSignatureData,
  deepHash,
  serializeTags,
  deserializeTags,
  signMessage,
  verifyMessage,
  idFromSignature,

  // Keys
  parseJwk,
  ownerFromJwk,
  addressFromOwner,
  publicKeyFromOwner,

  // Constants
  MAX_TAG_BYTES,
  MIN_ITEM_SIZE,
  PSS_SALT_LENGTH_BYTES,
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
};
