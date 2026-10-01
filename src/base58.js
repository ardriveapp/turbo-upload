"use strict";
/**
 * Base58 for the Node build: the core implementation, returning a Buffer so
 * every caller in this build keeps the type it has always had.
 */
const { Buffer } = require("node:buffer");
const core = require("./core/base58.js");

function decodeBase58(input) {
  const bytes = core.decodeBase58(input);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const { encodeBase58, ALPHABET } = core;

module.exports = { decodeBase58, encodeBase58, ALPHABET };
