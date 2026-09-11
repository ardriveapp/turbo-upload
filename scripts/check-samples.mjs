#!/usr/bin/env node
// Every JavaScript block in README.md and AGENTS.md must be runnable as written.
//
// This exists because two of them were not, and reading them did not reveal it.
// `require()` with a top-level `await` is a syntax error in CommonJS; Node then
// retries the file as ESM, where `require` is undefined, so a reader copying the
// block verbatim gets a ReferenceError on line one. The logic was fine, which is
// why running the samples inside a harness passed while the samples themselves
// did not run.
//
// This does not execute them. It checks the module form is coherent, which is
// the part that was wrong and the part a human eye keeps sliding over.
import { readFileSync } from "node:fs";

const FILES = ["README.md", "AGENTS.md"];
let failures = 0;

for (const file of FILES) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const blocks = [...source.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)].map(
    (m, i) => ({ index: i, code: m[1] }),
  );

  for (const { index, code } of blocks) {
    const usesRequire = /\brequire\(/.test(code);
    const usesImport = /^\s*import\s/m.test(code);
    // An await that is not inside an async function or arrow.
    const hasAwait = /\bawait\b/.test(code);
    const wrapped = /async\b/.test(code) || /=>\s*\{/.test(code);
    const topLevelAwait = hasAwait && !wrapped;

    if (usesRequire && topLevelAwait) {
      console.error(
        `${file} block ${index}: require() with a top-level await. ` +
          `Node retries the file as ESM and require is undefined. ` +
          `Use an import, or wrap the await.`,
      );
      failures++;
    }
    if (usesRequire && usesImport) {
      console.error(`${file} block ${index}: mixes require() and import.`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} sample(s) would not run as written.`);
  process.exit(1);
}
console.log("every documented sample is coherent as written");
