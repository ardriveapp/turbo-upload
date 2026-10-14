"use strict";
/**
 * x402 uploads on the unsigned route, through an injected fetch. No network,
 * no EVM library: the signer here records what it is asked to sign.
 *
 * conformance/x402.js checks the same typed data and header against the
 * `x402` package, and that a viem signature over them recovers to the signer.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");

const {
  uploadUnsignedX402,
  getUnsignedX402Price,
  TESTNET,
  PRODUCTION,
  X402_MAX_DATA_BYTES,
  TurboPaymentError,
  TurboSignerError,
  TurboValidationError,
  TurboHTTPError,
} = require("../index.js");

const FROM = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x9B13eb5096264B12532b8C648Eba4A662b4078ce";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SIG = `0x${"ab".repeat(65)}`;
const NOW = 1790000000000;
const ROUTE = "/v1/x402/upload/unsigned";

const offer = (o = {}) => ({
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "18072",
  resource: `${TESTNET.uploadUrl}/v1/tx`,
  payTo: PAY_TO,
  maxTimeoutSeconds: 3600,
  asset: SEPOLIA_USDC,
  extra: { name: "USDC", version: "2" },
  ...o,
});
const quote = (accepts) => [402, { x402Version: 1, accepts, error: "Payment required to upload data" }];
const PAID = { id: "x".repeat(43), owner: "bundler", payer: FROM, x402Payment: { paymentId: "p", transactionHash: "0xhash", network: "base-sepolia" }, receipt: { winc: "5", id: "x".repeat(43) } };

/** Answers each request in turn, records them all. */
function stub(...answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: Buffer.from(init.body ?? []), redirect: init.redirect });
    if (typeof answers[0] === "function") return answers[0](url, init);
    const [status, body] = answers[Math.min(calls.length, answers.length) - 1];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

/** A signer that records what it signs and returns a fixed signature. */
function recorder(result = SIG) {
  const seen = [];
  return { seen, address: FROM, signTypedData: async (typedData) => (seen.push(typedData), typeof result === "function" ? result() : result) };
}

const decode = (header) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));
/** The JSON envelope a request carried, with its data decoded. */
const opened = (call) => {
  const e = JSON.parse(call.body.toString("utf8"));
  return { ...e, data: Buffer.from(e.data, "base64").toString("utf8") };
};

test("pays on testnet: quote, sign the exact typed data, send X-PAYMENT, lift the receipt", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const fetch = stub(quote([offer()]), [200, PAID]);
  const signer = recorder();
  const tags = [{ name: "Content-Type", value: "text/plain" }, { name: "App", value: "test" }];
  const res = await uploadUnsignedX402({ data: "hello", tags, signer, maxUsdc: 20000n, uploadUrl: TESTNET.uploadUrl, fetch });

  assert.equal(fetch.calls.length, 2);
  for (const c of fetch.calls) {
    assert.equal(c.url, `${TESTNET.uploadUrl}${ROUTE}`);
    assert.equal(c.method, "POST");
    assert.equal(c.headers["content-type"], "application/json");
    assert.equal(c.redirect, "error", "a redirect never carries the request on");
    assert.deepEqual(opened(c), { data: "hello", tags: [{ name: "App", value: "test" }], contentType: "text/plain" }, "the same envelope, both times");
  }
  assert.equal(fetch.calls[0].headers["X-PAYMENT"], undefined, "the quote request carries no payment");

  const { nonce } = signer.seen[0].message;
  assert.match(nonce, /^0x[0-9a-f]{64}$/);
  const authorization = {
    from: FROM,
    to: PAY_TO,
    value: "18072",
    validAfter: String(NOW / 1000 - 600),
    validBefore: String(NOW / 1000 + 3600),
    nonce,
  };
  assert.deepEqual(signer.seen, [{
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: SEPOLIA_USDC },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  }]);
  assert.deepEqual(decode(fetch.calls[1].headers["X-PAYMENT"]), {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature: SIG, authorization },
  });
  assert.equal(res.id, PAID.id);
  assert.equal(res.payer, FROM);
  assert.equal(res.winc, "5", "receipt fields are lifted to the top level");
  assert.equal(res.x402Payment.transactionHash, "0xhash");
});

test("the domain name comes from the 402, and production pays on base", async () => {
  const fetch = stub(quote([offer({ network: "base", asset: BASE_USDC, extra: { name: "USD Coin", version: "2" }, maxAmountRequired: "10000" })]), [200, PAID]);
  const signer = recorder();
  await uploadUnsignedX402({ data: "x", signer, maxUsdc: "10000", fetch });
  assert.equal(fetch.calls[0].url, `${PRODUCTION.uploadUrl}${ROUTE}`, "production is the default");
  assert.deepEqual(JSON.parse(fetch.calls[0].body.toString()), { data: "eA==", tags: [] }, "no tags: an empty list and no contentType");
  assert.deepEqual(signer.seen[0].domain, { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC });
  assert.equal(decode(fetch.calls[1].headers["X-PAYMENT"]).network, "base");
});

