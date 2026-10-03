// Which build each bundler picks for `import "@ardrive/turbo-upload"`.
//
// The README states this table; this script is what keeps it true. Each
// bundler builds bundlers/entry.js and the script reads which of the
// package's files ended up in the output.
//
//   esbuild platform=browser   -> web.js
//   esbuild platform=node      -> index.js
//   esbuild platform=neutral   -> fails at build time (node:crypto)
//   webpack 5, target web      -> web.js
//   Vite (production build)    -> web.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import webpack from "webpack";
import { build as viteBuild } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "bundlers", "entry.js");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-upload-bundlers-"));

/** Which build a list of input paths contains. */
function whichBuild(paths) {
  const web = paths.some((p) => /turbo-upload[\\/]web\.js$|(^|[\\/])web\.js$/.test(p) || /src[\\/]web[\\/]client\.js/.test(p));
  const node = paths.some((p) => /src[\\/]client\.js$/.test(p) || /src[\\/]ans104\.js$/.test(p));
  return web && !node ? "web.js" : node && !web ? "index.js" : `both or neither (${paths.length} inputs)`;
}

const results = {};

for (const platform of ["browser", "node", "neutral"]) {
  try {
    const r = await esbuild.build({ entryPoints: [entry], bundle: true, platform, write: false, metafile: true, logLevel: "silent", outdir: out });
    results[`esbuild platform=${platform}`] = whichBuild(Object.keys(r.metafile.inputs));
  } catch (err) {
    const first = (err.errors && err.errors[0] && err.errors[0].text) || err.message;
    results[`esbuild platform=${platform}`] = `fails at build time: ${first}`;
  }
}

results["webpack 5, target web"] = await new Promise((resolve) => {
  webpack({
    mode: "production",
    target: "web",
    entry,
    output: { path: out, filename: "webpack.js" },
    resolve: { symlinks: true },
  }, (err, stats) => {
    if (err) return resolve(`fails: ${err.message}`);
    if (stats.hasErrors()) return resolve(`fails at build time: ${stats.toJson().errors[0].message.split("\n")[0]}`);
    const modules = stats.toJson({ modules: true }).modules.flatMap((m) => [m.name, ...(m.modules || []).map((x) => x.name)]);
    resolve(whichBuild(modules.filter(Boolean)));
  });
});

{
  const seen = [];
  await viteBuild({
    logLevel: "silent",
    configFile: false,
    root: here,
    build: {
      outDir: path.join(out, "vite"),
      write: false,
      rollupOptions: { input: entry },
    },
    plugins: [{ name: "record", load(id) { seen.push(id); return null; } }],
  });
  results["Vite, production build"] = whichBuild(seen);
}

console.log(JSON.stringify(results, null, 2));
const expected = {
  "esbuild platform=browser": "web.js",
  "esbuild platform=node": "index.js",
  "webpack 5, target web": "web.js",
  "Vite, production build": "web.js",
};
const wrong = Object.entries(expected).filter(([k, v]) => results[k] !== v).map(([k]) => k);
if (!String(results["esbuild platform=neutral"]).startsWith("fails at build time")) wrong.push("esbuild platform=neutral");
if (wrong.length) {
  console.error(`FAILED: ${wrong.join(", ")}`);
  process.exit(1);
}
console.error("bundlers OK");
