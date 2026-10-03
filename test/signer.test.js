"use strict";
/**
 * Wallet-style signers: { publicKey, signMessage, verify? }, the shape of a
 * Solana wallet adapter. No network; fetch is injected where a call is made.
 *
 * The rule under test is that a signature is VERIFIED before it is used. A
 * wallet that signs something other than the bytes it was handed produces an
 * item that verifies nowhere, and the place to find that out is here, not
 * after paying to upload it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const {
  TurboUpload,
  TurboSignerError,
  TurboConfigError,
  TurboValidationError,
  createSolanaSigner,
  verifyDataItem,
  parseDataItem,
  idFromSignature,
} = require("../index.js");
const { encodeBase58 } = require("../src/base58.js");

const SEED = crypto.randomBytes(32);
const keypair = () => createSolanaSigner(SEED);

/** A fetch stub that answers like the upload service and records what it got. */
function echoFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const id = idFromSignature(parseDataItem(Buffer.from(init.body)).rawSignature).toString("base64url");
    return new Response(JSON.stringify({ id, winc: "0" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

test("createSolanaSigner has the wallet shape, and signs the bytes it is given", async () => {
  const signer = keypair();
  assert.equal(signer.publicKey.length, 32);
  const message = Buffer.from("plain message");
  const signature = await signer.signMessage(message);
  assert.equal(signature.length, 64);
  assert.equal(signer.verify(message, signature, signer.publicKey), true);
  assert.equal(signer.verify(Buffer.from("other"), signature, signer.publicKey), false);
});

test("a signer client and a key client sign identical bytes for the same key", async () => {
  const fromKey = new TurboUpload({ jwk: SEED, token: "solana" });
  const fromSigner = new TurboUpload({ signer: keypair() });
  assert.equal(fromSigner.address, fromKey.address);
  assert.equal(fromSigner.token, "solana");
  assert.equal(fromSigner.signatureType, 4);
  const opts = { data: "same", tags: [{ name: "a", value: "b" }] };
  const a = fromKey.sign(opts);
  const b = await fromSigner.signAsync(opts);
  assert.ok(Buffer.isBuffer(b.binary), "the Node build returns a Buffer whichever way it signed");
  assert.equal(b.binary.toString("hex"), a.binary.toString("hex"));
  assert.equal(b.idB64Url, a.idB64Url);
  assert.equal(verifyDataItem(b.binary), true);
});

test("signAsync on a key client is sign(), in a promise", async () => {
  const c = new TurboUpload({ jwk: SEED, token: "solana" });
  assert.equal((await c.signAsync({ data: "x" })).idB64Url, c.sign({ data: "x" }).idB64Url);
  await assert.rejects(c.signAsync({ data: "x", tag: [] }), /did you mean `tags`/);
});

test("sign() on a signer client explains that it needs signAsync()", () => {
  const c = new TurboUpload({ signer: keypair() });
  assert.throws(() => c.sign({ data: "x" }), (err) => err instanceof TurboConfigError && /signAsync/.test(err.message));
});

test("a wallet that returns { signature } (Phantom's provider) works, and so does a wallet adapter object", async () => {
  const inner = keypair();
  const adapter = {
    name: "Some Wallet",
    url: "https://example.test",
    connected: true,
    publicKey: { toBytes: () => inner.publicKey, toBase58: () => encodeBase58(inner.publicKey) },
    signMessage: async (m) => ({ signature: await inner.signMessage(m), publicKey: "ignored" }),
    connect: async () => {},
  };
  const item = await new TurboUpload({ signer: adapter }).signAsync({ data: "via adapter" });
  assert.equal(verifyDataItem(item.binary), true);
});

test("publicKey is accepted as bytes, base58, toBytes() or toBuffer()", () => {
  const { publicKey, signMessage } = keypair();
  const address = encodeBase58(publicKey);
  for (const pk of [publicKey, address, { toBytes: () => publicKey }, { toBuffer: () => Buffer.from(publicKey) }, Array.from(publicKey)]) {
    assert.equal(new TurboUpload({ signer: { publicKey: pk, signMessage } }).address, address);
  }
  assert.throws(() => new TurboUpload({ signer: { publicKey: null, signMessage } }), /connect it first/);
  assert.throws(() => new TurboUpload({ signer: { publicKey: "0OIl", signMessage } }), /base58/);
  assert.throws(() => new TurboUpload({ signer: { publicKey: new Uint8Array(31), signMessage } }), /32 bytes/);
  assert.throws(() => new TurboUpload({ signer: { publicKey } }), /signMessage` must be a function/);
  assert.throws(() => new TurboUpload({ signer: { publicKey, signMessage, verify: true } }), /verify` must be a function/);
});

test("signer and jwk together, or a signer with another token, fail at construction", () => {
  assert.throws(() => new TurboUpload({ signer: keypair(), jwk: SEED }), (e) => e instanceof TurboConfigError && /not both/.test(e.message));
  assert.throws(() => new TurboUpload({ signer: keypair(), token: "arweave" }), /token` must be "solana"/);
  assert.equal(new TurboUpload({ signer: keypair(), token: "solana" }).token, "solana");
});

test("a wallet that signs something else is refused before anything is uploaded", async () => {
  // The two real ways this goes wrong: a wallet that signs the raw 48-byte deep
  // hash rather than its hex, and one that prefixes the message.
  const inner = keypair();
  const fetch = echoFetch();
  for (const wrong of [
    async (m) => inner.signMessage(Buffer.from(Buffer.from(m).toString(), "hex")),
    async (m) => inner.signMessage(Buffer.concat([Buffer.from("\xffsolana offchain"), Buffer.from(m)])),
  ]) {
    const c = new TurboUpload({ signer: { publicKey: inner.publicKey, signMessage: wrong }, fetch });
    await assert.rejects(c.upload({ data: "x" }), (err) => {
      assert.ok(err instanceof TurboSignerError, `expected TurboSignerError, got ${err.name}`);
      assert.match(err.message, /does not verify/);
      assert.match(err.message, /Nothing was uploaded/);
      return true;
    });
  }
  assert.equal(fetch.calls.length, 0, "nothing reached the network");
});

test("a signMessage that throws (a Ledger refusing the bytes) is a TurboSignerError carrying the cause", async () => {
  const { publicKey } = keypair();
  const ledger = new Error("Ledger device: UNKNOWN_ERROR (0x6a81)");
  const c = new TurboUpload({ signer: { publicKey, signMessage: async () => { throw ledger; } } });
  await assert.rejects(c.signAsync({ data: "x" }), (err) => {
    assert.ok(err instanceof TurboSignerError);
    assert.equal(err.cause, ledger);
    assert.match(err.message, /0x6a81/);
    assert.match(err.message, /hardware wallet/);
    return true;
  });
});

test("a signMessage that returns the wrong shape is a TurboSignerError", async () => {
  const { publicKey } = keypair();
  for (const bad of [new Uint8Array(63), "a string", null, { sig: new Uint8Array(64) }]) {
    const c = new TurboUpload({ signer: { publicKey, signMessage: async () => bad } });
    await assert.rejects(c.signAsync({ data: "x" }), TurboSignerError);
  }
});

test("upload() with a signer signs once, verifies, and posts with x-paid-by", async () => {
  const inner = keypair();
  let calls = 0;
  const signer = { publicKey: inner.publicKey, signMessage: (m) => { calls++; return inner.signMessage(m); } };
  const fetch = echoFetch();
  const c = new TurboUpload({ signer, uploadUrl: "https://up.test", fetch });
  const payer = encodeBase58(crypto.randomBytes(32));
  const res = await c.upload({ data: "paid elsewhere", tags: [{ name: "a", value: "b" }], paidBy: payer });
  assert.equal(calls, 1);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://up.test/v1/tx");
  assert.equal(fetch.calls[0].init.headers["x-paid-by"], payer);
  assert.ok(Buffer.isBuffer(fetch.calls[0].init.body));
  assert.equal(res.id, idFromSignature(parseDataItem(fetch.calls[0].init.body).rawSignature).toString("base64url"));
});

test("paidBy is one address: a list or junk is refused before the wallet is asked", async () => {
  let calls = 0;
  const inner = keypair();
  const signer = { publicKey: inner.publicKey, signMessage: (m) => { calls++; return inner.signMessage(m); } };
  const fetch = echoFetch();
  const c = new TurboUpload({ signer, fetch });
  for (const bad of [["a", "b"], ["a"], "a,b", "", " ", 42]) {
    await assert.rejects(c.upload({ data: "x", paidBy: bad }), TurboValidationError);
  }
  assert.equal(calls, 0, "the wallet was never prompted");
  await assert.rejects(c.uploadSigned(Buffer.alloc(0), { paidBy: ["a", "b"] }), /one address, not a list/);
  // Without paidBy, no header at all, so a key client's request is unchanged.
  const k = new TurboUpload({ jwk: SEED, token: "solana", fetch });
  await k.upload({ data: "x" });
  assert.equal("x-paid-by" in fetch.calls.at(-1).init.headers, false);
});

test("getDataItemSize matches the signed item, for both signature types", async () => {
  const rsa = new TurboUpload({ jwk: crypto.generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey.export({ format: "jwk" }) });
  const sol = new TurboUpload({ signer: keypair() });
  const variants = [
    { data: "" },
    { data: "hello" },
    { data: new Uint8Array(1000), tags: [{ name: "Content-Type", value: "image/png" }, { name: "名前", value: "値" }] },
    { data: "t", target: crypto.randomBytes(32).toString("base64url"), anchor: "a".repeat(32) },
  ];
  for (const v of variants) {
    assert.equal(rsa.getDataItemSize(v), rsa.sign(v).binary.length);
    assert.equal(sol.getDataItemSize(v), (await sol.signAsync(v)).binary.length);
    const { data, ...rest } = v;
    assert.equal(sol.getDataItemSize({ ...rest, dataSize: Buffer.byteLength(data) }), (await sol.signAsync(v)).binary.length);
  }
  assert.throws(() => sol.getDataItemSize({}), /exactly one of `data` or `dataSize`/);
  assert.throws(() => sol.getDataItemSize({ data: "x", dataSize: 1 }), /exactly one/);
  assert.throws(() => sol.getDataItemSize({ dataSize: -1 }), /non-negative integer/);
  assert.throws(() => sol.getDataItemSize({ dataSize: 1, anchor: "short" }), /Anchor must be 32 bytes/);
  assert.throws(() => sol.getDataItemSize({ dataSize: 1, tag: [] }), /did you mean `tags`/);
});
