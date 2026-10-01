"use strict";
/**
 * Chunked uploads against an in-process multipart service: the four routes
 * turbo-sdk uses, the chunks reassembled by offset, and the receipt's id
 * computed from what actually arrived. No network.
 *
 * The live version, on devnet, is scripts/live-solana-devnet.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { Buffer } = require("node:buffer");

const {
  TurboUpload,
  TurboPaymentError,
  TurboChunkedUploadError,
  TurboValidationError,
  TurboHTTPError,
  createSolanaSigner,
  verifyDataItem,
} = require("../index.js");
const web = require("../web.js");
const { timeoutFor, shouldChunk, singleItemLimitFrom } = require("../src/core/chunked.js");

const MiB = 1024 * 1024;
const SEED = crypto.randomBytes(32);

/**
 * A multipart upload service in a fetch. `finalStatus` decides how it ends;
 * `failOnce` makes one chunk offset answer 503 the first time.
 */
function multipartService({ finalStatus = "FINALIZED", failOnce, singleLimit = 10 * MiB, statusPending = 0 } = {}) {
  const uploads = new Map();
  const log = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    log.push({ method, path: u.pathname + u.search, headers: init.headers ?? {}, bytes: init.body ? init.body.length : 0 });
    let m;
    if (method === "POST" && u.pathname === "/v1/tx") {
      const body = Buffer.from(init.body);
      if (body.length > singleLimit) {
        return new Response(`Data item is too large, this service only accepts data items up to ${singleLimit} bytes!`, { status: 400 });
      }
      const id = crypto.createHash("sha256").update(body.subarray(2, 66)).digest("base64url");
      return json(200, { id, winc: "0" });
    }
    if ((m = u.pathname.match(/^\/v1\/chunks\/solana\/-1\/-1$/))) {
      assert.equal(init.headers["x-chunking-version"], "2");
      const id = crypto.randomUUID();
      uploads.set(id, { parts: new Map(), polls: 0, failed: new Set() });
      return json(200, { id, min: 5 * MiB, max: 500 * MiB, chunkSize: Number(u.searchParams.get("chunkSize")) });
    }
    if ((m = u.pathname.match(/^\/v1\/chunks\/solana\/([^/]+)\/(\d+)$/)) && method === "POST") {
      const up = uploads.get(m[1]);
      const offset = Number(m[2]);
      assert.equal(init.headers["x-chunking-version"], "2");
      if (failOnce === offset && !up.failed.has(offset)) {
        up.failed.add(offset);
        return new Response("busy", { status: 503 });
      }
      up.parts.set(offset, Buffer.from(init.body));
      return new Response("OK", { status: 200 });
    }
    if ((m = u.pathname.match(/^\/v1\/chunks\/solana\/([^/]+)\/finalize$/))) {
      const up = uploads.get(m[1]);
      up.paidBy = init.headers["x-paid-by"];
      const offsets = [...up.parts.keys()].sort((a, b) => a - b);
      up.item = Buffer.concat(offsets.map((o) => up.parts.get(o)));
      return new Response("Accepted", { status: 202 });
    }
    if ((m = u.pathname.match(/^\/v1\/chunks\/solana\/([^/]+)\/status$/))) {
      const up = uploads.get(m[1]);
      if (!up.item) return new Response("not yet", { status: 503 });
      if (up.polls++ < statusPending) return json(200, { status: "ASSEMBLING" });
      if (finalStatus !== "FINALIZED") return json(200, { status: finalStatus });
      const id = crypto.createHash("sha256").update(up.item.subarray(2, 66)).digest("base64url");
      return json(200, { status: "FINALIZED", receipt: { id, winc: "12345", owner: "x" } });
    }
    return new Response("not routed", { status: 404 });
  };
  fn.log = log;
  fn.uploads = uploads;
  return fn;
}

const client = (fetch, extra = {}) => new TurboUpload({ jwk: SEED, token: "solana", uploadUrl: "https://up.test", fetch, retry: { minDelayMs: 1 }, ...extra });

