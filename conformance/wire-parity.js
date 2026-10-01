"use strict";
/**
 * wire-parity.js, every service call turbo-upload makes, next to the same call
 * made by @ardrive/turbo-sdk 2.1.0, as each one arrives at a local capture
 * server.
 *
 *   node wire-parity.js
 *
 * Both clients get the same Solana key, the same inputs and the same clock, so
 * a call that sends the same thing sends the same bytes: Ed25519 is
 * deterministic, and the credit-share nonce reads Date.now(), which is fixed
 * here. For each call this compares the method, the path and query, the body
 * byte for byte, and the headers the service reads (content-type, x-paid-by).
 * Every other header is printed, not compared: turbo-sdk names itself in
 * x-turbo-source-*, and this package does not.
 *
 * One difference is expected and asserted as such: the upload route. This
 * package posts to /v1/tx, as every version before it did; turbo-sdk posts to
 * /v1/tx/{token}. Probed on devnet, the service treats the two identically,
 * x-paid-by included. Exits non-zero on any other difference.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const nacl = require("tweetnacl");
const pkg = require("..");
const { encodeBase58 } = require("../src/base58.js");

const FIXED_NOW = 1790000000000;
const FUNDING = "Bg5HnSVtgHVXEGqJYWqxWad9Vrcgva9JrKw3XFSEGvaB";
const TX_ID = "2L67qAbftL66k4oQoPbLJks2VPKweyhEkoXBCxoZSu11MLUUpGdTdwCquriCrTEaErTGpCgrZwStoG2FR9d4Mn4t";

/** What the capture server answers, per route. Plausible, not exhaustive. */
function answer(method, url, body) {
  const json = (o, status = 200) => ({ status, body: JSON.stringify(o) });
  const path = url.split("?")[0];
  if (method === "GET" && path === "/v1/info") return json({ addresses: { solana: FUNDING }, freeUploadLimitBytes: 5242880 });
  if (method === "GET" && /^\/v1\/price\/bytes\/\d+$/.test(path)) return json({ winc: "1000", adjustments: [] });
  if (method === "GET" && /^\/v1\/price\/solana\/\d+$/.test(path)) return json({ winc: "18000000000000", fees: [], actualPaymentAmount: "27000000000000" });
  if (method === "GET" && path.startsWith("/v1/account/balance/")) return json({ winc: "5", controlledWinc: "5", effectiveBalance: "5", givenApprovals: [], receivedApprovals: [] });
  if (method === "GET" && path === "/v1/account/free") return json({ bytesRemaining: 104857600 });
  if (method === "POST" && path.startsWith("/v1/account/balance/")) {
    return json({ creditedTransaction: { transactionId: TX_ID, transactionQuantity: "1", destinationAddress: "d", winstonCreditAmount: "9", tokenType: "solana", blockHeight: 1 } });
  }
  if (method === "GET" && path.startsWith("/v1/top-up/checkout-session/")) {
    return json({ adjustments: [], fees: [], topUpQuote: { winstonCreditAmount: "7", paymentAmount: 1000, quotedPaymentAmount: 1000 }, paymentSession: { id: "cs_test_x", url: "https://checkout.stripe.test/x", client_secret: null } });
  }
  if (method === "POST" && (path === "/v1/tx" || path === "/v1/tx/solana")) {
    const item = pkg.parseDataItem(body);
    const id = crypto.createHash("sha256").update(item.rawSignature).digest("base64url");
    const tags = pkg.deserializeTags(item.rawTags);
    const approve = tags.find((t) => t.name === "x-approve-payment");
    return json({
      id,
      winc: "0",
      ...(approve ? { createdApproval: { approvalDataItemId: id, approvedAddress: approve.value, approvedWincAmount: tags.find((t) => t.name === "x-amount").value } } : {}),
    });
  }
  return { status: 404, body: "not routed" };
}

