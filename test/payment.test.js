"use strict";
/**
 * The payment calls, through an injected fetch. No network.
 *
 * conformance/wire-parity.js holds each request next to turbo-sdk's; these
 * tests pin the parts that are this package's own: argument checks that run
 * before anything is sent, and how each answer is read.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const { TurboUpload, TurboValidationError, createSolanaSigner, parseDataItem, idFromSignature, deserializeTags } = require("../index.js");

const SEED = crypto.randomBytes(32);

/** Answers by route, records every request. */
function serviceStub(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: init.headers ?? {}, body: init.body });
    const path = new URL(url).pathname;
    const hit = routes.find(([m, re]) => m === method && re.test(path));
    if (!hit) return new Response("not routed", { status: 404 });
    const [, , status, body] = typeof hit[2] === "function" ? [null, null, ...hit[2](init)] : hit;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch) => new TurboUpload({ jwk: SEED, token: "solana", paymentUrl: "https://pay.test", uploadUrl: "https://up.test", fetch, retry: false });

test("getWincForToken prices base units and reads turbo-sdk's fields", async () => {
  const f = serviceStub([["GET", /^\/v1\/price\/solana\/\d+$/, 200, { winc: "18", fees: [{ name: "fee" }], actualPaymentAmount: "27" }]]);
  const c = client(f);
  const r = await c.getWincForToken(1_000_000_000n);
  assert.equal(f.calls[0].url, "https://pay.test/v1/price/solana/1000000000");
  assert.deepEqual(r, { winc: "18", fees: [{ name: "fee" }], actualTokenAmount: "1000000000", equivalentWincTokenAmount: "27" });
  for (const bad of [-1, 1.5, "1e9", "", null]) await assert.rejects(c.getWincForToken(bad), TurboValidationError);
  assert.equal(f.calls.length, 1, "a bad amount never reaches the network");
});

test("getFundingAddress reads the address for this client's token, and refuses a service without one", async () => {
  const f = serviceStub([["GET", /^\/v1\/info$/, 200, { addresses: { solana: "FUND", arweave: "AR" } }]]);
  assert.equal(await client(f).getFundingAddress(), "FUND");
  assert.equal(f.calls[0].url, "https://pay.test/v1/info", "the PAYMENT service's info, not the upload service's");
  const none = serviceStub([["GET", /^\/v1\/info$/, 200, { addresses: {} }]]);
  await assert.rejects(client(none).getFundingAddress(), /no funding address for token "solana"/);
});

test("getFreeQuota reads bytesRemaining, keeps a legitimate 0, and treats a 404 as unknown", async () => {
  const c = client(serviceStub([["GET", /^\/v1\/account\/free$/, 200, { bytesRemaining: 0 }]]));
  assert.deepEqual(await c.getFreeQuota(), { bytesRemaining: 0, address: c.address });
  const missing = client(serviceStub([["GET", /^\/v1\/account\/free$/, 404, "Not Found"]]));
  assert.equal((await missing.getFreeQuota({ address: "someone" })).bytesRemaining, null);
  await assert.rejects(c.getFreeQuota({ address: "a b" }), TurboValidationError);
});

test("submitFundTransaction posts {tx_id} as bytes with no content-type, and maps every answer", async () => {
  const tx = "5".repeat(88);
  const credited = { creditedTransaction: { transactionId: tx, transactionQuantity: "50000000", transactionSenderAddress: "S", destinationAddress: "D", winstonCreditAmount: "9", tokenType: "solana", blockHeight: 7 } };
  const f = serviceStub([["POST", /^\/v1\/account\/balance\/solana$/, 200, credited]]);
  const r = await client(f).submitFundTransaction(tx);
  assert.deepEqual(r, { id: tx, quantity: "50000000", owner: "S", winc: "9", token: "solana", status: "confirmed", block: 7, recipient: "D" });
  const call = f.calls[0];
  assert.equal(call.url, "https://pay.test/v1/account/balance/solana");
  assert.equal(Buffer.from(call.body).toString(), JSON.stringify({ tx_id: tx }));
  assert.ok(call.body instanceof Uint8Array, "bytes, so a browser does not label it text/plain");
  assert.equal("content-type" in call.headers, false);

  const pending = { pendingTransaction: { ...credited.creditedTransaction, blockHeight: undefined } };
  assert.equal((await client(serviceStub([["POST", /balance/, 202, pending]])).submitFundTransaction(tx)).status, "pending");
  assert.equal((await client(serviceStub([["POST", /balance/, 202, "Transaction not found, will retry"]])).submitFundTransaction(tx)).status, "pending");
  const failed = { failedTransaction: credited.creditedTransaction };
  assert.equal((await client(serviceStub([["POST", /balance/, 200, failed]])).submitFundTransaction(tx)).status, "failed");
  await assert.rejects(client(serviceStub([["POST", /balance/, 200, { what: 1 }]])).submitFundTransaction(tx), /does not recognise/);
  await assert.rejects(client(f).submitFundTransaction("not a tx"), TurboValidationError);
});