test("an item over two chunks goes chunked, reassembles byte for byte, and pays at finalize", async () => {
  const svc = multipartService();
  const c = client(svc);
  const data = crypto.randomBytes(12 * MiB + 123);
  const progress = [];
  const res = await c.upload({ data, paidBy: "PAYER", onProgress: (p) => progress.push(p.processedBytes) });
  const [up] = [...svc.uploads.values()];
  assert.ok(verifyDataItem(up.item), "the reassembled item verifies");
  assert.equal(Buffer.from(up.item.subarray(up.item.length - data.length)).equals(data), true);
  assert.equal(res.id, crypto.createHash("sha256").update(up.item.subarray(2, 66)).digest("base64url"));
  assert.equal(res.byteCount, up.item.length);
  assert.equal(res.winc, "12345");
  assert.equal(up.paidBy, "PAYER", "x-paid-by travels on finalize");
  const chunkPosts = svc.log.filter((l) => /\/chunks\/solana\/[^/]+\/\d+$/.test(l.path));
  assert.deepEqual(chunkPosts.map((l) => l.bytes), [5 * MiB, 5 * MiB, up.item.length - 10 * MiB]);
  assert.ok(chunkPosts.every((l) => !("x-paid-by" in l.headers)), "chunks themselves carry no payer");
  assert.equal(progress.at(-1), up.item.length);
});

test("ten MiB and under is one POST, as before; chunking can be forced or turned off", async () => {
  const svc = multipartService();
  const c = client(svc);
  await c.upload({ data: crypto.randomBytes(9 * MiB) });
  assert.ok(svc.log.every((l) => l.path === "/v1/tx"), "one POST to /v1/tx");
  await c.upload({ data: crypto.randomBytes(MiB), chunking: "force" });
  assert.ok(svc.log.some((l) => l.path.includes("/finalize")), "forced: chunked even when small");
  assert.equal(shouldChunk(10 * MiB, { chunking: "auto", chunkSize: 5 * MiB }), false);
  assert.equal(shouldChunk(10 * MiB + 1, { chunking: "auto", chunkSize: 5 * MiB }), true);
  assert.equal(shouldChunk(50 * MiB, { chunking: "disabled", chunkSize: 5 * MiB }), false);
});

test("a single POST refused as too large is resent in chunks, and the limit is remembered", async () => {
  const svc = multipartService({ singleLimit: 2 * MiB });
  const c = client(svc);
  const res = await c.upload({ data: crypto.randomBytes(3 * MiB) });
  assert.equal(res.winc, "12345", "it went through the multipart route");
  assert.equal(c._singleItemLimit, 2 * MiB, "the limit was read from the service's answer");
  svc.log.length = 0;
  await c.upload({ data: crypto.randomBytes(3 * MiB) });
  assert.equal(svc.log.filter((l) => l.path === "/v1/tx").length, 0, "the next large item went straight to chunks");
  await assert.rejects(client(multipartService({ singleLimit: MiB })).upload({ data: crypto.randomBytes(2 * MiB), chunking: "disabled" }), TurboHTTPError);
  assert.equal(singleItemLimitFrom({ status: 400, body: "this service only accepts data items up to 10485760 bytes!" }), 10485760);
  assert.equal(singleItemLimitFrom({ status: 402, body: "up to 1 bytes" }), undefined);
});

test("a chunk that fails is retried alone, not the item", async () => {
  const svc = multipartService({ failOnce: 5 * MiB });
  const res = await client(svc).upload({ data: crypto.randomBytes(11 * MiB) });
  const posts = svc.log.filter((l) => /\/chunks\/solana\/[^/]+\/\d+$/.test(l.path)).map((l) => l.path.split("/").pop());
  assert.deepEqual(posts.sort(), ["0", "10485760", "5242880", "5242880"].sort());
  assert.equal(res.id.length, 43);
});

test("UNDERFUNDED is a TurboPaymentError; INVALID is a TurboChunkedUploadError; both carry the upload id", async () => {
  await assert.rejects(client(multipartService({ finalStatus: "UNDERFUNDED" })).upload({ data: crypto.randomBytes(11 * MiB) }), (err) => {
    assert.ok(err instanceof TurboPaymentError);
    assert.equal(err.status, 402);
    assert.match(err.uploadId, /-/);
    return true;
  });
  await assert.rejects(client(multipartService({ finalStatus: "INVALID", statusPending: 1 })).upload({ data: crypto.randomBytes(11 * MiB) }), (err) => {
    assert.ok(err instanceof TurboChunkedUploadError);
    assert.equal(err.uploadStatus, "INVALID");
    assert.ok(err.uploadId);
    return true;
  });
});

