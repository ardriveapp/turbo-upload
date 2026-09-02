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

/**
 * Mainnet. Uploads here are permanent and cost real money.
 *
 * `gatewayUrl` is the gateway the upload service names as its own, in the
 * `gateway` field of its `/v1/info`. That is deliberate rather than incidental:
 * arweave.net was the value here, and it answered `429` to ten consecutive
 * reads of items this package had just uploaded, while the service's own
 * gateway answered `200` to all ten. A default that rate limits the reader is
 * worse than no default. TESTNET already matched its service this way.
 *
 * Any gateway serving Arweave can return these items by id, and gateways differ
 * in what they have indexed, so a reader that matters should set this rather
 * than inherit it.
 */
const PRODUCTION = Object.freeze({
  name: "production",
  uploadUrl: "https://upload.ardrive.io",
  paymentUrl: "https://payment.ardrive.io",
  gatewayUrl: "https://turbo-gateway.com",
});

/** Testnet / dev. Note `.services.` — this is NOT upload.ar-io.dev. */
const TESTNET = Object.freeze({
  name: "testnet",
  uploadUrl: "https://upload.services.ar-io.dev",
  paymentUrl: "https://payment.services.ar-io.dev",
  gatewayUrl: "https://ar-io.dev",
});

module.exports = { PRODUCTION, TESTNET };
