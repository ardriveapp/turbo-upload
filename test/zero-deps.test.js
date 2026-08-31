"use strict";
/**
 * The zero-dependency claim, enforced.
 *
 * This is the entire reason the package exists: @ardrive/turbo-sdk pulls 344
 * packages / 892 MB and 3 critical + 9 high advisories into whatever server you
 * add it to, which makes it unmergeable as a storage backend. A property that
 * load-bearing is a test, not a sentence in a README that quietly stops being
 * true when someone adds "just one small helper".
 *
 * Ships with the package, so an integrator can re-prove it from node_modules.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

test("package.json declares no dependencies of any kind", () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "dependencies must be empty");
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), [], "peerDependencies must be empty");
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [], "optionalDependencies must be empty");
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], "devDependencies must be empty");
});

test("no shipped source file requires anything but node: builtins", () => {
  // The allow-list is deliberately tiny. Adding to it is a decision, not a typo.
  const ALLOWED = new Set([
    "node:crypto",
    "node:buffer",
    "node:test",
    "node:assert/strict",
    "node:fs",
    "node:path",
    "node:url",
  ]);

  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "test"));
  files.push(path.join(root, "index.js"));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.endsWith(".json")) continue;
      if (!ALLOWED.has(spec)) offenders.push(`${path.relative(root, file)} -> ${spec}`);
    }
    // A bare `import ... from "pkg"` would dodge the require() scan.
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (spec.startsWith(".") || ALLOWED.has(spec)) continue;
      offenders.push(`${path.relative(root, file)} -> import ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `non-builtin imports found:\n${offenders.join("\n")}`);
  assert.ok(files.length >= 8, `expected to have scanned the source tree, scanned ${files.length} files`);
});

test("there is no node_modules inside the published tree", () => {
  // If this package ever ships with a bundled dependency, the claim is dead.
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false, "a node_modules directory exists in the package root");
});

test("the conformance corpus ships and is the one the tests run against", () => {
  const corpus = path.join(root, "vectors", "vectors.json");
  assert.ok(fs.existsSync(corpus), "vectors/vectors.json must ship with the package");
  assert.ok(pkg.files.includes("vectors/"), "package.json `files` must include vectors/");
  assert.ok(pkg.files.includes("test/"), "package.json `files` must include test/ so an integrator can re-prove conformance");
  const V = require(corpus);
  assert.equal(V.vectors.length, 22);
});

test("no private key ships with the package", () => {
  // The corpus carries only the public modulus; signing tests generate an
  // ephemeral key at runtime. A JWK with a `d` field inside node_modules would
  // trip every secret scanner an integrator runs.
  const suspects = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json") || entry.name.endsWith(".pem") || entry.name.endsWith(".key")) {
        const text = fs.readFileSync(full, "utf8");
        if (/"d"\s*:/.test(text) || /BEGIN [A-Z ]*PRIVATE KEY/.test(text)) {
          suspects.push(path.relative(root, full));
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(suspects, [], `possible private key material in the package tree: ${suspects.join(", ")}`);
});