test("uploadStream signs a Node stream without holding it, and refuses a stream that changes", async () => {
  const data = crypto.randomBytes(11 * MiB + 7);
  const pieces = (buf) => Readable.from((function* () { for (let i = 0; i < buf.length; i += 65536) yield buf.subarray(i, i + 65536); })());
  for (const c of [client(multipartService()), new TurboUpload({ signer: createSolanaSigner(SEED), uploadUrl: "https://up.test", fetch: multipartService() })]) {
    const svc = c.fetch;
    const res = await c.uploadStream({ streamFactory: () => pieces(data), size: data.length, tags: [{ name: "a", value: "b" }] });
    const [up] = [...svc.uploads.values()];
    assert.ok(verifyDataItem(up.item), "the streamed item verifies");
    // The same item signed in memory is byte-identical: Ed25519 is deterministic.
    const inMemory = await c.signAsync({ data, tags: [{ name: "a", value: "b" }] });
    assert.ok(Buffer.from(inMemory.binary).equals(up.item));
    assert.equal(res.id, inMemory.idB64Url);
  }
  const small = crypto.randomBytes(1000);
  const svc = multipartService();
  const r = await client(svc).uploadStream({ streamFactory: () => pieces(small), size: small.length });
  assert.equal(svc.log.length, 1, "a small stream is one POST");
  assert.equal(r.byteCount, small.length + 116);

  let calls = 0;
  const changing = () => pieces(calls++ === 0 ? data : crypto.randomBytes(data.length));
  const svc2 = multipartService();
  await assert.rejects(client(svc2).uploadStream({ streamFactory: changing, size: data.length }), /different bytes the second time/);
  assert.equal(svc2.log.some((l) => l.path.includes("/finalize")), false, "never finalized, so never charged");
  await assert.rejects(client(svc2).uploadStream({ streamFactory: () => pieces(small), size: 999 }), /stream produced 1000 bytes/);
  await assert.rejects(client(svc2).uploadStream({ streamFactory: pieces(small), size: 1000 }), /must be a function/);
});

test("the web build streams a web ReadableStream the same way", async () => {
  const data = crypto.randomBytes(11 * MiB);
  const svc = multipartService();
  const signer = createSolanaSigner(SEED);
  const c = new web.TurboUpload({ signer, uploadUrl: "https://up.test", fetch: svc });
  const res = await c.uploadStream({ streamFactory: () => new Blob([data]).stream(), size: data.length });
  const [up] = [...svc.uploads.values()];
  assert.ok(verifyDataItem(up.item));
  assert.equal(res.id, crypto.createHash("sha256").update(up.item.subarray(2, 66)).digest("base64url"));
});

test("options are checked before anything is signed or sent", async () => {
  const svc = multipartService();
  const c = client(svc);
  for (const bad of [{ chunking: "always" }, { chunkSize: MiB }, { chunkSize: 501 * MiB }, { chunkConcurrency: 0 }, { onProgress: 1 }, { chunksize: 5 * MiB }]) {
    await assert.rejects(c.upload({ data: "x", ...bad }), TurboValidationError);
  }
  assert.equal(svc.log.length, 0);
  assert.equal(timeoutFor(1024, 60_000), 60_000, "a small request keeps the configured timeout");
  assert.equal(timeoutFor(10 * MiB, 60_000), 80_000, "10 MiB is given 80 s at the 128 KiB/s floor");
  assert.equal(timeoutFor(1, 60), 60, "a short test timeout is not stretched");
});

test("200 MiB through the in-process service, from bytes and from a stream", {
  skip: process.env.TURBO_UPLOAD_LARGE ? false : "set TURBO_UPLOAD_LARGE=1: 200 MiB in memory twice",
}, async () => {
  // Devnet finalizes nothing over 10 MiB, so this is the run at real size:
  // 41 chunks in flight five at a time, reassembled by offset, the receipt's
  // id computed from what arrived.
  const data = crypto.randomBytes(200 * MiB);
  const svc = multipartService();
  const c = client(svc);
  const t0 = Date.now();
  const res = await c.upload({ data });
  const [up] = [...svc.uploads.values()];
  assert.equal(up.parts.size, 41);
  assert.ok(Buffer.from(up.item.subarray(up.item.length - data.length)).equals(data));
  assert.equal(res.id, crypto.createHash("sha256").update(up.item.subarray(2, 66)).digest("base64url"));
  const svc2 = multipartService();
  const res2 = await client(svc2).uploadStream({
    streamFactory: () => Readable.from((function* () { for (let i = 0; i < data.length; i += MiB) yield data.subarray(i, i + MiB); })()),
    size: data.length,
  });
  assert.equal(res2.id, res.id, "the streamed item is byte-identical to the in-memory one");
  console.log(`200 MiB: ${up.parts.size} chunks, both paths, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
});
