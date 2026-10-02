"use strict";
/**
 * The whole Solana flow against the Solana devnet and the testnet Turbo
 * services, with real money that is not real: devnet SOL.
 *
 *   npm ci --prefix scripts
 *   node scripts/live-solana-devnet.js --key wallet.json [--payer-key payer.json]
 *   node scripts/live-solana-devnet.js --check-guards     # offline: the refusals only
 *
 *   --key          solana-keygen JSON file holding devnet SOL. It pays for the
 *                  top-up transfer. Read, never printed.
 *   --payer-key    the address whose Turbo credits pay for uploads. Defaults to
 *                  --key. The top-up credits this address (memo
 *                  turboCreditDestinationAddress), so a funded key can top up
 *                  a separate payer and keep its own balance out of the test.
 *   --topup        lamports to top up with. Default 5000000 (0.005 SOL).
 *   --rpc          default https://api.devnet.solana.com. Anything else that is
 *                  not a devnet host is refused.
 *   --upload-url, --payment-url
 *                  default the TESTNET records. Production hosts are refused.
 *   --chunked      MiB sizes for the large chunked uploads. Default "50,200".
 *   --skip         step names to skip, separated by "|"
 *
 * Every upload is fetched back from https://ar-io.dev/raw/<id> and compared
 * byte for byte with what was sent, in ranges that wait out the gateway's
 * per-client read budget. Every request, from this package and from
 * @solana/web3.js, goes through one fetch that refuses any host not on the
 * devnet list before the request leaves.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { Readable } = require("node:stream");
const {
  TurboUpload,
  TESTNET,
  PRODUCTION,
  TurboPaymentError,
  TurboChunkedUploadError,
  createSolanaSigner,
} = require("..");

/* ------------------------------ guards ------------------------------- */

const DEVNET_HOSTS = new Set([
  "upload.services.ar-io.dev",
  "payment.services.ar-io.dev",
  "ar-io.dev",
  "api.devnet.solana.com",
]);
const PRODUCTION_HOSTS = new Set(
  [PRODUCTION.uploadUrl, PRODUCTION.paymentUrl, PRODUCTION.gatewayUrl, "https://arweave.net", "https://api.mainnet-beta.solana.com"]
    .map((u) => new URL(u).hostname),
);

/** Throws for any URL this script must not reach. */
function assertDevnet(url, label) {
  const host = new URL(url).hostname;
  if (PRODUCTION_HOSTS.has(host) || /mainnet/.test(host)) {
    throw new Error(`REFUSING: ${label} ${url} is a production or mainnet host. This script is devnet only.`);
  }
  if (!DEVNET_HOSTS.has(host)) {
    throw new Error(`REFUSING: ${label} ${url} is not on the devnet host list (${[...DEVNET_HOSTS].join(", ")}).`);
  }
}

const realFetch = globalThis.fetch;
/** The only fetch anything here uses. */
const guardedFetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assertDevnet(url, "request to");
  return realFetch(input, init);
};
globalThis.fetch = guardedFetch;

/* ------------------------------ options ------------------------------ */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const RPC = arg("--rpc", "https://api.devnet.solana.com");
const UPLOAD_URL = arg("--upload-url", TESTNET.uploadUrl);
const PAYMENT_URL = arg("--payment-url", TESTNET.paymentUrl);
const GATEWAY = "https://ar-io.dev";
const SKIP = new Set((arg("--skip", "") || "").split("|").filter(Boolean));
const LARGE_MIB = (arg("--chunked", "50,200") || "").split(",").filter(Boolean).map(Number);

if (args.includes("--check-guards")) {
  // Offline: every refusal this script promises, without touching the network.
  const refused = [];
  for (const url of [
    "https://api.mainnet-beta.solana.com", "https://solana-mainnet.example.com", PRODUCTION.uploadUrl,
    PRODUCTION.paymentUrl, "https://arweave.net/x", "https://example.com",
  ]) {
    try {
      assertDevnet(url, "check");
    } catch (err) {
      refused.push(url);
    }
  }
  for (const url of [RPC, UPLOAD_URL, PAYMENT_URL, GATEWAY]) assertDevnet(url, "default");
  console.log(`guards: refused ${refused.length}/6 production or unknown hosts; the four devnet defaults pass`);
  process.exit(refused.length === 6 ? 0 : 1);
}