async function main() {
  const captured = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      captured.push({ method: req.method, url: req.url, headers: req.headers, body });
      const a = answer(req.method, req.url, body);
      res.writeHead(a.status, { "content-type": "application/json" }).end(a.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realNow = Date.now;
  Date.now = () => FIXED_NOW;

  const seed = crypto.createHash("sha256").update("wire-parity").digest();
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  const secretKey = Buffer.from(pair.secretKey);
  const payer = encodeBase58(crypto.createHash("sha256").update("payer").digest());
  const approved = encodeBase58(crypto.createHash("sha256").update("approved").digest());

  const { TurboFactory, USD } = await import("@ardrive/turbo-sdk");
  const sdk = TurboFactory.authenticated({
    privateKey: encodeBase58(secretKey),
    token: "solana",
    paymentServiceConfig: { url: base },
    uploadServiceConfig: { url: base },
  });
  const ours = new pkg.TurboUpload({ jwk: secretKey, token: "solana", uploadUrl: base, paymentUrl: base });
  const viaSigner = new pkg.TurboUpload({ signer: pkg.createSolanaSigner(secretKey), uploadUrl: base, paymentUrl: base });

  const data = Buffer.from("wire parity payload");
  const tags = [{ name: "Content-Type", value: "text/plain" }];
  const calls = [
    ["getBalance", () => sdk.getBalance(), () => ours.getBalance()],
    ["upload cost", () => sdk.getUploadCosts({ bytes: [1234] }), () => ours.getUploadCost(1234)],
    ["getWincForToken", () => sdk.getWincForToken({ tokenAmount: 1_000_000_000 }), () => ours.getWincForToken(1_000_000_000)],
    ["funding address (/v1/info)", () => sdk.getTurboCryptoWallets(), () => ours.getFundingAddress()],
    ["getFreeQuota", () => sdk.getFreeStatus(), () => ours.getFreeQuota()],
    ["submitFundTransaction", () => sdk.submitFundTransaction({ txId: TX_ID }), () => ours.submitFundTransaction(TX_ID)],
    ["createCheckoutSession", () => sdk.createCheckoutSession({ amount: USD(10), owner: ours.address }), () => ours.createCheckoutSession({ amount: 1000, currency: "usd" })],
    ["shareCredits", () => sdk.shareCredits({ approvedAddress: approved, approvedWincAmount: "123456789", expiresBySeconds: 600 }),
      () => ours.shareCredits({ approvedAddress: approved, approvedWincAmount: "123456789", expiresBySeconds: 600 })],
    ["shareCredits, wallet signer", () => sdk.shareCredits({ approvedAddress: approved, approvedWincAmount: 5n, expiresBySeconds: 60 }),
      () => viaSigner.shareCredits({ approvedAddress: approved, approvedWincAmount: 5n, expiresBySeconds: 60 })],
    ["upload", () => sdk.uploadFile({ fileStreamFactory: () => data, fileSizeFactory: () => data.length, dataItemOpts: { tags } }),
      () => ours.upload({ data, tags })],
    ["upload with paidBy", () => sdk.uploadFile({ fileStreamFactory: () => data, fileSizeFactory: () => data.length, dataItemOpts: { tags, paidBy: payer } }),
      () => ours.upload({ data, tags, paidBy: payer })],
    ["upload with paidBy, wallet signer", () => sdk.uploadFile({ fileStreamFactory: () => data, fileSizeFactory: () => data.length, dataItemOpts: { tags, paidBy: payer } }),
      () => viaSigner.upload({ data, tags, paidBy: payer })],
  ];

  const READ = ["content-type", "x-paid-by"];
  let failures = 0;
  const rows = [];
  for (const [name, viaSdk, viaUs] of calls) {
    captured.length = 0;
    const sdkResult = await viaSdk();
    const a = captured.splice(0);
    const ourResult = await viaUs();
    const b = captured.splice(0);
    const problems = [];
    if (a.length !== b.length) problems.push(`turbo-sdk made ${a.length} request(s), turbo-upload ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i];
      const y = b[i];
      const routeOnly = x.url === "/v1/tx/solana" && y.url === "/v1/tx";
      if (x.method !== y.method) problems.push(`method ${x.method} vs ${y.method}`);
      if (x.url !== y.url && !routeOnly) problems.push(`url ${x.url} vs ${y.url}`);
      if (!x.body.equals(y.body)) problems.push(`body differs (${x.body.length} vs ${y.body.length} bytes)`);
      for (const h of READ) if ((x.headers[h] ?? null) !== (y.headers[h] ?? null)) problems.push(`${h}: ${x.headers[h]} vs ${y.headers[h]}`);
      rows.push({
        call: name,
        request: `${y.method} ${y.url}${routeOnly ? "   (turbo-sdk: /v1/tx/solana)" : ""}`,
        body: `${y.body.length} bytes${y.body.length ? `, sha256 ${crypto.createHash("sha256").update(y.body).digest("hex").slice(0, 16)}` : ""}`,
        identical: problems.length === 0,
        sdkOnlyHeaders: Object.keys(x.headers).filter((h) => !(h in y.headers)).join(","),
        oursOnlyHeaders: Object.keys(y.headers).filter((h) => !(h in x.headers)).join(","),
      });
    }
    if (name === "getWincForToken" && sdkResult.winc !== ourResult.winc) problems.push("winc read differently");
    if (name === "submitFundTransaction" && (sdkResult.status !== ourResult.status || sdkResult.winc !== ourResult.winc)) problems.push("result mapped differently");
    if (name === "createCheckoutSession" && (sdkResult.url !== ourResult.url || sdkResult.winc !== ourResult.winc)) problems.push("result mapped differently");
    if (name.startsWith("shareCredits") && sdkResult.approvalDataItemId !== ourResult.approvalDataItemId) problems.push("approval ids differ");
    if (name.startsWith("upload") && sdkResult.id !== ourResult.id) problems.push(`ids differ: ${sdkResult.id} vs ${ourResult.id}`);
    if (problems.length) {
      failures++;
      console.log(`DIFFERS  ${name}: ${problems.join("; ")}`);
    }
  }
  Date.now = realNow;
  server.close();

  for (const r of rows) {
    console.log(`${r.identical ? "same   " : "DIFFERS"}  ${r.call.padEnd(34)} ${r.request}`);
    console.log(`         ${"".padEnd(34)} body ${r.body}; headers only turbo-sdk sends: ${r.sdkOnlyHeaders || "none"}; only ours: ${r.oursOnlyHeaders || "none"}`);
  }
  console.log(`\nwire parity: ${calls.length - failures}/${calls.length} calls identical on method, path, query, body and the headers the service reads`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
