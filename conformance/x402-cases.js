"use strict";
/** The fixed inputs x402-generate.js and x402.js share. The key holds nothing. */
const crypto = require("node:crypto");
const { privateKeyToAccount } = require("viem/accounts");

const FIXED_NOW = 1790000000000;
const NONCE = crypto.createHash("sha256").update("x402 nonce").digest();
const account = privateKeyToAccount(`0x${crypto.createHash("sha256").update("x402-conformance").digest("hex")}`);

const terms = (o) => ({
  scheme: "exact",
  maxAmountRequired: "18072",
  resource: "https://upload.test/v1/tx",
  description: "Upload 1652 bytes",
  mimeType: "application/octet-stream",
  payTo: "0x9B13eb5096264B12532b8C648Eba4A662b4078ce",
  maxTimeoutSeconds: 3600,
  ...o,
});
const SEPOLIA = { network: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" } };

const CASES = [
  { name: "base-sepolia, testnet domain", requirement: terms(SEPOLIA) },
  { name: "base, production domain", requirement: terms({ network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" }, maxAmountRequired: "10000" }) },
  // x402 checksums payTo in the typed data and turbo-upload passes it as
  // received: the strings differ, the EIP-712 hash and the signature must not.
  { name: "base-sepolia, lowercase payTo", requirement: terms({ ...SEPOLIA, payTo: "0x9b13eb5096264b12532b8c648eba4a662b4078ce" }) },
];

module.exports = { CASES, FIXED_NOW, NONCE, account };
