"use strict";
/**
 * Client behaviour, driven through an injected fetch. No network.
 *
 * Most of these tests exist because @ardrive/turbo-sdk gets the case wrong and
 * it cost real debugging time. Each one names the papercut it pins shut.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const {
  TurboUpload,
  PRODUCTION,
  TESTNET,
  TurboConfigError,
  TurboKeyError,
  TurboHTTPError,
  TurboPaymentError,
  TurboNetworkError,
  TurboTimeoutError,
  TurboValidationError,
  TurboVerificationError,
  parseDataItem,
  idFromSignature,
} = require("../index.js");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
const JWK = privateKey.export({ format: "jwk" });
const JWK_STRING = JSON.stringify(JWK);

/** A fetch stub that records calls and replays queued responses. */
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, signal: init.signal });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(url, init);
    const { status = 200, body = {}, headers = { "content-type": "application/json" } } = next;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

/** The id the service would legitimately return for whatever we just POSTed. */
const idOfPostedItem = (fetchStub) => {
  const posted = fetchStub.calls.find((c) => c.method === "POST").body;
  return idFromSignature(parseDataItem(Buffer.from(posted)).rawSignature).toString("base64url");
};

/* ---------------- construction and key intake ---------------- */

test("accepts a JWK as an object OR a JSON string (env vars arrive as strings)", () => {
  const a = new TurboUpload({ jwk: JWK });
  const b = new TurboUpload({ jwk: JWK_STRING });
  assert.equal(a.address, b.address);
  assert.equal(a.address.length, 43);
});

test("bad keys fail in the CONSTRUCTOR with a message naming the problem", () => {
  // turbo-sdk's signer factory has no default branch: a bad token yields
  // undefined and dies much later with "Cannot read properties of undefined".
  assert.throws(() => new TurboUpload({}), TurboKeyError);
  assert.throws(() => new TurboUpload({ jwk: "" }), /empty/i);
  assert.throws(() => new TurboUpload({ jwk: "{not json" }), /not valid JSON/);
  assert.throws(() => new TurboUpload({ jwk: { kty: "EC", n: "x" } }), /kty "EC"/);
  assert.throws(() => new TurboUpload({ jwk: { n: JWK.n, e: "AQAB" } }), /PUBLIC key/);
  assert.throws(() => new TurboUpload({ jwk: [] }), /an array/);
});

test("an ignored option is refused, because the typo that hides is the expensive one", () => {
  // The case this was written for. `uploadServiceUrl` was accepted and dropped,
  // leaving the client on PRODUCTION, so a probe that believed it was talking
  // to testnet was writing to mainnet and reporting testnet as broken.
  assert.throws(
    () => new TurboUpload({ jwk: JWK, uploadServiceUrl: TESTNET.uploadUrl }),
    (err) =>
      err instanceof TurboConfigError &&
      /uploadServiceUrl/.test(err.message) &&
      /did you mean `uploadUrl`/.test(err.message),
  );

  // The other shape: a dropped plural. An item uploaded with `tag` carries no
  // tags at all, so no tag query ever finds it again, and the upload succeeds.
  const client = new TurboUpload({ jwk: JWK });
  assert.throws(
    () => client.sign({ data: "x", tag: [{ name: "a", value: "b" }] }),
    (err) => err instanceof TurboValidationError && /did you mean `tags`/.test(err.message),
  );

  // The message has to name what IS accepted, or the caller guesses again.
  assert.throws(() => new TurboUpload({ jwk: JWK, nope: 1 }), /Accepted: jwk, uploadUrl, paymentUrl/);
  assert.throws(() => new TurboUpload({ jwk: JWK, a: 1, b: 2 }), /unknown options `a`, `b`/);
});

test("every public option surface rejects an unknown key, not just the constructor", async () => {
  const client = new TurboUpload({ jwk: JWK, fetch: stubFetch({ body: {} }) });
  const bad = { nonsense: true };
  assert.throws(() => client.sign({ data: "x", ...bad }), TurboValidationError);
  assert.throws(() => client.verify(Buffer.alloc(0), bad), TurboValidationError);
  await assert.rejects(() => client.upload({ data: "x", ...bad }), TurboValidationError);
  await assert.rejects(() => client.uploadSigned(Buffer.alloc(0), bad), TurboValidationError);
  await assert.rejects(() => client.getUploadCost(1, bad), TurboValidationError);
  await assert.rejects(() => client.getBalance(bad), TurboValidationError);
  await assert.rejects(() => client.getInfo(bad), TurboValidationError);
  await assert.rejects(() => client.getFreeUploadLimitBytes(bad), TurboValidationError);
});

