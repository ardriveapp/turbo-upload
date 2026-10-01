"use strict";
/**
 * The web build, run the way a page runs it: in a fresh JavaScript realm with
 * no Buffer, no process, no TextEncoder or TextDecoder, no crypto, and a
 * require() that can load only this package's own relative files. A `node:`
 * import anywhere in the graph, or a stray Buffer, fails here.
 *
 * The browser harness (harness/) runs the same build in Chromium, Firefox,
 * WebKit and jsdom. This is the version that runs on every `npm test`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const node = require("../index.js");

const ROOT = path.join(__dirname, "..");

/**
 * Load web.js in a new realm. Globals are what a browser page has that this
 * build uses (fetch, AbortController, timers), and nothing else.
 */
function loadWebBuild({ fetch } = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    fetch,
    Response,
  });
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = fs.readFileSync(file, "utf8");
    const fn = vm.runInContext(`(function (exports, require, module) {${source}\n})`, context, { filename: file });
    const localRequire = (spec) => {
      if (!spec.startsWith(".")) throw new Error(`web build required ${JSON.stringify(spec)} from ${path.relative(ROOT, file)}`);
      return load(path.resolve(path.dirname(file), spec));
    };
    fn(module.exports, localRequire, module);
    return module.exports;
  };
  const web = load(path.join(ROOT, "web.js"));
  return { web, context, files: [...cache.keys()].map((f) => path.relative(ROOT, f)) };
}

/** A wallet in the outer realm: what a browser wallet adapter looks like to the client. */
function walletFor(seed) {
  const signer = node.createSolanaSigner(seed);
  return { ...signer, connected: true, name: "test wallet", icon: "data:," };
}

test("the web build loads with no Buffer, no process and no node: module", () => {
  const { web, context, files } = loadWebBuild();
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  assert.equal(vm.runInContext("typeof process", context), "undefined");
  assert.equal(vm.runInContext("typeof TextEncoder", context), "undefined", "the realm is as bare as jsdom");
  assert.equal(typeof web.TurboUpload, "function");
  assert.ok(files.every((f) => f === "web.js" || f.startsWith(`src${path.sep}core`) || f.startsWith(`src${path.sep}web`)),
    `the web graph reaches outside src/core and src/web: ${files.join(", ")}`);
});

test("the web build signs the type 4 corpus byte-identical to turbo-sdk, in a bare realm", async (t) => {
  const corpus = path.join(ROOT, "conformance", "type4-vectors.json");
  if (!fs.existsSync(corpus)) return t.skip("conformance/type4-vectors.json is not shipped; run from a checkout");
  const V = JSON.parse(fs.readFileSync(corpus, "utf8"));
  const { web } = loadWebBuild();
  for (const v of V.vectors) {
    const client = new web.TurboUpload({ signer: walletFor(Buffer.from(v.seed_hex, "hex")) });
    assert.equal(client.address, v.public_key_base58);
    const item = await client.signAsync({
      data: new Uint8Array(Buffer.from(v.input.data_hex, "hex")),
      tags: v.input.tags,
      target: v.input.target_b64url ?? undefined,
      anchor: v.input.anchor_utf8 ?? undefined,
    });
    assert.equal(Buffer.from(item.binary).toString("hex"), v.expected.signed_item_hex, v.name);
    assert.equal(item.idB64Url, v.expected.id_b64url, v.name);
    assert.equal(Object.prototype.toString.call(item.binary), "[object Uint8Array]");
    assert.equal(item.binary.constructor.name, "Uint8Array", "never a Buffer");
    // turbo-sdk's own bytes verify under the web build's verifier
    const verify = walletFor(Buffer.from(v.seed_hex, "hex")).verify;
    assert.equal(await web.verifyDataItem(new Uint8Array(Buffer.from(v.expected.signed_item_hex, "hex")), { verify }), true);
  }
});

test("the web build refuses a raw key and says why", () => {
  const { web } = loadWebBuild();
  assert.throws(
    () => new web.TurboUpload({ jwk: crypto.randomBytes(32), token: "solana" }),
    (err) => err.name === "TurboConfigError" && /wallet-style `signer`/.test(err.message),
  );
});

test("the web build cannot verify without a verifier, and says so rather than answering false", async () => {
  const { web } = loadWebBuild();
  const { verify, ...noVerify } = walletFor(crypto.randomBytes(32));
  const client = new web.TurboUpload({ signer: noVerify });
  // This realm has no WebCrypto, so there is nothing to check a signature with.
  await assert.rejects(client.signAsync({ data: "x" }), (err) => err.name === "TurboSignerError" && /signer\.verify/.test(err.message));
});

test("the web build uploads with x-paid-by, through fetch, and returns plain bytes", async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, init };
    const posted = Buffer.from(init.body);
    const id = crypto.createHash("sha256").update(posted.subarray(2, 66)).digest("base64url");
    return new Response(JSON.stringify({ id, winc: "0" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { web } = loadWebBuild({ fetch });
  const signer = walletFor(crypto.randomBytes(32));
  const client = web.TurboUpload.testnet({ signer });
  const payer = node.createSolanaSigner(crypto.randomBytes(32));
  const payerAddress = new node.TurboUpload({ signer: payer }).address;
  const res = await client.upload({ data: "paid by someone else", paidBy: payerAddress });
  assert.equal(captured.url, `${web.TESTNET.uploadUrl}/v1/tx`);
  assert.equal(captured.init.headers["x-paid-by"], payerAddress);
  assert.equal(captured.init.body.constructor.name, "Uint8Array", "the body is not a Buffer");
  assert.equal(res.id.length, 43);
  assert.equal(node.verifyDataItem(Buffer.from(captured.init.body)), true, "the item verifies under the Node build");
});
