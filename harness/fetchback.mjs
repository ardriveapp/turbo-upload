// Fetch an item back from the testnet gateway and compare it byte for byte.
//
// The gateway gives each client a byte budget for reads: its /ar-io/info
// (rateLimiter.dataEgress) reports 102,400,000 bytes, refilling at 20,480
// bytes a second, and once it is spent a read answers 402 with an x402
// payment offer. A budget, not a size limit. So the item is read in 1 MiB
// ranges, and a 402 or 429 waits for the bucket rather than failing the
// comparison. Nothing is paid.
//
//   node fetchback.mjs results/run-<n>.json      re-check a harness run's uploads
import fs from "node:fs";
import { deterministicBytes, DEVNET_HOSTS } from "./data.mjs";

const PIECE = 1024 * 1024;

export async function fetchBack(id, expected, { gateway = "https://ar-io.dev", maxWaitMs = 2 * 60 * 60 * 1000, log = () => {} } = {}) {
  const url = `${gateway}/raw/${id}`;
  if (!DEVNET_HOSTS.includes(new URL(url).hostname)) throw new Error(`refused: ${url}`);
  const t0 = Date.now();
  const got = new Uint8Array(expected.length);
  let pos = 0;
  let waits = 0;
  while (pos < expected.length) {
    if (Date.now() - t0 > maxWaitMs) return { url, byteEqual: false, error: `gave up after ${Math.round((Date.now() - t0) / 1000)}s at byte ${pos}` };
    const end = Math.min(pos + PIECE, expected.length) - 1;
    let res;
    try {
      res = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
    } catch (err) {
      log(`  ${id}: ${err.message}, retrying`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (res.status === 402 || res.status === 429 || res.status === 404) {
      // 404: not indexed yet. 402/429: the egress bucket is empty.
      await res.arrayBuffer().catch(() => {});
      waits++;
      if (waits % 6 === 1) log(`  ${id}: HTTP ${res.status} at byte ${pos}, waiting`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    if (res.status !== 206 && res.status !== 200) {
      return { url, byteEqual: false, error: `HTTP ${res.status} at byte ${pos}` };
    }
    let body;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      log(`  ${id}: body cut off (${err.message}), retrying`);
      continue;
    }
    if (res.status === 200) {
      // The gateway ignored the range and sent everything.
      return { url, status: 200, bytes: body.length, byteEqual: equal(body, expected), afterSeconds: Math.round((Date.now() - t0) / 1000) };
    }
    got.set(body.subarray(0, end - pos + 1), pos);
    pos = end + 1;
  }
  return { url, status: 206, bytes: got.length, byteEqual: equal(got, expected), rangedReads: Math.ceil(expected.length / PIECE), waitedForEgress: waits, afterSeconds: Math.round((Date.now() - t0) / 1000) };
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

if (process.argv[1] && process.argv[1].endsWith("fetchback.mjs")) {
  const file = process.argv[2];
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [browser, r] of Object.entries(report.devnet)) {
    for (const u of r.uploads) {
      if (u.fetchedBack && u.fetchedBack.byteEqual) continue;
      u.fetchedBack = await fetchBack(u.id, deterministicBytes(u.seed, u.bytes), { log: console.error });
      console.error(`${browser} ${u.label} ${u.id}: ${u.fetchedBack.byteEqual ? "byte-identical" : `NOT CONFIRMED (${u.fetchedBack.error})`}`);
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
    }
  }
  const all = Object.values(report.devnet).flatMap((r) => r.uploads);
  const ok = all.filter((u) => u.fetchedBack && u.fetchedBack.byteEqual).length;
  console.log(`fetch back: ${ok}/${all.length} uploads byte-identical`);
  process.exit(ok === all.length ? 0 : 1);
}
