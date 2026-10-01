// The browser harness.
//
//   node run.mjs              the type 4 corpus in Chromium, Firefox, WebKit and jsdom
//   node run.mjs --devnet     also the live devnet flow from each browser
//
// Builds page.js with esbuild (platform "browser", so the package resolves
// through its `browser` export condition), serves it from 127.0.0.1, and runs
// it in each browser with no polyfills. Results are printed as JSON.
//
// Environment:
//   HARNESS_BROWSERS            comma-separated subset of chromium,firefox,webkit
//   HARNESS_WEBKIT_PLAYWRIGHT   path to another Playwright install to take WebKit
//                               from, for a host the current WebKit build cannot run on
//   TURBO_PAYER_KEY             (devnet) path to a solana-keygen JSON file whose
//                               address holds devnet Turbo credits. Never printed.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { deterministicBytes } from "./data.mjs";
import { fetchBack as fetchBackItem } from "./fetchback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const DEVNET = args.includes("--devnet");
const VECTORS = JSON.parse(fs.readFileSync(path.join(here, "..", "conformance", "type4-vectors.json"), "utf8")).vectors;

/* ------------------------------- build ------------------------------- */

const build = await esbuild.build({
  entryPoints: [path.join(here, "page.js")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(here, "dist", "bundle.js"),
  metafile: true,
  logLevel: "warning",
});
const inputs = Object.keys(build.metafile.inputs);
const fromPackage = inputs.filter((p) => !p.includes("node_modules/@noble") && !p.startsWith("page.js") && !p.startsWith("data.mjs"));
const resolution = {
  webBuild: fromPackage.some((p) => p.endsWith("web.js")),
  nodeBuild: fromPackage.some((p) => /(^|\/)index\.js$/.test(p) || p.endsWith("src/client.js") || p.endsWith("src/ans104.js")),
  packageFiles: fromPackage.length,
};
if (!resolution.webBuild || resolution.nodeBuild) {
  console.error("esbuild did not resolve the web build:", fromPackage);
  process.exit(1);
}

/* ------------------------------- serve ------------------------------- */

const server = http.createServer((req, res) => {
  const file = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
  const full = path.join(here, "dist", path.normalize(file));
  if (!full.startsWith(path.join(here, "dist")) || !fs.existsSync(full)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/javascript" });
  fs.createReadStream(full).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------ browsers ----------------------------- */

const playwright = await import("playwright");
const wanted = (process.env.HARNESS_BROWSERS || "chromium,firefox,webkit").split(",");
const browserTypes = {
  chromium: playwright.chromium,
  firefox: playwright.firefox,
  webkit: process.env.HARNESS_WEBKIT_PLAYWRIGHT
    ? require(path.resolve(process.env.HARNESS_WEBKIT_PLAYWRIGHT)).webkit
    : playwright.webkit,
};

function devnetParams() {
  const keyFile = process.env.TURBO_PAYER_KEY;
  if (!keyFile) throw new Error("--devnet needs TURBO_PAYER_KEY: a solana-keygen JSON file with devnet Turbo credits");
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8")));
  const run = crypto.randomBytes(4).toString("hex");
  return {
    payerSeedHex: Buffer.from(secret.subarray(0, 32)).toString("hex"),
    freeSeedHex: crypto.randomBytes(32).toString("hex"),
    freeDataSeed: `free-${run}`,
    freeBytes: 64 * 1024,
    spenderSeedHex: crypto.randomBytes(32).toString("hex"),
    paidDataSeed: `paid-${run}`,
    paidBytes: 5 * 1024 * 1024 + 256 * 1024,
    chunkDataSeed: `chunk-${run}`,
    streamDataSeed: `stream-${run}`,
    spender2SeedHex: crypto.randomBytes(32).toString("hex"),
    largeMiB: [],
    run,
  };
}

const report = { resolution, browsers: {}, jsdom: null, devnet: {} };

for (const name of wanted) {
  const type = browserTypes[name];
  let browser;
  try {
    browser = await type.launch();
  } catch (err) {
    report.browsers[name] = { error: `could not launch: ${err.message.split("\n")[0]}` };
    continue;
  }
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(origin + "/");
  const result = await page.evaluate((v) => globalThis.harness.corpus(v), VECTORS);
  report.browsers[name] = { version: browser.version(), ...result, pageErrors: consoleErrors };
  if (DEVNET) {
    const params = devnetParams();
    // The large chunked uploads run from one browser: each is hundreds of MiB
    // of upload for an outcome devnet decides the same way whatever sends it.
    if (name === (process.env.HARNESS_LARGE_BROWSER || "chromium")) {
      params.largeMiB = (process.env.HARNESS_LARGE_MIB || "50,200").split(",").filter(Boolean).map(Number);
    }
    report.devnet[name] = await page.evaluate((p) => globalThis.harness.devnet(p), params);
  }
  await browser.close();
}

/* -------------------------------- jsdom ------------------------------ */

{
  const bundle = fs.readFileSync(path.join(here, "dist", "bundle.js"), "utf8");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: origin + "/" });
  dom.window.eval(bundle);
  const result = await dom.window.harness.corpus(VECTORS);
  report.jsdom = { jsdom: require("jsdom/package.json").version, ...result };
  dom.window.close();
}

server.close();

/* ------------------------------- devnet ------------------------------ */

// Written before the fetch-back pass, so a crash there loses nothing.
fs.mkdirSync(path.join(here, "results"), { recursive: true });
const resultFile = path.join(here, "results", `run-${Date.now()}.json`);
fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));

if (DEVNET) {
  for (const [name, r] of Object.entries(report.devnet)) {
    for (const u of r.uploads) {
      u.fetchedBack = await fetchBack(u);
    }
  }
}

async function fetchBack(u) {
  return fetchBackItem(u.id, deterministicBytes(u.seed, u.bytes), { log: (m) => console.error(m) });
}

console.log(JSON.stringify(report, null, 2));
const corpusOk = (r) => r && !r.error && r.signedIdentical === VECTORS.length && r.sdkItemsVerified === VECTORS.length &&
  r.tamperRejected === VECTORS.length && r.typeofBuffer === "undefined" && r.mismatches.length === 0;
const failed = [
  ...wanted.filter((n) => !corpusOk(report.browsers[n])).map((n) => `corpus in ${n}`),
  ...(corpusOk(report.jsdom) ? [] : ["corpus in jsdom"]),
  ...(DEVNET ? Object.entries(report.devnet).flatMap(([n, r]) => [
    ...r.log.filter((s) => !s.ok).map((s) => `${n}: ${s.step}`),
    ...r.uploads.filter((u) => !u.fetchedBack?.byteEqual).map((u) => `${n}: fetch back ${u.label}`),
  ]) : []),
];
if (failed.length) {
  console.error(`FAILED: ${failed.join("; ")}`);
  process.exit(1);
}
console.error(`harness OK: corpus in ${wanted.join(", ")} and jsdom${DEVNET ? "; devnet flow in each" : ""}`);