test("the endpoint records carry fields the constructor does not accept", () => {
  // TESTNET and PRODUCTION carry `name` and `gatewayUrl` as well as the two URLs.
  // Spreading the whole record into the constructor is what broke first when
  // unknown keys started throwing, so the static helpers pick explicitly.
  assert.ok(Object.keys(TESTNET).includes("name"));
  assert.ok(Object.keys(TESTNET).includes("gatewayUrl"));
  assert.equal(TurboUpload.testnet({ jwk: JWK }).uploadUrl, TESTNET.uploadUrl);
  assert.equal(TurboUpload.production({ jwk: JWK }).uploadUrl, PRODUCTION.uploadUrl);
});

test("an unsupported token is refused up front and says where to go instead", () => {
  assert.throws(
    () => new TurboUpload({ jwk: JWK, token: "solana" }),
    (e) => e instanceof TurboConfigError && /@ardrive\/turbo-sdk/.test(e.message),
  );
});

test("a too-small RSA key is refused with the real reason", () => {
  const small = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  assert.throws(() => new TurboUpload({ jwk: small }), /512 bytes \(RSA-4096\), got 256 bytes/);
});

test("endpoint constants are exported so nobody guesses a hostname", () => {
  assert.equal(PRODUCTION.uploadUrl, "https://upload.ardrive.io");
  assert.equal(PRODUCTION.paymentUrl, "https://payment.ardrive.io");
  // `.services.` is load-bearing: upload.ar-io.dev resolves and serves an SPA.
  assert.equal(TESTNET.uploadUrl, "https://upload.services.ar-io.dev");
  assert.equal(TESTNET.paymentUrl, "https://payment.services.ar-io.dev");
  assert.equal(TurboUpload.testnet({ jwk: JWK }).uploadUrl, TESTNET.uploadUrl);
  assert.equal(new TurboUpload({ jwk: JWK }).uploadUrl, PRODUCTION.uploadUrl, "production is the default");
});

test("trailing slashes on a custom URL do not produce a doubled path", async () => {
  const f = stubFetch({ body: { freeUploadLimitBytes: 1 } });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://example.test/", fetch: f });
  await c.getInfo();
  assert.equal(f.calls[0].url, "https://example.test/v1/info");
});

/* ---------------- timeouts and retries ---------------- */

test("there IS a default timeout, and it is configurable", () => {
  assert.equal(new TurboUpload({ jwk: JWK }).timeoutMs, 60_000);
  assert.equal(new TurboUpload({ jwk: JWK, timeoutMs: 1500 }).timeoutMs, 1500);
  assert.throws(() => new TurboUpload({ jwk: JWK, timeoutMs: 0 }), /positive number/);
  assert.throws(() => new TurboUpload({ jwk: JWK, timeoutMs: "30s" }), /positive number/);
});

test("a hung endpoint aborts with a TurboTimeoutError naming the endpoint", async () => {
  // turbo-sdk sets no timeout anywhere, so a hung endpoint hangs the caller
  // forever. This is the test that a default timeout actually fires.
  const hang = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
    });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://hung.test", timeoutMs: 60, retry: false, fetch: hang });
  await assert.rejects(c.getInfo(), (e) => {
    assert.ok(e instanceof TurboTimeoutError, `expected TurboTimeoutError, got ${e.name}`);
    assert.match(e.message, /timed out after 60ms/);
    assert.equal(e.endpoint, "https://hung.test/v1/info");
    assert.equal(e.timeoutMs, 60);
    return true;
  });
});

test("the caller's own AbortSignal is honoured and reported as such", async () => {
  const hang = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
    });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://hung.test", retry: false, fetch: hang });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(c.upload({ data: "x", signal: ac.signal }), (e) => {
    assert.ok(e instanceof TurboTimeoutError);
    assert.match(e.message, /aborted by the caller's signal/);
    return true;
  });
});

test("retry config is PARTIAL, not all-or-nothing", () => {
  // turbo-sdk makes you supply the whole config, including a retryCondition
  // you now own, just to change the attempt count.
  const c = new TurboUpload({ jwk: JWK, retry: { retries: 7 } });
  assert.equal(c.retry.retries, 7);
  assert.equal(c.retry.minDelayMs, 500, "untouched fields keep their defaults");
  assert.deepEqual(c.retry.retryStatuses, [408, 429, 500, 502, 503, 504]);
  assert.equal(new TurboUpload({ jwk: JWK, retry: false }).retry.retries, 0);
  assert.throws(() => new TurboUpload({ jwk: JWK, retry: { retries: -1 } }), /non-negative/);
  assert.throws(() => new TurboUpload({ jwk: JWK, retry: 3 }), TurboConfigError);
});