test("refuses terms it will not pay, before the signer is asked", async () => {
  const cases = [
    ["another network", [offer({ network: "base" })], /pays on base-sepolia \(chain 84532\) only/],
    ["another asset", [offer({ asset: BASE_USDC })], /not USDC on base-sepolia/],
    ["over the cap", [offer({ maxAmountRequired: "20001" })], /asks 20001 USDC base units, more than `maxUsdc` \(20000\)/],
    ["another scheme", [offer({ scheme: "upto" })], /pays on base-sepolia/],
    ["no payTo", [offer({ payTo: "nobody" })], /missing or malformed/],
    ["no domain name", [offer({ extra: {} })], /missing or malformed/],
    ["a negative amount", [offer({ maxAmountRequired: "-1" })], /missing or malformed/],
    ["a fractional amount", [offer({ maxAmountRequired: "1.5" })], /missing or malformed/],
    ["a numeric amount", [offer({ maxAmountRequired: 18072 })], /missing or malformed/],
    ["a zero amount", [offer({ maxAmountRequired: "0" })], /missing or malformed/],
    ["no timeout", [offer({ maxTimeoutSeconds: undefined })], /missing or malformed/],
    ["a zero timeout", [offer({ maxTimeoutSeconds: 0 })], /missing or malformed/],
    ["a string timeout", [offer({ maxTimeoutSeconds: "3600" })], /missing or malformed/],
  ];
  for (const [name, accepts, message] of cases) {
    const fetch = stub(quote(accepts));
    const signer = recorder();
    await assert.rejects(
      uploadUnsignedX402({ data: "x", signer, maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch }),
      (err) => err instanceof TurboPaymentError && err.status === 402 && message.test(err.message) && /Nothing was signed/.test(err.message),
      name,
    );
    assert.equal(signer.seen.length, 0, `${name}: never signed`);
    assert.equal(fetch.calls.length, 1, `${name}: never paid`);
  }
  const notX402 = stub([402, { error: "pay" }]);
  await assert.rejects(uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 1, uploadUrl: TESTNET.uploadUrl, fetch: notX402 }), /without an x402 version 1/);
});

test("picks the USDC entry for this network out of several", async () => {
  const fetch = stub(quote([offer({ network: "base", asset: BASE_USDC }), offer({ asset: "0x2222222222222222222222222222222222222222" }), offer()]), [200, PAID]);
  const signer = recorder();
  await uploadUnsignedX402({ data: "x", signer, maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch });
  assert.equal(signer.seen[0].domain.verifyingContract, SEPOLIA_USDC);
});

test("never sends a payment over cleartext; loopback is allowed", async () => {
  for (const uploadUrl of ["http://up.test", "ftp://up.test", "http://127.0.0.1.example", "http://localhost:80@evil.example", "http://127.0.0.1@evil.example", "not a url"]) {
    const fetch = stub(quote([offer()]));
    await assert.rejects(
      uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl, network: "base-sepolia", fetch }),
      (err) => err instanceof TurboValidationError && /not HTTPS|not a URL/.test(err.message),
      uploadUrl,
    );
    assert.equal(fetch.calls.length, 0, uploadUrl);
  }
  const local = stub(quote([offer()]), [201, PAID]);
  const res = await uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: "http://127.0.0.1:1984/", network: "base-sepolia", fetch: local });
  assert.equal(local.calls[1].url, `http://127.0.0.1:1984${ROUTE}`);
  assert.equal(res.id, PAID.id, "a 201 is a stored upload");
});

test("a signer that throws or returns something that is not a signature pays nothing", async () => {
  const bad = [
    ["throws", () => { throw new Error("user rejected"); }, /signTypedData failed: user rejected/],
    ["short", "0x1234", /not a 0x-prefixed hex signature/],
    ["odd length", `0x${"a".repeat(131)}`, /not a 0x-prefixed hex signature/],
    ["not hex", `0x${"zz".repeat(65)}`, /not a 0x-prefixed hex signature/],
    ["bytes", () => new Uint8Array(65), /returned object/],
    ["nothing", () => undefined, /returned undefined/],
    ["throws a non-Error", () => { throw Symbol("no"); }, /signTypedData failed: Symbol\(no\)/],
  ];
  for (const [name, result, message] of bad) {
    const fetch = stub(quote([offer()]));
    await assert.rejects(
      uploadUnsignedX402({ data: "x", signer: recorder(result), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch }),
      (err) => err instanceof TurboSignerError && message.test(err.message) && /Nothing was paid/.test(err.message),
      name,
    );
    assert.equal(fetch.calls.length, 1, `${name}: no paid request`);
  }
  // A smart-contract wallet's signature can be longer than 65 bytes.
  const long = stub(quote([offer()]), [200, PAID]);
  await uploadUnsignedX402({ data: "x", signer: recorder(`0x${"cd".repeat(200)}`), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: long });
  assert.equal(decode(long.calls[1].headers["X-PAYMENT"]).payload.signature.length, 402);
});

