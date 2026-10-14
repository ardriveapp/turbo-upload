"use strict";
/**
 * Type 3 (EVM) signed uploads, end to end, against the testnet Turbo services,
 * inside the free tier: nothing is topped up and nothing is paid.
 *
 *   npm ci --prefix scripts
 *   EVM_KEY_FILE=evm-key.txt node scripts/live-base-sepolia-type3.js
 *   node scripts/live-base-sepolia-type3.js --check-guards     # offline: the refusals only
 *
 *   EVM_KEY_FILE  a file holding one raw 0x-prefixed hex secp256k1 private key,
 *                 readable by you alone. Read, never printed. It needs no funds.
 *   --large-mib   size of the larger upload. Default 1. It must fit the free
 *                 per-item ceiling the upload service reports in /v1/info.
 *
 * Two uploads, both signed with the key through viem: a small one through a
 * wallet-style signer that has no public key (so it signs the connect message
 * first), and a larger one through a viem account. Each carries a tag whose
 * value is not ASCII. Each is read back from https://ar-io.dev/raw/<id> and
 * compared byte for byte, and its tags and owner are read through
 * https://ar-io.dev/graphql. The upload service and the gateway both report the
 * owner as base64url(SHA-256(public key)), the Arweave form, so the 0x mapping
 * is checked through the free quota of the 0x address instead: read before and
 * after, it must move by exactly the bytes uploaded.
 *
 * Every request goes through one fetch that refuses any host but the testnet
 * upload, payment and gateway hosts, before the request leaves.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { privateKeyToAccount } = require("viem/accounts");
const { recoverPublicKey } = require("viem");
const { TurboUpload, TESTNET, PRODUCTION, verifyDataItem } = require("..");

/* ------------------------------ guards ------------------------------- */

const TESTNET_HOSTS = new Set(["upload.services.ar-io.dev", "payment.services.ar-io.dev", "ar-io.dev"]);
const PRODUCTION_HOSTS = new Set(
  [PRODUCTION.uploadUrl, PRODUCTION.paymentUrl, PRODUCTION.gatewayUrl, "https://arweave.net"].map((u) => new URL(u).hostname),
);

function assertTestnet(url, label) {
  const host = new URL(url).hostname;
  if (PRODUCTION_HOSTS.has(host) || /mainnet/.test(host)) {
    throw new Error(`REFUSING: ${label} ${url} is a production or mainnet host. This script is testnet only.`);
  }
  if (!TESTNET_HOSTS.has(host)) {
    throw new Error(`REFUSING: ${label} ${url} is not on the testnet host list (${[...TESTNET_HOSTS].join(", ")}).`);
  }
}

/** What the upload service answered to each POST, before the client reads it. */
const serviceAnswers = [];
const realFetch = globalThis.fetch;
const guardedFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assertTestnet(url, "request to");
  const res = await realFetch(input, init);
  if (init && init.method === "POST" && new URL(url).pathname === "/v1/tx") {
    serviceAnswers.push(await res.clone().json().catch(() => null));
  }
  return res;
};
globalThis.fetch = guardedFetch;

/* ------------------------------ options ------------------------------ */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const GATEWAY = TESTNET.gatewayUrl;

if (args.includes("--check-guards")) {
  const refused = [];
  for (const url of [PRODUCTION.uploadUrl, PRODUCTION.paymentUrl, PRODUCTION.gatewayUrl, "https://arweave.net/x", "https://base-mainnet.example.com", "https://example.com"]) {
    try {
      assertTestnet(url, "check");
    } catch {
      refused.push(url);
    }
  }
  for (const url of [TESTNET.uploadUrl, TESTNET.paymentUrl, GATEWAY]) assertTestnet(url, "default");
  console.log(`guards: refused ${refused.length}/6 production or unknown hosts; the three testnet defaults pass`);
  process.exit(refused.length === 6 ? 0 : 1);
}