test("a retryable status is retried, a non-retryable one is not", async () => {
  const flaky = stubFetch([{ status: 503, body: "busy" }, { status: 200, body: { freeUploadLimitBytes: 42 } }]);
  const c = new TurboUpload({
    jwk: JWK,
    uploadUrl: "https://flaky.test",
    retry: { retries: 2, minDelayMs: 1 },
    fetch: flaky,
  });
  assert.equal((await c.getInfo()).freeUploadLimitBytes, 42);
  assert.equal(flaky.calls.length, 2);

  const hard = stubFetch({ status: 400, body: "nope" });
  const c2 = new TurboUpload({ jwk: JWK, uploadUrl: "https://hard.test", retry: { retries: 3, minDelayMs: 1 }, fetch: hard });
  await assert.rejects(c2.getInfo(), TurboHTTPError);
  assert.equal(hard.calls.length, 1, "a 400 is not retried");
});

/* ---------------- errors carry their cause ---------------- */

test("an HTTP error carries status, endpoint, method and body", async () => {
  // turbo-sdk surfaces a DNS failure as a bare `fetch failed`.
  const f = stubFetch({ status: 402, body: { error: "Insufficient balance" } });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://pay.test", retry: false, fetch: f });
  await assert.rejects(c.upload({ data: "x" }), (e) => {
    assert.ok(e instanceof TurboHTTPError);
    assert.equal(e.status, 402);
    assert.equal(e.endpoint, "https://pay.test/v1/tx");
    assert.equal(e.method, "POST");
    assert.deepEqual(e.body, { error: "Insufficient balance" });
    assert.match(e.message, /POST https:\/\/pay\.test\/v1\/tx failed: HTTP 402/);
    assert.match(e.message, /Insufficient balance/);
    return true;
  });
});

test("a network failure names the endpoint and chains the original cause", async () => {
  const boom = async () => {
    throw new TypeError("fetch failed");
  };
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://nx.test", retry: false, fetch: boom });
  await assert.rejects(c.getInfo(), (e) => {
    assert.ok(e instanceof TurboNetworkError);
    assert.equal(e.endpoint, "https://nx.test/v1/info");
    assert.match(e.message, /before any response was received: fetch failed/);
    assert.match(e.message, /hostname resolves/);
    assert.ok(e.cause instanceof TypeError, "the original error is chained as `cause`");
    return true;
  });
});

/* ---------------- upload ---------------- */

