"use strict";
/**
 * x402 uploads on the unsigned route, end to end, against the testnet upload
 * service, paid in Base Sepolia USDC: test money, not real money.
 *
 *   npm ci --prefix scripts
 *   node scripts/live-base-sepolia-x402.js --new-key x402-key.json   # writes a key, mode 600, prints its address
 *   X402_KEY_FILE=x402-key.json node scripts/live-base-sepolia-x402.js [--quote-only]
 *   node scripts/live-base-sepolia-x402.js --check-guards            # offline: the refusals only
 *
 *   X402_KEY_FILE  a file holding one raw 0x-prefixed hex secp256k1 private key
 *                  (what --new-key writes), readable by you alone. Read, never
 *                  printed. Fund its address with Base Sepolia USDC before a
 *                  paid run.
 *   --quote-only   get each upload's 402 quote and stop before anything is signed.
 *   --max-usdc     cap per upload, USDC base units. Default 1000000 (1 USDC).
 *   --large-mib    size of the larger upload. Default 5.
 *
 * Each upload carries a Content-Type, a tag whose value is not ASCII and a
 * mixed-case tag name. Its tags are checked through https://ar-io.dev/graphql,
 * and its bytes are read back from https://ar-io.dev/raw/<id> and compared byte
 * for byte. Every request goes through one fetch that refuses any host not on
 * the testnet list, and the signer refuses typed data for any chain but Base
 * Sepolia (84532), so nothing here can authorize a payment on Base (8453).
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");
const { uploadUnsignedX402, getUnsignedX402Price, TESTNET, PRODUCTION, X402_NETWORKS } = require("..");

/* ------------------------------ guards ------------------------------- */

const TESTNET_HOSTS = new Set(["upload.services.ar-io.dev", "ar-io.dev"]);
const PRODUCTION_HOSTS = new Set([PRODUCTION.uploadUrl, PRODUCTION.paymentUrl, PRODUCTION.gatewayUrl, "https://arweave.net"].map((u) => new URL(u).hostname));
const CHAIN_ID = 84532;

function assertTestnet(url, label) {
  const host = new URL(url).hostname;
  if (PRODUCTION_HOSTS.has(host) || /mainnet/.test(host)) {
    throw new Error(`REFUSING: ${label} ${url} is a production or mainnet host. This script is testnet only.`);
  }
  if (!TESTNET_HOSTS.has(host)) {
    throw new Error(`REFUSING: ${label} ${url} is not on the testnet host list (${[...TESTNET_HOSTS].join(", ")}).`);
  }
}

const realFetch = globalThis.fetch;
const guardedFetch = (input, init) => {
  assertTestnet(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "request to");
  return realFetch(input, init);
};
globalThis.fetch = guardedFetch;

/** The account, refusing to sign for any chain but Base Sepolia. */
function sepoliaOnly(account, onSign) {
  return {
    address: account.address,
    signTypedData: async (typedData) => {
      if (typedData.domain.chainId !== CHAIN_ID) throw new Error(`REFUSING: typed data for chain ${typedData.domain.chainId}, not ${CHAIN_ID}.`);
      if (onSign) onSign(typedData);
      return account.signTypedData(typedData);
    },
  };
}

/* ------------------------------ options ------------------------------ */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const GATEWAY = "https://ar-io.dev";
const UPLOAD_URL = TESTNET.uploadUrl;

if (args.includes("--check-guards")) {
  const refused = [];
  for (const url of [PRODUCTION.uploadUrl, PRODUCTION.gatewayUrl, "https://arweave.net/x", "https://base-mainnet.example.com", "https://example.com"]) {
    try {
      assertTestnet(url, "check");
    } catch {
      refused.push(url);
    }
  }
  for (const url of [UPLOAD_URL, GATEWAY]) assertTestnet(url, "default");
  const signer = sepoliaOnly({ address: "0x", signTypedData: async () => "0x" });
  const mainnet = signer.signTypedData({ domain: { chainId: 8453 } }).then(() => false, () => true);
  mainnet.then((chainRefused) => {
    const ok = refused.length === 5 && chainRefused && X402_NETWORKS["base-sepolia"].chainId === CHAIN_ID;
    console.log(`guards: refused ${refused.length}/5 production or unknown hosts, chain 8453 ${chainRefused ? "refused" : "NOT refused"}; the testnet defaults pass`);
    process.exit(ok ? 0 : 1);
  });
  return;
}

if (args.includes("--new-key")) {
  const path = arg("--new-key");
  if (!path) {
    console.error("--new-key takes the path to write the key to.");
    process.exit(2);
  }
  if (fs.existsSync(path)) {
    console.error(`${path} already exists. This never overwrites a key.`);
    process.exit(2);
  }
  const key = generatePrivateKey();
  fs.writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  console.log(`wrote a new key to ${path} (mode 600). Address, to fund with Base Sepolia USDC:\n${privateKeyToAccount(key).address}`);
  return;
}