const keyPath = process.env.EVM_KEY_FILE;
if (!keyPath) {
  console.error("No key. Set EVM_KEY_FILE to a file holding a raw 0x-hex private key.");
  process.exit(2);
}
if ((fs.statSync(keyPath).mode & 0o077) !== 0) {
  console.error(`${keyPath} is readable by other users. chmod 600 it first.`);
  process.exit(2);
}
const keyText = fs.readFileSync(keyPath, "utf8").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(keyText)) {
  console.error(`${keyPath} does not hold one 0x-prefixed 32-byte hex key.`);
  process.exit(2);
}
const account = privateKeyToAccount(keyText);
const LARGE_MIB = Number(arg("--large-mib", "1"));
if (!(LARGE_MIB > 0 && LARGE_MIB <= 5)) {
  console.error("--large-mib must be over 0 and at most 5.");
  process.exit(2);
}

/* ------------------------------ helpers ------------------------------ */

const line = (k, v) => console.log(`    ${k.padEnd(26)} ${v}`);
const failures = [];
const testnet = (signer) => TurboUpload.testnet({ signer, token: "base-eth", timeoutMs: 120_000 });

/** Read an item back in 1 MiB ranges. A 402, 404, 429 or 5xx waits 30 s and retries; gives up after an hour. */
async function fetchBack(id, expected) {
  const url = `${GATEWAY}/raw/${id}`;
  const got = Buffer.alloc(expected.length);
  const t0 = Date.now();
  let pos = 0;
  while (pos < expected.length) {
    if (Date.now() - t0 > 60 * 60 * 1000) return `gave up at byte ${pos}`;
    const end = Math.min(pos + 1024 * 1024, expected.length) - 1;
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
      if ([402, 404, 429].includes(res.status) || res.status >= 500) {
        await res.arrayBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (res.status !== 206 && res.status !== 200) return `HTTP ${res.status}`;
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 200) return body.equals(expected) ? "byte-identical" : "bytes differ";
      body.copy(got, pos, 0, end - pos + 1);
      pos = end + 1;
    } catch {
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return got.equals(expected) ? "byte-identical" : "bytes differ";
}

/** The gateway's GraphQL node for `id`, or null if it has none yet. Polls every 15 s for up to 15 minutes. */
async function graphqlNode(id) {
  const query = `{ transactions(ids: ["${id}"]) { edges { node { id owner { address key } tags { name value } } } } }`;
  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60 * 1000) {
    try {
      const res = await fetch(`${GATEWAY}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      if (res.ok) {
        const edges = (await res.json())?.data?.transactions?.edges ?? [];
        if (edges.length) return edges[0].node;
      } else {
        await res.arrayBuffer().catch(() => {});
      }
    } catch {
      // retried below
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return null;
}

/* ------------------------------- flow -------------------------------- */

(async () => {
  // The browser shape: no public key, so the client recovers it from the connect message.
  const wallet = { address: account.address, signMessage: (args) => account.signMessage(args), recoverPublicKey };
  const viaWallet = testnet(wallet);
  const viaAccount = testnet({ ...account, recoverPublicKey });

  console.log("Type 3 (EVM) signed uploads, testnet, free tier");
  line("upload service", viaAccount.uploadUrl);
  line("payment service", viaAccount.paymentUrl);
  line("signer", viaAccount.address);

  const info = await viaAccount.getInfo();
  const ceiling = info.freeTier?.maxItemBytes ?? info.freeUploadLimitBytes;
  line("free per-item ceiling", ceiling);
  const quotaBefore = (await viaAccount.getFreeQuota()).bytesRemaining;
  const balanceBefore = await viaAccount.getBalance();
  line("free quota before", quotaBefore);
  line("base-eth balance before", `${balanceBefore.winc} winc`);

  const runId = crypto.randomBytes(4).toString("hex");
  const tags = [
    { name: "Content-Type", value: "application/octet-stream" },
    { name: "App-Name", value: "turbo-upload-type3-e2e" },
    { name: "Title", value: `Ünïcode ✓ 日本語 ${runId}` },
  ];
  const uploads = [
    { label: "small, wallet with no public key", client: viaWallet, data: Buffer.from(`turbo-upload type 3 e2e ${runId}\n`) },
    { label: `${LARGE_MIB} MiB, viem account`, client: viaAccount, data: crypto.randomBytes(Math.round(LARGE_MIB * 1024 * 1024)) },
  ];
  let bytesUploaded = 0;

  for (const u of uploads) {
    console.log(`\n[${u.label}: ${u.data.length} data bytes]`);
    try {
      const size = u.client.getDataItemSize({ data: u.data, tags });
      if (size > ceiling) throw new Error(`the item is ${size} bytes, over the free ceiling of ${ceiling}: not uploading, nothing is paid here`);
      const item = await u.client.signAsync({ data: u.data, tags });
      line("signed", `${item.idB64Url}, ${item.binary.length} bytes, signature type ${item.binary.readUInt16LE(0)}`);
      if (!(await verifyDataItem(item.binary, { recoverPublicKey, strictV: true }))) failures.push(`${u.label}: does not verify strictly`);
      const res = await u.client.uploadSigned(item);
      const answer = serviceAnswers[serviceAnswers.length - 1] || {};
      line("id", res.id);
      line("charged", `${res.winc} winc`);
      line("service says owner", answer.owner);
      if (res.winc !== "0") failures.push(`${u.label}: charged ${res.winc} winc, expected the free tier`);
      if (answer.owner !== res.owner) failures.push(`${u.label}: the service reported owner ${answer.owner}, not base64url(SHA-256(key)) ${res.owner}`);
      bytesUploaded += res.byteCount;

      const back = await fetchBack(res.id, u.data);
      line("read back", `${GATEWAY}/raw/${res.id} -> ${back}`);
      if (back !== "byte-identical") failures.push(`${u.label}: read back ${back}`);

      const node = await graphqlNode(res.id);
      if (!node) {
        failures.push(`${u.label}: ${GATEWAY}/graphql never reported the item`);
        line("graphql", "not indexed within 15 minutes");
      } else {
        const missing = tags.filter((t) => !node.tags.some((s) => s.name === t.name && s.value === t.value));
        line("graphql tags", missing.length ? `MISSING ${JSON.stringify(missing)}` : `all ${tags.length} there exactly`);
        if (missing.length) failures.push(`${u.label}: tags missing from the indexed item: ${JSON.stringify(missing)}`);
        const keyMatches = Buffer.from(node.owner.key, "base64url").equals(Buffer.from(u.client.owner));
        line("graphql owner.key", keyMatches ? "the 65-byte public key the item carries" : `DIFFERS: ${node.owner.key}`);
        line("graphql owner.address", node.owner.address);
        if (!keyMatches) failures.push(`${u.label}: the indexed owner key is not the signer's`);
      }
    } catch (err) {
      failures.push(`${u.label}: ${err.name}: ${err.message}`);
      line("FAILED", `${err.name}: ${err.message}`.slice(0, 600));
    }
  }

  console.log("\n[whose quota]");
  const quotaAfter = (await viaAccount.getFreeQuota()).bytesRemaining;
  const balanceAfter = await viaAccount.getBalance();
  line("free quota after", quotaAfter);
  line("drawn", `${quotaBefore - quotaAfter} bytes for ${bytesUploaded} item bytes uploaded`);
  line("base-eth balance after", `${balanceAfter.winc} winc`);
  if (quotaBefore - quotaAfter !== bytesUploaded) {
    failures.push(`the 0x address's free quota moved by ${quotaBefore - quotaAfter}, not by the ${bytesUploaded} item bytes uploaded`);
  }

  if (failures.length) {
    console.log(`\n${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nALL UPLOADS SIGNED, STORED, READ BACK AND COUNTED AGAINST THE 0x ADDRESS");
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  process.exit(1);
});
