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
    // test/web.test.js only: it loads the web build in a fresh realm with no
    // Buffer and no process, which is what node:vm is for.
    "node:vm",
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
  files.push(path.join(root, "web.js"));

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

/** Remove comments, so a scan does not trip on prose. */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Also blank string literals: a message that says "pass a Buffer" is not a use of Buffer. */
function codeOnly(src) {
  return withoutComments(src)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/** Every non-relative require or import in a file, comments excluded. */
function externalSpecifiers(src) {
  const code = withoutComments(src);
  const specs = [];
  for (const m of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  for (const m of code.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs.filter((s) => !s.startsWith("."));
}

test("src/core uses no node: module, no Buffer and no process", () => {
  // The core is what the web build runs. A `node:` import there breaks every
  // browser bundler at build time, and a stray Buffer or process breaks at run
  // time in a page with no polyfills, which is the failure that ships.
  const dir = path.join(root, "src", "core");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 4, `expected the core files, found ${files.length}`);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const spec of externalSpecifiers(src)) offenders.push(`${f} requires ${spec}`);
    const code = codeOnly(src);
    if (/\bBuffer\b/.test(code)) offenders.push(`${f} uses Buffer`);
    if (/\bprocess\b/.test(code)) offenders.push(`${f} uses process`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("nothing reachable from web.js uses a node: module, Buffer or process", () => {
  // Walk the require graph from the web entry point, the way a bundler does.
  // Everything it reaches ships to a browser, so everything it reaches is held
  // to the core's rule, not only the files that happen to live in src/core.
  const seen = new Set();
  const offenders = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const spec of externalSpecifiers(src)) offenders.push(`${path.relative(root, file)} requires ${spec}`);
    const code = codeOnly(src);
    if (/\bBuffer\b/.test(code)) offenders.push(`${path.relative(root, file)} uses Buffer`);
    if (/\bprocess\b/.test(code)) offenders.push(`${path.relative(root, file)} uses process`);
    for (const m of withoutComments(src).matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      visit(path.resolve(path.dirname(file), m[1].endsWith(".js") ? m[1] : `${m[1]}.js`));
    }
  };
  visit(path.join(root, "web.js"));
  assert.ok(seen.size >= 8, `expected to walk the web graph, reached ${seen.size} files`);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