const keyPath = process.env.X402_KEY_FILE;
if (!keyPath) {
  console.error("No key. Set X402_KEY_FILE to a file holding a raw 0x-hex private key, such as one --new-key wrote.");
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
const MAX_USDC = BigInt(arg("--max-usdc", "1000000"));
const LARGE_MIB = Number(arg("--large-mib", "5"));
const QUOTE_ONLY = args.includes("--quote-only");
if (MAX_USDC <= 0n || MAX_USDC > 5_000_000n || !(LARGE_MIB > 0 && LARGE_MIB <= 100)) {
  console.error("--max-usdc must be 1 to 5000000 (5 USDC); --large-mib must be over 0 and at most 100.");
  process.exit(2);
}

/* ------------------------------ helpers ------------------------------ */

const line = (k, v) => console.log(`    ${k.padEnd(24)} ${v}`);
const failures = [];
const STOP = new Error("stopped before signing (--quote-only)");

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

/**
 * The tags the gateway indexed for `id`, or null if it has none yet. Polls
 * GraphQL every 15 s for up to 15 minutes; an item is indexed some time after
 * it is stored.
 */
async function storedTags(id) {
  const query = `{ transactions(ids: ["${id}"]) { edges { node { tags { name value } } } } }`;
  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60 * 1000) {
    try {
      const res = await fetch(`${GATEWAY}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      if (res.ok) {
        const edges = (await res.json())?.data?.transactions?.edges ?? [];
        if (edges.length) return edges[0].node.tags;
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
  console.log(`x402 unsigned uploads, Base Sepolia${QUOTE_ONLY ? ", quote only" : ""}`);
  line("upload service", UPLOAD_URL);
  line("payer", account.address);
  line("cap per upload", `${MAX_USDC} USDC base units`);

  const runId = crypto.randomBytes(4).toString("hex");
  const files = [
    { label: "small", data: Buffer.from(`turbo-upload x402 e2e ${runId}\n`) },
    { label: `${LARGE_MIB} MiB`, data: crypto.randomBytes(Math.round(LARGE_MIB * 1024 * 1024)) },
  ];
  const tags = [
    { name: "Content-Type", value: "text/plain; charset=utf-8" },
    { name: "App-Name", value: "turbo-upload-x402-e2e" },
    { name: "Title", value: `Ünïcode ✓ ${runId}` },
    { name: "appName_Mixed", value: "case" },
  ];

  for (const f of files) {
    console.log(`\n[${f.label}: ${f.data.length} bytes]`);
    try {
      const price = await getUnsignedX402Price({ byteCount: f.data.length, tags, uploadUrl: UPLOAD_URL });
      line("price route", `${price.usdcAmount} USDC base units for ~${price.estimatedDataItemSize} bytes`);
      const signer = sepoliaOnly(account, (t) => {
        line("402 asks", `${t.message.value} USDC base units to ${t.message.to}, domain "${t.domain.name}" v${t.domain.version}, chain ${t.domain.chainId}`);
        if (QUOTE_ONLY) throw STOP;
      });
      const res = await uploadUnsignedX402({ data: f.data, tags, signer, maxUsdc: MAX_USDC, uploadUrl: UPLOAD_URL, timeoutMs: 120_000 });
      line("id", res.id);
      line("owner (service)", res.owner);
      line("payer", res.payer);
      line("tx hash", res.x402Payment ? res.x402Payment.transactionHash : "(none reported)");
      if (String(res.payer).toLowerCase() !== account.address.toLowerCase()) failures.push(`${f.label}: payer ${res.payer} is not ${account.address}`);
      const back = await fetchBack(res.id, f.data);
      line("read back", `${GATEWAY}/raw/${res.id} -> ${back}`);
      if (back !== "byte-identical") failures.push(`${f.label}: read back ${back}`);
      const stored = await storedTags(res.id);
      if (!stored) {
        failures.push(`${f.label}: ${GATEWAY}/graphql never reported the item`);
        line("tags", "not indexed within 15 minutes");
      } else {
        const missing = tags.filter((t) => !stored.some((s) => s.name === t.name && s.value === t.value));
        line("tags", `${stored.length} stored, ${missing.length ? `MISSING ${JSON.stringify(missing)}` : `all ${tags.length} sent are there exactly`}`);
        if (missing.length) failures.push(`${f.label}: tags missing from the stored item: ${JSON.stringify(missing)}`);
      }
    } catch (err) {
      if (err === STOP || err.cause === STOP) {
        line("stopped", "before signing (--quote-only): nothing signed, nothing paid");
        continue;
      }
      failures.push(`${f.label}: ${err.name}: ${err.message}`);
      line("FAILED", `${err.name}: ${err.message}`.slice(0, 600));
    }
  }

  if (failures.length) {
    console.log(`\n${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(QUOTE_ONLY ? "\nQUOTES OK, nothing paid" : "\nALL UPLOADS PAID, STORED AND READ BACK");
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  process.exit(1);
});
