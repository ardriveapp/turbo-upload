"use strict";
/**
 * The service contract behind the Solana support, asked of the testnet
 * services directly, with raw requests. live-solana-devnet.js proves the
 * client works; this records what the SERVICE does, so a change on its side
 * shows up as a changed answer here rather than as a client bug.
 *
 *   npm ci --prefix scripts
 *   node scripts/probe-solana-devnet.js --key wallet.json --payer-key payer.json
 *
 * --key holds devnet SOL (one small version 0 top-up, 0.002 SOL by default,
 * --topup to change); --payer-key holds testnet Turbo credits (one paid
 * upload of about 5.5 MiB). Neither is printed. Every request goes through the
 * same devnet-only fetch guard as live-solana-devnet.js.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { TurboUpload, TESTNET } = require("..");

const DEVNET_HOSTS = new Set(["upload.services.ar-io.dev", "payment.services.ar-io.dev", "ar-io.dev", "api.devnet.solana.com"]);
const realFetch = globalThis.fetch;
const guardedFetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (!DEVNET_HOSTS.has(host)) return Promise.reject(new Error(`REFUSING: ${host} is not a devnet host`));
  return realFetch(input, init);
};
globalThis.fetch = guardedFetch;

const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
if (!arg("--key") || !arg("--payer-key")) {
  console.error("Pass --key <devnet SOL key file> and --payer-key <key file holding testnet credits>.");
  process.exit(2);
}
const readKey = (p) => Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")));
const TOPUP = Number(arg("--topup", "2000000"));
const U = `${TESTNET.uploadUrl}/v1`;
const P = `${TESTNET.paymentUrl}/v1`;
const MiB = 1024 * 1024;

async function raw(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body, text };
}
const post = (url, bytes, headers = {}) => raw(url, { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream", ...headers } });

const answers = [];
async function ask(question, fn) {
  try {
    const answer = await fn();
    answers.push([question, answer]);
    console.log(`\n${question}\n    ${answer}`);
  } catch (err) {
    answers.push([question, `PROBE FAILED: ${err.message}`]);
    console.log(`\n${question}\n    PROBE FAILED: ${err.name}: ${err.message}`);
  }
}

(async () => {
  const web3 = require("@solana/web3.js");
  const connection = new web3.Connection("https://api.devnet.solana.com", { commitment: "confirmed", fetch: guardedFetch });
  const wallet = web3.Keypair.fromSecretKey(readKey(arg("--key")));
  const payer = TurboUpload.testnet({ jwk: readKey(arg("--payer-key")), token: "solana" });
  const fresh = () => TurboUpload.testnet({ jwk: crypto.randomBytes(32), token: "solana" });
  const lamportsBefore = await connection.getBalance(wallet.publicKey);

  await ask("Do /v1/tx and /v1/tx/solana accept the same type 4 item?", async () => {
    const c = fresh();
    const out = [];
    for (const route of ["/tx", "/tx/solana"]) {
      const item = c.sign({ data: crypto.randomBytes(300) });
      const r = await post(U + route, item.binary);
      out.push(`${route}: ${r.status}${r.body.id === item.idB64Url ? ", id matches" : ""}`);
    }
    return out.join("; ");
  });

  await ask("What is the single-item limit, and how is it refused?", async () => {
    const c = fresh();
    const overhead = c.getDataItemSize({ dataSize: 0 });
    const item = c.sign({ data: crypto.randomBytes(10 * MiB - overhead + 1) });
    const r = await post(`${U}/tx/solana`, item.binary);
    return `a ${item.binary.length}-byte item: HTTP ${r.status}, ${JSON.stringify(r.text.slice(0, 120))}`;
  });

  await ask("Does the multipart route take an item over that limit?", async () => {
    const c = fresh();
    const init = (await raw(`${U}/chunks/solana/-1/-1?chunkSize=${5 * MiB}`, { headers: { "x-chunking-version": "2" } })).body;
    const overhead = c.getDataItemSize({ dataSize: 0 });
    const item = c.sign({ data: crypto.randomBytes(10 * MiB - overhead + 1) });
    for (let off = 0; off < item.binary.length; off += init.chunkSize) {
      await post(`${U}/chunks/solana/${init.id}/${off}`, item.binary.subarray(off, off + init.chunkSize), { "x-chunking-version": "2" });
    }
    const early = await raw(`${U}/chunks/solana/${init.id}/status`);
    await post(`${U}/chunks/solana/${init.id}/finalize`, new Uint8Array(0), { "x-chunking-version": "2" });
    let st;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      st = await raw(`${U}/chunks/solana/${init.id}/status`);
      if (st.body && /FINALIZED|INVALID|UNDERFUNDED/.test(st.body.status)) break;
    }
    return `status before finalize: HTTP ${early.status}; a ${item.binary.length}-byte item from an unfunded signer in ` +
      `${Math.ceil(item.binary.length / init.chunkSize)} chunks finalized as ${st.body.status} ` +
      "(an item at or under the limit from the same kind of signer answers UNDERFUNDED)";
  });

  await ask("Whose free quota does an upload draw: the signer's or the payer's?", async () => {
    const signer = fresh();
    const q = async (a) => (await payer.getFreeQuota({ address: a })).bytesRemaining;
    const [s0, p0] = [await q(signer.address), await q(payer.address)];
    const item = signer.sign({ data: crypto.randomBytes(64 * 1024) });
    await post(`${U}/tx/solana`, item.binary);
    const [s1, p1] = [await q(signer.address), await q(payer.address)];
    return `fresh signer ${s0} -> ${s1} (an item of ${item.binary.length} bytes); payer ${p0} -> ${p1}`;
  });

  await ask("Does x-paid-by take a list?", async () => {
    const spender = fresh();
    const size = 5 * MiB + 256 * 1024;
    const price = BigInt((await payer.getUploadCost(spender.getDataItemSize({ dataSize: size }))).winc);
    await payer.shareCredits({ approvedAddress: spender.address, approvedWincAmount: (price * 12n) / 10n, expiresBySeconds: 600 });
    const other = fresh().address;
    const out = [];
    for (const [label, header] of [["payer,other", `${payer.address},${other}`], ["other,payer", `${other},${payer.address}`], ["payer", payer.address]]) {
      const item = spender.sign({ data: crypto.randomBytes(size) });
      const r = await post(`${U}/tx/solana`, item.binary, { "x-paid-by": header });
      out.push(`${label}: ${r.status}`);
    }
    return out.join("; ");
  });

  await ask("Is a version 0 SOL transfer with the memo credited, and is a second submission idempotent?", async () => {
    const funding = new web3.PublicKey((await raw(`${P}/info`)).body.addresses.solana);
    const bh = await connection.getLatestBlockhash("finalized");
    const memo = new web3.TransactionInstruction({
      programId: new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [],
      data: Buffer.from(`turboCreditDestinationAddress=${payer.address}`),
    });
    const message = new web3.TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: funding, lamports: TOPUP }), memo],
    }).compileToV0Message();
    const tx = new web3.VersionedTransaction(message);
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx);
    const early = await raw(`${P}/account/balance/solana`, { method: "POST", body: new TextEncoder().encode(JSON.stringify({ tx_id: sig })) });
    await connection.confirmTransaction({ signature: sig, ...bh }, "finalized");
    const body = new TextEncoder().encode(JSON.stringify({ tx_id: sig }));
    let first;
    for (let i = 0; i < 10; i++) {
      first = await raw(`${P}/account/balance/solana`, { method: "POST", body });
      if (first.status === 200) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const second = await raw(`${P}/account/balance/solana`, { method: "POST", body });
    const textPlain = await raw(`${P}/account/balance/solana`, { method: "POST", body: JSON.stringify({ tx_id: sig }), headers: { "content-type": "text/plain" } });
    return `before finalized: HTTP ${early.status}; after: HTTP ${first.status} ${Object.keys(first.body || {})[0]}; ` +
      `again: HTTP ${second.status} ${JSON.stringify(second.text.slice(0, 80))}; as text/plain: HTTP ${textPlain.status}`;
  });

  await ask("Does testnet answer a checkout request with a Stripe test-mode session?", async () => {
    const r = await raw(`${P}/top-up/checkout-session/${payer.address}/usd/1000?token=solana&uiMode=hosted`);
    const s = r.body.paymentSession || {};
    return `HTTP ${r.status}; id ${String(s.id).slice(0, 8)}...; livemode ${s.livemode}`;
  });

  await ask("Does a browser's preflight for an upload with x-paid-by pass?", async () => {
    const r = await raw(`${U}/tx`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-paid-by" },
    });
    return `HTTP ${r.status}; allow-origin ${r.headers.get("access-control-allow-origin")}; allow-headers ${r.headers.get("access-control-allow-headers")}`;
  });

  const lamportsAfter = await connection.getBalance(wallet.publicKey);
  console.log(`\nSOL spent by this probe: ${lamportsBefore - lamportsAfter} lamports`);
  process.exit(answers.some(([, a]) => a.startsWith("PROBE FAILED")) ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
