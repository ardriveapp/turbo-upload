"use strict";
/**
 * x402.js, the payment turbo-upload builds for an x402 upload, against
 * x402-vectors.json: what the `x402` package's own v1 "exact" EVM client built
 * from the same inputs (x402-generate.js writes it).
 *
 *   node x402.js
 *
 * Same account, same 402 terms, same clock, same nonce. For each case the
 * typed data handed to the signer, the signature and the X-PAYMENT header
 * must equal the vector, string for string. Each signature is then checked
 * with viem's verifyTypedData and must recover to the account. Exits non-zero
 * on any difference.
 */
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { verifyTypedData, recoverTypedDataAddress, hashTypedData } = require("viem");
const x402 = require("../src/core/x402.js");
const V = require("./x402-vectors.json");
const { CASES, FIXED_NOW, NONCE, account } = require("./x402-cases.js");

/** Our payment for one requirement, with the clock and nonce fixed. */
async function ours(requirement) {
  let typedData;
  let header;
  const signer = { address: account.address, signTypedData: async (t) => ((typedData = t), account.signTypedData(t)) };
  const fetch = async (url, init) => {
    header = init.headers["X-PAYMENT"];
    const body = header ? { id: "i".repeat(43) } : { x402Version: 1, accepts: [requirement] };
    return new Response(JSON.stringify(body), { status: header ? 200 : 402, headers: { "content-type": "application/json" } });
  };
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    await x402.uploadUnsignedX402(
      { data: "x", signer, maxUsdc: requirement.maxAmountRequired, uploadUrl: "https://upload.test", network: requirement.network, fetch },
      { randomBytes: () => Uint8Array.from(NONCE) },
    );
  } finally {
    Date.now = realNow;
  }
  return { typedData, header };
}

(async () => {
  assert.equal(V.inputs.from, account.address, "the vectors were generated from the account x402-cases.js derives");
  assert.equal(V.inputs.nonce_hex, NONCE.toString("hex"));
  assert.equal(V.vectors.length, CASES.length);
  let failures = 0;
  for (const v of V.vectors) {
    const c = CASES.find((x) => x.name === v.name);
    const problems = [];
    const check = (what, fn) => {
      try { fn(); } catch (err) { problems.push(`${what}: ${err.message.split("\n")[0]}`); }
    };
    check("inputs", () => assert.deepStrictEqual(c && c.requirement, v.requirement));
    const a = await ours(v.requirement);
    const want = v.expected;
    check("typed data", () => {
      // The lowercase-payTo case: x402 checksums `to`, this package passes it as received.
      const to = want.typedData.message.to;
      assert.equal(a.typedData.message.to.toLowerCase(), to.toLowerCase());
      assert.deepStrictEqual({ ...a.typedData, message: { ...a.typedData.message, to } }, want.typedData);
    });
    check("EIP-712 hash", () => assert.equal(hashTypedData(a.typedData), hashTypedData(want.typedData)));
    check("X-PAYMENT", () => assert.equal(a.header, want.xPayment));
    const { signature } = JSON.parse(Buffer.from(a.header, "base64").toString("utf8")).payload;
    check("signature", () => assert.equal(signature, want.signature));
    const recovered = await recoverTypedDataAddress({ ...a.typedData, signature });
    check("recovers to the account", () => assert.equal(recovered, account.address));
    const verified = await verifyTypedData({ address: account.address, ...a.typedData, signature });
    check("verifies", () => assert.equal(verified, true));
    if (problems.length) failures++;
    console.log(`${problems.length ? "DIFFERS" : "same   "}  ${v.name.padEnd(32)} ${problems.join("; ") || `sig ${signature.slice(0, 18)}..., header ${a.header.length} chars`}`);
  }
  console.log(`\nx402: ${V.vectors.length - failures}/${V.vectors.length} cases identical to ${V.generated_by}, every signature recovering to the signer`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