test("shareCredits uploads one approval item with turbo-sdk's tags and nonce, and returns createdApproval", async () => {
  const now = Date.now;
  Date.now = () => 1790000000000;
  try {
    const f = serviceStub([["POST", /^\/v1\/tx$/, (init) => {
      const item = parseDataItem(Buffer.from(init.body));
      return [200, { id: idFromSignature(item.rawSignature).toString("base64url"), createdApproval: { approvalDataItemId: "x", approvedAddress: "APPROVED" } }];
    }]]);
    for (const c of [client(f), new TurboUpload({ signer: createSolanaSigner(SEED), uploadUrl: "https://up.test", fetch: f })]) {
      const approval = await c.shareCredits({ approvedAddress: "APPROVED", approvedWincAmount: 1000n, expiresBySeconds: 600 });
      assert.equal(approval.approvedAddress, "APPROVED");
      const item = parseDataItem(Buffer.from(f.calls.at(-1).body));
      assert.deepEqual(deserializeTags(item.rawTags), [
        { name: "x-approve-payment", value: "APPROVED" },
        { name: "x-amount", value: "1000" },
        { name: "x-expires-seconds", value: "600" },
      ]);
      assert.equal(item.rawData.toString(), "APPROVED10001790000000000");
    }
  } finally {
    Date.now = now;
  }
  const noApproval = serviceStub([["POST", /^\/v1\/tx$/, (init) => [200, { id: idFromSignature(parseDataItem(Buffer.from(init.body)).rawSignature).toString("base64url") }]]]);
  await assert.rejects(client(noApproval).shareCredits({ approvedAddress: "A", approvedWincAmount: 1 }), /no createdApproval/);
  for (const bad of [{ approvedAddress: "A", approvedWincAmount: 0 }, { approvedAddress: "", approvedWincAmount: 1 }, { approvedAddress: "A", approvedWincAmount: 1, expiresBySeconds: 0 }, { approvedAddress: "A", approvedWincAmount: 1, amount: 1 }]) {
    await assert.rejects(client(noApproval).shareCredits(bad), TurboValidationError);
  }
});

test("createCheckoutSession builds turbo-sdk's route and query, in cents, and reads the session", async () => {
  const body = { adjustments: [], fees: [], topUpQuote: { winstonCreditAmount: "7", paymentAmount: 1000, quotedPaymentAmount: 1000 }, paymentSession: { id: "cs_test_1", url: "https://checkout.test/1", client_secret: null } };
  const f = serviceStub([["GET", /^\/v1\/top-up\/checkout-session\//, 200, body]]);
  const c = client(f);
  const r = await c.createCheckoutSession({ amount: 1000, promoCodes: ["A", "B"], successUrl: "https://ok.test/?a=1" });
  assert.equal(f.calls[0].url, `https://pay.test/v1/top-up/checkout-session/${c.address}/usd/1000?token=solana&uiMode=hosted&promoCode=A%2CB&successUrl=https%3A%2F%2Fok.test%2F%3Fa%3D1`);
  assert.deepEqual(r, { winc: "7", adjustments: [], fees: [], url: "https://checkout.test/1", id: "cs_test_1", client_secret: undefined, actualPaymentAmount: 1000, quotedPaymentAmount: 1000 });
  for (const bad of [{}, { amount: 10.5 }, { amount: 1000, currency: "dollars" }, { amount: 1000, uiMode: "popup" }, { amount: 1000, cents: 1 }]) {
    await assert.rejects(c.createCheckoutSession(bad), TurboValidationError);
  }
});

test("every payment call rejects an unknown option", async () => {
  const c = client(serviceStub([]));
  const bad = { nonsense: true };
  await assert.rejects(c.getWincForToken(1, bad), /unknown option/);
  await assert.rejects(c.getPaymentInfo(bad), /unknown option/);
  await assert.rejects(c.getFundingAddress(bad), /unknown option/);
  await assert.rejects(c.getFreeQuota(bad), /unknown option/);
  await assert.rejects(c.submitFundTransaction("5".repeat(88), bad), /unknown option/);
});
