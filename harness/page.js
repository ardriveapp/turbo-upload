// The browser side of the harness. Bundled by esbuild with platform "browser",
// so "@ardrive/turbo-upload" resolves through the package's `browser` export
// condition, exactly as it does in an application. No polyfills are added:
// the page has whatever the browser has, and nothing else.
//
// The wallet is @noble/ed25519 over a seed: a stand-in for a browser wallet
// adapter, with the same shape ({ publicKey, signMessage, verify }).
import * as turbo from "@ardrive/turbo-upload";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { deterministicBytes, guardedFetch } from "./data.mjs";

ed.hashes.sha512 = sha512;

const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16));
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A wallet-style signer over a 32-byte seed. `withVerify: false` leaves verification to WebCrypto. */
function wallet(seedHex, { withVerify = true } = {}) {
  const seed = fromHex(seedHex);
  const signer = {
    publicKey: ed.getPublicKey(seed),
    signMessage: async (message) => ed.sign(message, seed),
  };
  if (withVerify) signer.verify = (message, signature, publicKey) => ed.verify(signature, message, publicKey);
  return signer;
}

async function webCryptoHasEd25519() {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(1), { name: "Ed25519" }, false, ["verify"]);
    return Boolean(key);
  } catch (err) {
    return err && err.name === "NotSupportedError" ? false : "unknown: " + (err && err.name);
  }
}

/**
 * Sign every type 4 corpus vector and compare with turbo-sdk's bytes; verify
 * turbo-sdk's items here; flip a byte and expect rejection.
 */
async function corpus(vectors) {
  const out = {
    typeofBuffer: typeof Buffer,
    typeofProcess: typeof process,
    typeofTextEncoder: typeof TextEncoder,
    userAgent: typeof navigator === "undefined" ? "n/a" : navigator.userAgent,
    webCryptoEd25519: typeof crypto === "object" && crypto.subtle ? await webCryptoHasEd25519() : false,
    vectors: vectors.length,
    signedIdentical: 0,
    sdkItemsVerified: 0,
    tamperRejected: 0,
    webCryptoPath: "not run",
    mismatches: [],
  };
  for (const v of vectors) {
    const signer = wallet(v.seed_hex);
    const client = turbo.TurboUpload.testnet({ signer });
    if (client.address !== v.public_key_base58) out.mismatches.push(`${v.name}: address`);
    const item = await client.signAsync({
      data: fromHex(v.input.data_hex),
      tags: v.input.tags,
      target: v.input.target_b64url ?? undefined,
      anchor: v.input.anchor_utf8 ?? undefined,
    });
    if (toHex(item.binary) === v.expected.signed_item_hex && item.idB64Url === v.expected.id_b64url) out.signedIdentical++;
    else out.mismatches.push(`${v.name}: bytes`);
    if (item.binary.constructor !== Uint8Array) out.mismatches.push(`${v.name}: binary is ${item.binary.constructor.name}`);

    const sdkItem = fromHex(v.expected.signed_item_hex);
    if (await turbo.verifyDataItem(sdkItem, { verify: signer.verify })) out.sdkItemsVerified++;
    const tampered = sdkItem.slice();
    tampered[2] ^= 1;
    const tamperedData = sdkItem.slice();
    tamperedData[tamperedData.length - 1] ^= 1;
    const rejects = !(await turbo.verifyDataItem(tampered, { verify: signer.verify })) &&
      (v.input.data_hex === "" || !(await turbo.verifyDataItem(tamperedData, { verify: signer.verify })));
    if (rejects) out.tamperRejected++;
  }
  // Where the browser has Ed25519 in WebCrypto, sign once more with no
  // `verify` on the signer, so the client's own WebCrypto check is exercised.
  if (out.webCryptoEd25519 === true) {
    let ok = 0;
    for (const v of vectors) {
      const client = turbo.TurboUpload.testnet({ signer: wallet(v.seed_hex, { withVerify: false }) });
      const item = await client.signAsync({ data: fromHex(v.input.data_hex), tags: v.input.tags,
        target: v.input.target_b64url ?? undefined, anchor: v.input.anchor_utf8 ?? undefined });
      if (toHex(item.binary) === v.expected.signed_item_hex) ok++;
    }
    out.webCryptoPath = `${ok}/${vectors.length} identical, verified by WebCrypto Ed25519`;
  }
  return out;
}

/** SHA-256 hex of bytes, for reporting what was uploaded without shipping it back. */
async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * The live devnet flow. Every request goes through guardedFetch, which refuses
 * any host that is not a devnet host before the request leaves the page.
 */
async function devnet(params) {
  const fetch = guardedFetch(globalThis.fetch.bind(globalThis));
  const log = [];
  const results = { typeofBuffer: typeof Buffer, typeofProcess: typeof process, log, uploads: [] };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const value = await fn();
      log.push({ step: name, ok: true, ms: Date.now() - t0, value });
      return value;
    } catch (err) {
      log.push({ step: name, ok: false, ms: Date.now() - t0, error: `${err.name}: ${err.message}`, status: err.status });
      return undefined;
    }
  };
  const make = (seedHex) => turbo.TurboUpload.testnet({ signer: wallet(seedHex), fetch, timeoutMs: 120_000 });
  const freeSigner = make(params.freeSeedHex);
  const payer = make(params.payerSeedHex);
  results.payerAddress = payer.address;

  await step("info", async () => {
    const info = await freeSigner.getInfo();
    return { freeUploadLimitBytes: info.freeUploadLimitBytes, freeTier: info.freeTier };
  });
  await step("price for 1 MiB item", async () => (await freeSigner.getUploadCost(freeSigner.getDataItemSize({ dataSize: 1024 * 1024 }))).winc);
  await step("payer balance", async () => (await payer.getBalance()).winc);

  await step("free upload", async () => {
    const data = deterministicBytes(params.freeDataSeed, params.freeBytes);
    const res = await freeSigner.upload({ data, tags: [{ name: "Content-Type", value: "application/octet-stream" }, { name: "App-Name", value: "turbo-upload-harness" }] });
    results.uploads.push({ label: "free", id: res.id, seed: params.freeDataSeed, bytes: params.freeBytes, sha256: await sha256Hex(data), winc: res.winc });
    return { id: res.id, winc: res.winc };
  });

  return results;
}

globalThis.harness = { corpus, devnet, turbo };
