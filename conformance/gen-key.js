// One-off: generate the throwaway test JWK. Not part of the corpus run.
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 0x10001 });
const jwk = privateKey.export({ format: "jwk" });
// Arweave JWK field order / shape.
const out = { kty: jwk.kty, n: jwk.n, e: jwk.e, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi };
fs.writeFileSync(__dirname + "/test-key.json", JSON.stringify(out, null, 2) + "\n");
console.log("modulus bytes:", Buffer.from(out.n, "base64url").length, "e:", out.e, "fields:", Object.keys(out).join(","));
