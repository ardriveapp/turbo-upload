"use strict";
/**
 * The signing key for the conformance scripts.
 *
 * `test-key.json` is used when it exists (run `node gen-key.js` to make one),
 * and is never committed. Without it, an ephemeral RSA-4096 key is generated
 * in memory, so every script runs from a clean checkout.
 *
 * Any key works: the corpus's deterministic checks use the public modulus the
 * corpus itself carries (`vectors.json` `key.owner_b64url`), and the signing
 * and cross-verification checks only need SOME key, not the one the corpus was
 * generated with.
 */
const fs = require("node:fs");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");

function loadKey() {
  const file = path.join(__dirname, "test-key.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const jwk = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 0x10001 })
    .privateKey.export({ format: "jwk" });
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi };
}

module.exports = { loadKey };
