"use strict";
/**
 * x402-generate.js, writes x402-vectors.json: the payment the `x402` package's
 * own v1 "exact" EVM client builds for fixed inputs.
 *
 *   node x402-generate.js
 *
 * x402@1.2.0 is installed into a temporary directory outside this tree and
 * removed afterwards, so it never appears in package.json or the lockfile:
 * it pulls in several hundred packages that only this generator needs.
 * x402.js checks turbo-upload against the committed vectors.
 *
 * The inputs are fixed: one account whose key is derived in code from a label
 * (nothing secret is committed), one clock, one nonce. ECDSA in viem is
 * deterministic (RFC 6979), so the signature is fixed too.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { CASES, FIXED_NOW, NONCE, account } = require("./x402-cases.js");

const X402_VERSION = "1.2.0";
const OUT = path.join(__dirname, "x402-vectors.json");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-generate-"));
  try {
    execFileSync("npm", ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", `x402@${X402_VERSION}`], { stdio: "ignore" });
    const { createPaymentHeader } = createRequire(path.join(dir, "index.js"))("x402/client");

    const realNow = Date.now;
    const realRandom = globalThis.crypto.getRandomValues;
    Date.now = () => FIXED_NOW;
    globalThis.crypto.getRandomValues = (a) => (a.set(NONCE.subarray(0, a.length)), a);
    const vectors = [];
    try {
      for (const { name, requirement } of CASES) {
        let typedData;
        const signer = { ...account, signTypedData: async (t) => ((typedData = t), account.signTypedData(t)) };
        const xPayment = await createPaymentHeader(signer, 1, requirement);
        const signature = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8")).payload.signature;
        vectors.push({ name, requirement, expected: { typedData, signature, xPayment } });
      }
    } finally {
      Date.now = realNow;
      globalThis.crypto.getRandomValues = realRandom;
    }
    const corpus = {
      format: "x402-exact-evm-payment-vectors",
      generated_by: `x402@${X402_VERSION}`,
      inputs: { from: account.address, now_ms: FIXED_NOW, nonce_hex: NONCE.toString("hex"), key_rule: "SHA-256(UTF-8(\"x402-conformance\"))" },
      vectors,
    };
    fs.writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
    console.log(`wrote ${path.basename(OUT)}: ${vectors.length} vectors from x402@${X402_VERSION}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