for (const [label, url] of [["--rpc", RPC], ["--upload-url", UPLOAD_URL], ["--payment-url", PAYMENT_URL]]) {
  try {
    assertDevnet(url, label);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

const keyPath = arg("--key", process.env.SOLANA_DEVNET_KEY);
if (!keyPath) {
  console.error("No key. Pass --key <solana-keygen JSON file> holding devnet SOL.");
  process.exit(2);
}
const readKey = (p) => Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")));
const walletSecret = readKey(keyPath);
const payerSecret = arg("--payer-key") ? readKey(arg("--payer-key")) : walletSecret;
const TOPUP = Number(arg("--topup", "5000000"));
if (!Number.isSafeInteger(TOPUP) || TOPUP <= 0 || TOPUP > 100_000_000) {
  console.error("--topup must be a positive number of lamports, at most 100000000 (0.1 SOL).");
  process.exit(2);
}

/* ------------------------------ helpers ------------------------------ */

const web3 = require("@solana/web3.js");
const connection = new web3.Connection(RPC, { commitment: "confirmed", fetch: guardedFetch });
const MEMO_PROGRAM = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const testnet = (opts) => new TurboUpload({ uploadUrl: UPLOAD_URL, paymentUrl: PAYMENT_URL, timeoutMs: 120_000, ...opts });
const ephemeral = () => testnet({ jwk: crypto.randomBytes(32), token: "solana" });
const line = (k, v) => console.log(`    ${k.padEnd(30)} ${v}`);
const failures = [];
const uploads = [];
const TAGS = [{ name: "Content-Type", value: "application/octet-stream" }, { name: "App-Name", value: "turbo-upload-devnet-e2e" }];

async function step(name, fn) {
  if (SKIP.has(name)) {
    console.log(`\n[${name}] SKIPPED (--skip)`);
    return undefined;
  }
  console.log(`\n[${name}]`);
  const t0 = Date.now();
  try {
    const value = await fn();
    line("result", `ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return value;
  } catch (err) {
    failures.push(`${name}: ${err.name}: ${err.message}`);
    line("FAILED", `${err.name}: ${err.message}`.slice(0, 600));
    return undefined;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(`expectation failed: ${message}`);
}

/** Record an upload for the fetch-back pass at the end. */
function recorded(label, res, data) {
  uploads.push({ label, id: res.id, data, winc: res.winc });
  line("id", `${res.id} (${data.length} data bytes, winc ${res.winc})`);
}

async function winc(client, address) {
  return BigInt((await client.getBalance(address ? { address } : {})).winc);
}

/** The approval the payer gave `to`, as the payer's balance reports it. */
async function approvalTo(payer, to) {
  const bal = await payer.getBalance();
  return (bal.givenApprovals || []).find((a) => a.approvedAddress === to);
}

/**
 * Read an item back from the gateway in 1 MiB ranges and compare it.
 *
 * The gateway gives each client a byte budget for reads (its /ar-io/info
 * reports 102,400,000 bytes, refilling at 20,480 bytes a second) and answers
 * 402 with an x402 offer once the budget is spent. It is a budget, not a
 * size limit: any item can be read, a large one over time. A 402, a 429 or a 404 (not indexed yet) waits 30 s and reads the same
 * range again; nothing is paid. Gives up after two hours.
 */
async function fetchBack(id, expected) {
  const url = `${GATEWAY}/raw/${id}`;
  const got = Buffer.alloc(expected.length);
  const t0 = Date.now();
  let pos = 0;
  let reads = 0;
  let waits = 0;
  while (pos < expected.length) {
    if (Date.now() - t0 > 2 * 60 * 60 * 1000) return { equal: false, reads, waits, error: `gave up at byte ${pos}` };
    const end = Math.min(pos + 1024 * 1024, expected.length) - 1;
    let res;
    try {
      res = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
      if ([402, 404, 429].includes(res.status)) {
        await res.arrayBuffer().catch(() => {});
        waits++;
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (res.status !== 206 && res.status !== 200) return { equal: false, reads, waits, error: `HTTP ${res.status}` };
      const body = Buffer.from(await res.arrayBuffer());
      reads++;
      if (res.status === 200) return { equal: body.equals(expected), reads, waits, error: "full body" };
      body.copy(got, pos, 0, end - pos + 1);
      pos = end + 1;
    } catch (err) {
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return { equal: got.equals(expected), reads, waits, error: "bytes differ" };
}

/* ------------------------------- flow -------------------------------- */

(async () => {
  const wallet = web3.Keypair.fromSecretKey(walletSecret);
  const payer = testnet({ jwk: payerSecret, token: "solana" });
  const walletSigner = testnet({ signer: createSolanaSigner(payerSecret) }); // the payer, through the wallet shape
  const lamportsBefore = await connection.getBalance(wallet.publicKey);

  console.log("Solana devnet end to end");
  line("rpc", RPC);
  line("upload service", UPLOAD_URL);
  line("payment service", PAYMENT_URL);
  line("SOL from", wallet.publicKey.toBase58());
  line("credits held by", payer.address);
  line("SOL balance", `${lamportsBefore} lamports`);

  const info = await step("info and quotas", async () => {
    const up = await payer.getInfo();
    const fresh = ephemeral();
    line("free item ceiling", up.freeTier?.maxItemBytes ?? up.freeUploadLimitBytes);
    line("free lifetime per signer", up.freeTier?.lifetimeBytes);
    line("funding address", await payer.getFundingAddress());
    line("payer free quota", (await payer.getFreeQuota()).bytesRemaining);
    line("fresh key free quota", (await fresh.getFreeQuota()).bytesRemaining);
    expect(typeof up.freeUploadLimitBytes === "number", "the upload service reports freeUploadLimitBytes");
    return up;
  });
  const freeCeiling = info?.freeTier?.maxItemBytes ?? info?.freeUploadLimitBytes ?? 5 * 1024 * 1024;
  const paidSize = freeCeiling + 256 * 1024; // 256 KiB over the free per-item ceiling

  await step("prices", async () => {
    const sol = await payer.getWincForToken(1_000_000_000);
    line("1 SOL buys", `${sol.winc} winc (fees ${JSON.stringify(sol.fees.map((f) => f.name))})`);
    const itemSize = payer.getDataItemSize({ dataSize: paidSize, tags: TAGS });
    line(`${itemSize}-byte item costs`, `${(await payer.getUploadCost(itemSize)).winc} winc`);
    expect(BigInt(sol.winc) > 0n, "1 SOL buys a positive amount");
  });

  await step("free upload", async () => {
    const signer = ephemeral();
    const data = crypto.randomBytes(64 * 1024);
    const res = await signer.upload({ data, tags: TAGS });
    expect(res.winc === "0", `a free upload is charged nothing, got ${res.winc}`);
    recorded("free upload", res, data);
  });

  await step("paid upload with zero balance is refused", async () => {
    const broke = ephemeral();
    try {
      await broke.upload({ data: crypto.randomBytes(paidSize), tags: TAGS });
    } catch (err) {
      expect(err instanceof TurboPaymentError, `expected TurboPaymentError, got ${err.name}: ${err.message}`);
      line("refused with", `${err.name} HTTP ${err.status}`);
      return;
    }
    throw new Error("an item over the free ceiling uploaded from an empty account");
  });

  await step("SOL top-up to a credited balance", async () => {
    const funding = new web3.PublicKey(await payer.getFundingAddress());
    const before = await winc(payer);
    const blockhash = await connection.getLatestBlockhash("finalized");
    const tx = new web3.Transaction({ feePayer: wallet.publicKey, ...blockhash });
    tx.add(web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: funding, lamports: TOPUP }));
    if (payer.address !== wallet.publicKey.toBase58()) {
      tx.add(new web3.TransactionInstruction({
        programId: MEMO_PROGRAM,
        keys: [],
        data: Buffer.from(`turboCreditDestinationAddress=${payer.address}`),
      }));
    }
    tx.sign(wallet);
    const signature = await connection.sendRawTransaction(tx.serialize());
    line("transfer", `${TOPUP} lamports, ${signature}`);
    const t0 = Date.now();
    await connection.confirmTransaction({ signature, ...blockhash }, "finalized");
    line("finalized after", `${((Date.now() - t0) / 1000).toFixed(1)}s`);

    let result;
    for (let i = 0; i < 20; i++) {
      result = await payer.submitFundTransaction(signature);
      line(`submit ${i + 1}`, `${result.status}${result.winc ? `, ${result.winc} winc` : ""}`);
      if (result.status !== "pending") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(result.status === "confirmed", `the top-up was credited, got ${result.status}`);
    const after = await winc(payer);
    line("credited", `${after - before} winc (balance ${before} -> ${after})`);
    expect(after - before === BigInt(result.winc), "the balance moved by exactly the credited amount");

    const again = await payer.submitFundTransaction(signature);
    const afterAgain = await winc(payer);
    line("submitted again", `${again.status}; balance ${afterAgain}`);
    expect(afterAgain === after, "submitting the same transaction twice credits nothing twice");
  });

  await step("paid upload", async () => {
    const before = await winc(payer);
    const data = crypto.randomBytes(paidSize);
    const res = await payer.upload({ data, tags: TAGS });
    const after = await winc(payer);
    line("charged", `${res.winc} winc; balance ${before} -> ${after}`);
    expect(BigInt(res.winc) > 0n, "an item over the free ceiling is charged");
    expect(before - after === BigInt(res.winc), "the payer's balance moved by exactly the charge");
    recorded("paid upload", res, data);
  });

  for (const [label, sharer] of [["", payer], [", wallet-style signer", walletSigner]]) {
    await step(`credit sharing, then a paidBy upload${label}`, async () => {
      const spender = label ? testnet({ signer: createSolanaSigner(crypto.randomBytes(32)) }) : ephemeral();
      const itemSize = spender.getDataItemSize({ dataSize: paidSize, tags: TAGS });
      const price = BigInt((await payer.getUploadCost(itemSize)).winc);
      const approved = (price * 12n) / 10n;
      const approval = await sharer.shareCredits({ approvedAddress: spender.address, approvedWincAmount: approved, expiresBySeconds: 900 });
      line("approval", `${approval.approvalDataItemId}: ${approval.approvedWincAmount} winc to ${spender.address}`);
      expect(approval.approvedAddress === spender.address, "the approval names the spender");

      const usedBefore = BigInt((await approvalTo(payer, spender.address))?.usedWincAmount ?? "0");
      const data = crypto.randomBytes(paidSize);
      const res = await spender.upload({ data, tags: TAGS, paidBy: payer.address });
      const usedAfter = BigInt((await approvalTo(payer, spender.address))?.usedWincAmount ?? "0");
      line("charged", `${res.winc} winc; approval used ${usedBefore} -> ${usedAfter}`);
      expect(BigInt(res.winc) > 0n, "the paidBy upload is charged");
      expect(usedAfter - usedBefore === BigInt(res.winc), "the charge came out of the payer's approval");
      expect((await winc(spender)) === 0n, "the spender's own balance is untouched");
      recorded(`paidBy upload${label}`, res, data);
    });
  }

  await step("a wallet built outside this package", async () => {
    // A wallet that is not this package's: a seed, node:crypto, and the
    // { publicKey, signMessage } shape a browser wallet adapter has.
    const seed = crypto.randomBytes(32);
    const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const publicKey = Buffer.from(crypto.createPublicKey(key).export({ format: "jwk" }).x, "base64url");
    const wallet2 = { publicKey, signMessage: async (m) => ({ signature: new Uint8Array(crypto.sign(null, Buffer.from(m), key)) }) };
    const client = testnet({ signer: wallet2 });
    const data = crypto.randomBytes(32 * 1024);
    const res = await client.upload({ data, tags: TAGS });
    expect(res.winc === "0", "free");
    recorded("wallet-style free upload", res, data);
  });

  await step("Stripe checkout session (test mode)", async () => {
    const s = await payer.createCheckoutSession({ amount: 1000, currency: "usd" });
    line("session", `${s.id}, ${s.winc} winc for ${s.actualPaymentAmount} cents`);
    expect(/^cs_test_/.test(s.id), "the testnet service answers with a Stripe TEST-mode session");
    expect(typeof s.url === "string" && s.url.startsWith("https://"), "a hosted checkout URL");
  });

  /* ------------------------------ chunked ----------------------------- */

  const MiB = 1024 * 1024;
  await step("chunked upload, two 5 MiB chunks", async () => {
    // Exactly 10 MiB: one byte under the size that goes chunked on its own,
    // so chunking is forced. Over the free per-item ceiling, so it is paid.
    const overhead = payer.getDataItemSize({ dataSize: 0, tags: TAGS });
    const data = crypto.randomBytes(10 * MiB - overhead);
    const chunks = [];
    const before = await winc(payer);
    const res = await payer.upload({ data, tags: TAGS, chunking: "force", onProgress: (p) => chunks.push(p.processedBytes) });
    const after = await winc(payer);
    line("item bytes", `${res.byteCount} in ${chunks.length} chunks, upload ${res.uploadId}`);
    line("charged", `${res.winc} winc; balance moved ${before - after}`);
    expect(res.byteCount === 10 * MiB, "the item is exactly 10 MiB");
    expect(chunks.length === 2, "two chunks");
    expect(before - after === BigInt(res.winc), "the charge came out of the payer's balance");
    recorded("chunked 2 x 5 MiB", res, data);
  });

  await step("chunked stream upload with paidBy, 5 + 4.5 MiB", async () => {
    const spender = testnet({ signer: createSolanaSigner(crypto.randomBytes(32)) });
    const size = 9.5 * MiB - spender.getDataItemSize({ dataSize: 0, tags: TAGS });
    const price = BigInt((await payer.getUploadCost(spender.getDataItemSize({ dataSize: size, tags: TAGS }))).winc);
    await payer.shareCredits({ approvedAddress: spender.address, approvedWincAmount: (price * 12n) / 10n, expiresBySeconds: 900 });
    const data = crypto.randomBytes(size);
    const pieces = () => Readable.from((function* () { for (let i = 0; i < data.length; i += 256 * 1024) yield data.subarray(i, i + 256 * 1024); })());
    const usedBefore = BigInt((await approvalTo(payer, spender.address))?.usedWincAmount ?? "0");
    const res = await spender.uploadStream({ streamFactory: pieces, size, tags: TAGS, paidBy: payer.address, chunking: "force" });
    const usedAfter = BigInt((await approvalTo(payer, spender.address))?.usedWincAmount ?? "0");
    line("item bytes", `${res.byteCount}, upload ${res.uploadId}`);
    line("charged", `${res.winc} winc; approval used ${usedBefore} -> ${usedAfter}`);
    expect(usedAfter - usedBefore === BigInt(res.winc) && BigInt(res.winc) > 0n, "x-paid-by on finalize charged the payer's approval");
    recorded("chunked stream, paidBy", res, data);
  });

  for (const mib of LARGE_MIB) {
    await step(`chunked upload, ${mib} MiB`, async () => {
      const data = crypto.randomBytes(mib * MiB);
      const t0 = Date.now();
      let chunks = 0;
      try {
        const res = await payer.upload({ data, tags: TAGS, onProgress: () => chunks++ });
        line("uploaded", `${res.byteCount} bytes in ${chunks} chunks, ${((Date.now() - t0) / 1000).toFixed(1)}s, winc ${res.winc}`);
        recorded(`chunked ${mib} MiB`, res, data);
      } catch (err) {
        line("chunks sent", `${chunks} in ${((Date.now() - t0) / 1000).toFixed(1)}s, then ${err.name}: ${err.uploadStatus ?? err.status ?? ""}`);
        if (err instanceof TurboChunkedUploadError) {
          throw new Error(
            `the service did not finalize the ${mib} MiB item: it reported ${err.uploadStatus ?? "no status"} ` +
              `for upload ${err.uploadId} (${err.message}). Not fetched back.`,
          );
        }
        throw err;
      }
    });
  }

  /* ---------------------------- fetch back ---------------------------- */

  await step("fetch every upload back and compare", async () => {
    for (const u of uploads) {
      const t0 = Date.now();
      const back = await fetchBack(u.id, u.data);
      u.compared = back.equal ? "byte-identical" : `NOT CONFIRMED (${back.error})`;
      line(u.label, `${GATEWAY}/raw/${u.id} -> ${u.compared}, ${back.reads} ranged reads, ${back.waits} egress waits, ${Math.round((Date.now() - t0) / 1000)}s`);
      expect(back.equal, `${u.label} came back byte-identical`);
    }
  });

  const lamportsAfter = await connection.getBalance(wallet.publicKey);
  console.log("\nSummary");
  line("SOL spent by this run", `${lamportsBefore - lamportsAfter} lamports (${(lamportsBefore - lamportsAfter) / 1e9} SOL)`);
  for (const u of uploads) line(u.label, `${u.id} ${u.compared ?? "not compared"}`);
  if (failures.length) {
    console.log(`\n${failures.length} step(s) FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nALL STEPS PASSED");
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  process.exit(1);
});
