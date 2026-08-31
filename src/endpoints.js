"use strict";
/**
 * Service endpoints, as named constants so nobody has to guess.
 *
 * FINDING, and the reason these are exported rather than documented: the
 * published @ardrive/turbo-sdk ships `upload.ardrive.dev` / `payment.ardrive.dev`
 * as its development configuration, and BOTH ARE NXDOMAIN. There is also a
 * `upload.ar-io.dev` that RESOLVES and serves an HTML SPA on every path,
 * including /v1/tx — so pointing at it yields a 200 with an HTML body rather
 * than an obvious failure. The working testnet hosts have `.services.` in them.
 */

/** Mainnet. Uploads here are permanent and cost real money. */
const PRODUCTION = Object.freeze({
  name: "production",
  uploadUrl: "https://upload.ardrive.io",
  paymentUrl: "https://payment.ardrive.io",
  gatewayUrl: "https://arweave.net",
});

/** Testnet / dev. Note `.services.` — this is NOT upload.ar-io.dev. */
const TESTNET = Object.freeze({
  name: "testnet",
  uploadUrl: "https://upload.services.ar-io.dev",
  paymentUrl: "https://payment.services.ar-io.dev",
  gatewayUrl: "https://ar-io.dev",
});

module.exports = { PRODUCTION, TESTNET };