test("a 402 after paying is a TurboPaymentError, and the paid request is never retried", async () => {
  const refused = stub(quote([offer()]), [402, { x402Version: 1, error: "insufficient_funds", accepts: [offer()] }]);
  await assert.rejects(
    uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: refused }),
    (err) => err instanceof TurboPaymentError && err.body.error === "insufficient_funds" && /The payment might have settled/.test(err.message),
  );
  assert.equal(refused.calls.length, 2);
  const flaky = stub(quote([offer()]), [503, "busy"]);
  await assert.rejects(
    uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: flaky }),
    (err) => err instanceof TurboHTTPError && err.status === 503,
  );
  assert.equal(flaky.calls.length, 2, "one authorization, submitted once");
  const MAGIC = "6492".repeat(16);
  const wrapped = `0x${"ab".repeat(200)}${MAGIC}`;
  const undeployed = stub(quote([offer()]), [402, { error: "Invalid EIP-712 signature" }]);
  await assert.rejects(
    uploadUnsignedX402({ data: "x", signer: recorder(wrapped), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: undeployed }),
    (err) => err instanceof TurboPaymentError && err.status === 402 &&
      /HTTP 402: Invalid EIP-712 signature\)\. The signer is a smart account that is not deployed yet/.test(err.message) && /Deploy the account/.test(err.message),
  );
  assert.equal(decode(undeployed.calls[1].headers["X-PAYMENT"]).payload.signature, wrapped, "sent as signed, not refused beforehand");
  const ordinary = stub(quote([offer()]), [402, { error: "Invalid EIP-712 signature" }]);
  await assert.rejects(
    uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: ordinary }),
    (err) => err instanceof TurboPaymentError && !/smart account/.test(err.message),
    "an ordinary signature refused is not blamed on deployment",
  );
  const accepted = stub(quote([offer()]), [200, PAID]);
  assert.equal((await uploadUnsignedX402({ data: "x", signer: recorder(wrapped.toUpperCase().replace("0X", "0x")), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: accepted })).id, PAID.id, "a 6492 signature the service accepts goes through");
  for (const [name, fail] of [["network", () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }], ["503", null]]) {
    let n = 0;
    const f = stub((url, init) => (++n === 1 ? new Response(JSON.stringify(quote([offer()])[1]), { status: 402 }) : fail ? fail() : new Response("busy", { status: 503 })));
    await assert.rejects(
      uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: f }),
      (err) => /The payment might have settled/.test(err.message) && (name !== "network" || /unexpected redirect/.test(err.message)),
      name,
    );
  }
  const noId = stub(quote([offer()]), [200, "OK"]);
  await assert.rejects(
    uploadUnsignedX402({ data: "x", signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: noId }),
    (err) => err instanceof TurboHTTPError && /no data item id\. If a payment was sent, it might have settled/.test(err.message),
  );
});

test("tags travel in the envelope exactly as given, the first Content-Type as contentType", async () => {
  const fetch = stub(quote([offer()]), [200, PAID]);
  const tags = [{ name: "Title", value: "café 日本 🎉" }, { name: "content-type", value: "image/png" }, { name: "appName_Mixed", value: "case", extra: 1 }, { name: "", value: "" }];
  const data = new Uint8Array([0, 255, 1, 254, 2]);
  await uploadUnsignedX402({ data, tags, signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch });
  const e = JSON.parse(fetch.calls[0].body.toString("utf8"));
  assert.deepEqual(e, {
    data: Buffer.from(data).toString("base64"),
    tags: [{ name: "Title", value: "café 日本 🎉" }, { name: "appName_Mixed", value: "case" }, { name: "", value: "" }],
    contentType: "image/png",
  });
  assert.equal(fetch.calls[0].headers["x-data-item-tags"], undefined, "the route ignores that header");
  // Base64 written in place, every padding length, against Buffer's.
  for (const n of [1, 2, 3, 4, 5, 300]) {
    const f = stub(quote([offer()]), [200, PAID]);
    const bytes = crypto.randomBytes(n);
    await uploadUnsignedX402({ data: bytes, signer: recorder(), maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: f });
    assert.equal(JSON.parse(f.calls[0].body.toString()).data, bytes.toString("base64"), `${n} bytes`);
  }
});