test("upload POSTs the raw item bytes as application/octet-stream to /v1/tx", async () => {
  let captured;
  const f = stubFetch((url, init) => {
    captured = { url, init };
    const id = idFromSignature(parseDataItem(Buffer.from(init.body)).rawSignature).toString("base64url");
    return new Response(JSON.stringify({ id, winc: "0", dataCaches: ["ar-io.dev"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://up.test", fetch: f });
  const res = await c.upload({ data: "hello", tags: [{ name: "Content-Type", value: "text/plain" }] });

  assert.equal(captured.url, "https://up.test/v1/tx");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["content-type"], "application/octet-stream");
  assert.ok(Buffer.isBuffer(captured.init.body), "the body is the raw item bytes");
  assert.equal(captured.init.headers["content-length"], String(captured.init.body.length));

  // and the item on the wire is the one we claim to have sent
  const parsed = parseDataItem(captured.init.body);
  assert.equal(parsed.signatureType, 1);
  assert.equal(parsed.rawData.toString(), "hello");
  assert.equal(res.id.length, 43);
  assert.equal(res.byteCount, captured.init.body.length);
  assert.equal(res.owner, c.address);
  assert.deepEqual(res.dataCaches, ["ar-io.dev"]);
  assert.equal(c.verify(captured.init.body), true);
});

test("an id the service invents is rejected, not passed through", async () => {
  // If the returned id is not sha256 of OUR signature, either the item was
  // altered in flight or this is not a Turbo upload service.
  const f = stubFetch({ body: { id: "not-the-id-you-signed", winc: "0" } });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://liar.test", fetch: f });
  await assert.rejects(c.upload({ data: "x" }), (e) => {
    assert.ok(e instanceof TurboVerificationError);
    assert.equal(e.receivedId, "not-the-id-you-signed");
    assert.equal(e.expectedId.length, 43);
    return true;
  });
});

test("upload without data is a clear validation error", async () => {
  const c = new TurboUpload({ jwk: JWK, fetch: stubFetch({ body: {} }) });
  await assert.rejects(c.upload({}), TurboValidationError);
  await assert.rejects(c.upload({ tags: [{ name: "a", value: "b" }] }), /`data` is required/);
});

test("sign() produces an uploadable item without touching the network", () => {
  const neverCalled = () => {
    throw new Error("network touched");
  };
  const c = new TurboUpload({ jwk: JWK, fetch: neverCalled });
  const item = c.sign({ data: "offline", tags: [{ name: "a", value: "b" }] });
  assert.ok(Buffer.isBuffer(item.binary));
  assert.equal(c.verify(item.binary, { strictSaltLength: true }), true);
  assert.equal(item.idB64Url.length, 43);
});

/* ---------------- payment surface ---------------- */

test("getUploadCost hits /v1/price/bytes/N and validates its argument", async () => {
  const f = stubFetch({ body: { winc: "1218703457", adjustments: [] } });
  const c = new TurboUpload({ jwk: JWK, paymentUrl: "https://pay.test", fetch: f });
  const price = await c.getUploadCost(107520);
  assert.equal(price.winc, "1218703457");
  assert.equal(f.calls[0].url, "https://pay.test/v1/price/bytes/107520");
  await assert.rejects(c.getUploadCost(-1), TurboValidationError);
  await assert.rejects(c.getUploadCost(1.5), /non-negative integer/);
});

test("getBalance turns the 404 for an unknown wallet into a zero balance", async () => {
  // The payment service answers 404 "User Not Found" for a wallet it has never
  // seen. That is a zero balance, not a failure — a new wallet asking its
  // balance should not throw.
  const f = stubFetch({ status: 404, body: "User Not Found", headers: { "content-type": "text/plain" } });
  const c = new TurboUpload({ jwk: JWK, paymentUrl: "https://pay.test", fetch: f });
  const bal = await c.getBalance();
  assert.deepEqual(bal, { winc: "0", controlledWinc: "0", effectiveBalance: "0", address: c.address });
  assert.match(f.calls[0].url, /^https:\/\/pay\.test\/v1\/account\/balance\/arweave\?address=/);

  const f2 = stubFetch({ body: { winc: "500", controlledWinc: "500", effectiveBalance: "500" } });
  const c2 = new TurboUpload({ jwk: JWK, paymentUrl: "https://pay.test", fetch: f2 });
  assert.equal((await c2.getBalance()).winc, "500");
});

test("the free-tier limit is READ from /v1/info, not hardcoded", async () => {
  const f = stubFetch({ body: { freeUploadLimitBytes: 107520, version: "0.2.0" } });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://up.test", fetch: f });
  assert.equal(await c.getFreeUploadLimitBytes(), 107520);
  assert.equal(f.calls[0].url, "https://up.test/v1/info");

  // A service that stops reporting it must fail loudly rather than fall back to
  // a stale constant baked into this package.
  const f2 = stubFetch({ body: { version: "9" } });
  const c2 = new TurboUpload({ jwk: JWK, uploadUrl: "https://up.test", fetch: f2 });
  await assert.rejects(c2.getFreeUploadLimitBytes(), /did not report freeUploadLimitBytes/);
});

/* ---------------- sign-then-upload ---------------- */

test("uploadSigned uploads the EXACT bytes signed, keeping the id stable", async () => {
  // The trap this method exists to close: RSA-PSS is randomised, so sign() then
  // upload() signs twice and the id you printed is not the id that landed.
  let posted;
  const f = stubFetch((url, init) => {
    posted = Buffer.from(init.body);
    const id = idFromSignature(parseDataItem(posted).rawSignature).toString("base64url");
    return new Response(JSON.stringify({ id, winc: "0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://up.test", fetch: f });

  const item = c.sign({ data: "stable", tags: [{ name: "a", value: "b" }] });
  const res = await c.uploadSigned(item);

  assert.equal(res.id, item.idB64Url, "the id survives sign -> upload");
  assert.equal(posted.toString("hex"), item.binary.toString("hex"), "the exact signed bytes were posted");
  assert.equal(res.owner, c.address);
});

test("signing twice really does produce different ids (why uploadSigned exists)", () => {
  const c = new TurboUpload({ jwk: JWK, fetch: stubFetch({ body: {} }) });
  const a = c.sign({ data: "same" });
  const b = c.sign({ data: "same" });
  assert.notEqual(a.idB64Url, b.idB64Url);
});

test("uploadSigned accepts raw bytes and rejects junk and unsigned items", async () => {
  const f = stubFetch((url, init) => {
    const id = idFromSignature(parseDataItem(Buffer.from(init.body)).rawSignature).toString("base64url");
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://up.test", fetch: f });

  const item = c.sign({ data: "raw" });
  assert.equal((await c.uploadSigned(item.binary)).id, item.idB64Url, "raw bytes work");

  await assert.rejects(c.uploadSigned(null), /expects the result of `sign\(\)`/);
  await assert.rejects(c.uploadSigned(Buffer.alloc(10)), /Not a parseable ANS-104 data item/);

  // An unsigned skeleton must be refused here, not by the service with an
  // opaque error a long way from the mistake.
  const unsigned = Buffer.from(item.binary);
  unsigned.fill(0, 2, 514);
  await assert.rejects(c.uploadSigned(unsigned), /not signed — its signature region is all zeroes/);
});

test("every public export is importable BY NAME from ESM", async () => {
  // Node detects named exports from a CJS module by static analysis of
  // module.exports. A spread (`...errors`) is opaque to that analysis, so the
  // error classes silently become non-importable from ESM even though the CJS
  // require works. This test is the tripwire.
  const url = require("node:url").pathToFileURL(require.resolve("../index.js")).href;
  const ns = await import(url);
  const expected = Object.keys(require("../index.js"));
  const missing = expected.filter((k) => !(k in ns));
  assert.deepEqual(missing, [], `not importable by name from ESM: ${missing.join(", ")}`);
  assert.ok(expected.includes("TurboHTTPError") && expected.includes("TurboUpload"));
});

test("a transport retry re-sends the SAME bytes, it never re-signs", async () => {
  // RSA-PSS draws a fresh random salt per signature, so signing twice produces
  // two different signatures, two different ids, and two distinct PAID items.
  // Re-sending identical bytes is safe instead, because the service deduplicates
  // on the data-item id: verified against the live testnet, the same signed item
  // uploaded twice returned one id and winc=0 both times.
  //
  // All of that safety rests on retry living BELOW the signing boundary. Move it
  // above and a transient 503 quietly becomes a second paid permanent write.
  // This test exists to stop that refactor, because the failure is invisible
  // until it appears on a bill.
  //
  // The stub answers like a real service would, echoing back the id of whatever
  // was actually POSTed. A fixed id would not do: the client verifies the echo,
  // so a stub that lies fails for the wrong reason.
  const posted = [];
  let firstCall = true;
  const flaky = async (url, init = {}) => {
    if ((init.method ?? "GET") !== "POST") {
      return new Response(JSON.stringify({ freeUploadLimitBytes: 107520 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const body = Buffer.from(init.body);
    posted.push(body);
    if (firstCall) {
      firstCall = false;
      return new Response("busy", { status: 503 });
    }
    const id = idFromSignature(parseDataItem(body).rawSignature).toString("base64url");
    return new Response(JSON.stringify({ id, winc: "0" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://example.test/", fetch: flaky });
  await c.upload({ data: Buffer.from("retry must not re-sign"), tags: [] });

  assert.equal(posted.length, 2, "expected exactly one retry");
  assert.ok(
    posted[0].equals(posted[1]),
    "the retry sent different bytes, so it re-signed: that is a second item and a second charge",
  );
});

test("a 402 throws TurboPaymentError, so a caller can tell it from a transient failure", async () => {
  // Established against the live testnet service: an unfunded wallet posting an
  // item over the free-tier ceiling gets HTTP 402 Payment Required. A payment
  // failure is NOT transient, and an integration that treats it like a 503 goes
  // quiet while reporting healthy. For an archive that is the worst available
  // failure mode, so the distinction is the package's job rather than every
  // consumer independently rediscovering that 402 is the answer.
  const broke = stubFetch({ status: 402, body: { x402Version: 1 }, headers: { "content-type": "application/json" } });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://example.test/", fetch: broke, retry: false });

  await assert.rejects(
    () => c.upload({ data: Buffer.from("cannot pay for this"), tags: [] }),
    (err) => {
      assert.ok(err instanceof TurboPaymentError, "402 must throw TurboPaymentError");
      assert.ok(err instanceof TurboHTTPError, "and must stay a TurboHTTPError so existing catches work");
      assert.equal(err.status, 402);
      return true;
    },
  );
});

test("a 503 stays a plain TurboHTTPError and is not mistaken for a payment failure", async () => {
  const busy = stubFetch({ status: 503, body: "busy" });
  const c = new TurboUpload({ jwk: JWK, uploadUrl: "https://example.test/", fetch: busy, retry: false });
  await assert.rejects(
    () => c.upload({ data: Buffer.from("transient"), tags: [] }),
    (err) => {
      assert.ok(err instanceof TurboHTTPError);
      assert.ok(!(err instanceof TurboPaymentError), "a 503 must not read as inability to pay");
      return true;
    },
  );
});
