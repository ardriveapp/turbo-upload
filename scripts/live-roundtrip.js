"use strict";
/**
 * Live round trip against the TESTNET upload service.
 *
 *   node scripts/live-roundtrip.js --key /path/to/wallet.json
 *   ARWEAVE_JWK="$(cat wallet.json)" node scripts/live-roundtrip.js
 *
 * Signs a small item (inside the free tier), uploads it, checks the returned id
 * against the id computed locally, then retrieves it from the gateway and
 * compares the bytes and the content type.
 *
 * This script REFUSES to talk to production. Mainnet uploads are permanent and
 * cost real money; that is not something a test script should be able to do by
 * a typo or an inherited environment variable.
 */

const fs = require("node:fs");
const { Buffer } = require("node:buffer");
const { TurboUpload, TESTNET, PRODUCTION } = require("../index.js");

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const keyPath = argOf("--key");
const jwk = keyPath ? fs.readFileSync(keyPath, "utf8") : process.env.ARWEAVE_JWK;
if (!jwk) {
  console.error("No key. Pass --key <path> or set ARWEAVE_JWK.");
  process.exit(2);
}

const uploadUrl = argOf("--upload") ?? TESTNET.uploadUrl;
const gatewayUrl = argOf("--gateway") ?? TESTNET.gatewayUrl;

// The guard. Refuse anything that looks like mainnet.
for (const [label, url] of [["upload", uploadUrl], ["gateway", gatewayUrl]]) {
  if (url === PRODUCTION.uploadUrl || url === PRODUCTION.paymentUrl || /ardrive\.io|arweave\.net/.test(url)) {
    console.error(`REFUSING: ${label} URL "${url}" is production. This script is testnet-only.`);
    process.exit(2);
  }
}

const line = (k, v) => console.log(`    ${k.padEnd(18)} ${v}`);

(async () => {
  const client = TurboUpload.testnet({ jwk, uploadUrl, timeoutMs: 30_000 });

  console.log("Turbo testnet round trip");
  line("upload service", client.uploadUrl);
  line("payment service", client.paymentUrl);
  line("gateway", gatewayUrl);
  line("wallet", client.address);

  console.log("\n[1] service info");
  const info = await client.getInfo();
  line("version", info.version);
  line("free tier bytes", info.freeUploadLimitBytes);
  line("gateway", info.gateway);

  console.log("\n[2] balance (a wallet with no credits is expected to be zero)");
  const balance = await client.getBalance();
  line("winc", balance.winc);

  const stamp = new Date().toISOString();
  const data = Buffer.from(`@ardrive/turbo-upload live round trip ${stamp}\n`, "utf8");
  const tags = [
    { name: "Content-Type", value: "text/plain; charset=utf-8" },
    { name: "App-Name", value: "ar-io-turbo-upload" },
    { name: "App-Version", value: require("../package.json").version },
    { name: "Unicode-Check", value: "héllo ✅ 日本語 🎉" },
  ];

  console.log("\n[3] sign locally");
  const item = client.sign({ data, tags });
  line("payload bytes", data.length);
  line("item bytes", item.binary.length);
  line("local id", item.idB64Url);
  line("self-verify", client.verify(item.binary));
  line("strict salt", client.verify(item.binary, { strictSaltLength: true }));

  console.log("\n[4] price check");
  const price = await client.getUploadCost(item.binary.length);
  const free = item.binary.length <= info.freeUploadLimitBytes;
  line("winc for item", price.winc);
  line("within free tier", `${free} (${item.binary.length} <= ${info.freeUploadLimitBytes})`);
  if (!free) {
    console.error("REFUSING: the item exceeds the free tier and this script must not spend credits.");
    process.exit(2);
  }

  console.log("\n[5] upload the bytes we just signed");
  // uploadSigned, NOT upload: upload() would sign a SECOND time, and RSA-PSS is
  // randomised, so the id printed above would not be the id that landed.
  const res = await client.uploadSigned(item);
  line("returned id", res.id);
  line("matches local", res.id === item.idB64Url);
  line("winc charged", res.winc ?? "(none)");
  line("byte count", res.byteCount);
  if (res.dataCaches) line("data caches", res.dataCaches.join(", "));
  if (res.id !== item.idB64Url) {
    console.error("MISMATCH: the service returned an id we did not sign.");
    process.exit(1);
  }

  console.log("\n[6] retrieve from the gateway");
  const deadline = Date.now() + 180_000;
  let attempt = 0;
  for (;;) {
    attempt++;
    const r = await fetch(`${gatewayUrl}/${res.id}`).catch((e) => ({ ok: false, status: e.message }));
    if (r.ok) {
      const got = Buffer.from(await r.arrayBuffer());
      line("attempt", attempt);
      line("status", r.status);
      line("content-type", r.headers.get("content-type"));
      line("bytes match", got.equals(data));
      line("content", JSON.stringify(got.toString("utf8")));
      if (!got.equals(data)) {
        console.error("MISMATCH: retrieved bytes differ from what we uploaded.");
        process.exit(1);
      }
      console.log(`\nROUND TRIP OK  ${gatewayUrl}/${res.id}`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.log(`\nUPLOAD OK but retrieval did not resolve within the window (last status ${r.status}).`);
      console.log(`It may still land later: ${gatewayUrl}/${res.id}`);
      process.exit(1);
    }
    process.stdout.write(`    attempt ${attempt} -> ${r.status}, retrying\n`);
    await new Promise((r2) => setTimeout(r2, 5000));
  }
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  if (err.endpoint) console.error(`  endpoint: ${err.endpoint}`);
  if (err.status) console.error(`  status:   ${err.status}`);
  if (err.cause) console.error(`  cause:    ${err.cause.message ?? err.cause}`);
  process.exit(1);
});