test("each nonce is 32 random bytes, never zero and never repeated", async () => {
  const nonces = [];
  for (let i = 0; i < 3; i++) {
    const signer = recorder();
    await uploadUnsignedX402({ data: "x", signer, maxUsdc: 20000, uploadUrl: TESTNET.uploadUrl, fetch: stub(quote([offer()]), [200, PAID]) });
    nonces.push(signer.seen[0].message.nonce);
  }
  assert.equal(new Set(nonces).size, 3);
  for (const n of nonces) assert.notEqual(n, `0x${"0".repeat(64)}`);
});

test("bad arguments are refused before anything is sent", async () => {
  const fetch = stub(quote([offer()]));
  const ok = { data: "x", signer: recorder(), maxUsdc: 1, uploadUrl: TESTNET.uploadUrl, fetch };
  const cases = [
    [{ maxUsdc: undefined }, /`maxUsdc` is required/],
    [{ maxUsdc: "0.05" }, /`maxUsdc` must be a non-negative integer/],
    [{ maxUsdc: 0 }, /greater than zero/],
    [{ signer: { address: FROM } }, /`signer` must be an EVM signer/],
    [{ signer: { address: "0x12", signTypedData() {} } }, /`signer.address`/],
    [{ data: undefined }, /`data` is required/],
    [{ data: "" }, /`data` is empty/],
    [{ data: 5 }, /`data` must be a Uint8Array or a string/],
    [{ tags: [{ name: 1, value: "x" }] }, /Invalid tag format/],
    [{ tag: [] }, /unknown option `tag` \(did you mean `tags`\?\)/],
    [{ uploadUrl: "https://up.test" }, /`network` is required for https:\/\/up.test/],
    [{ network: "base" }, /takes payment on base-sepolia, not base/],
    [{ uploadUrl: "https://up.test", network: "ethereum" }, /`network` must be "base" or "base-sepolia"/],
    [{ timeoutMs: 0 }, /`timeoutMs` must be a positive number/],
  ];
  for (const [patch, message] of cases) {
    await assert.rejects(uploadUnsignedX402({ ...ok, ...patch }), (err) => err instanceof TurboValidationError && message.test(err.message), message.source);
  }
  await assert.rejects(
    uploadUnsignedX402({ ...ok, data: new Uint8Array(X402_MAX_DATA_BYTES + 1) }),
    /makes a 104857601-byte request, over the 104857600-byte limit .*Chunked x402 uploads need @ardrive\/turbo-sdk/,
  );
  await assert.rejects(
    uploadUnsignedX402({ ...ok, data: new Uint8Array(X402_MAX_DATA_BYTES - 3), tags: [{ name: "a", value: "b" }] }),
    /over the 104857600-byte limit/,
    "tags count against the limit too",
  );
  // Tags of 3072 bytes leave room for the service's own; one byte more is refused.
  const tags = (n) => [{ name: "Content-Type", value: "text/plain" }, { name: "Big", value: "a".repeat(n) }];
  await assert.rejects(uploadUnsignedX402({ ...ok, tags: tags(3041) }), /The tags take 3073 bytes, over the 3072 an x402 upload allows/);
  assert.equal(fetch.calls.length, 0);
  const room = stub(quote([offer()]), [200, PAID]);
  assert.equal((await uploadUnsignedX402({ ...ok, maxUsdc: 20000, tags: tags(3040), fetch: room })).id, PAID.id);
  assert.equal(fetch.calls.length, 0);
});

test("getUnsignedX402Price asks the upload service, for this network, with the tag count", async () => {
  const body = { usdcAmount: "1377", estimatedDataItemSize: 1780, network: "base-sepolia" };
  const fetch = stub([200, body]);
  assert.deepEqual(await getUnsignedX402Price({ byteCount: 100, tags: [{ name: "a", value: "b" }], uploadUrl: TESTNET.uploadUrl, fetch }), body);
  assert.equal(fetch.calls[0].url, `${TESTNET.uploadUrl}/v1/price/x402/data/usdc-base-sepolia/100?tags=1`);
  await getUnsignedX402Price({ byteCount: 5, fetch });
  assert.equal(fetch.calls[1].url, `${PRODUCTION.uploadUrl}/v1/price/x402/data/usdc-base/5`);
  for (const byteCount of [0, -1, 1.5, "100"]) await assert.rejects(getUnsignedX402Price({ byteCount, fetch }), TurboValidationError);
  assert.equal(fetch.calls.length, 2);
});
