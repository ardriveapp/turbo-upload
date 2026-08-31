"use strict";
/**
 * arbundles.js — loader shim.
 *
 * `require("@dha-team/arbundles")` THROWS on a clean install: the package index pulls in
 * ./file/index.js -> FileDataItem.js, which `require("axios")`, and axios appears in
 * neither dependencies, peerDependencies nor optionalDependencies of @dha-team/arbundles@1.0.4.
 *
 * Workaround used here: require the individual compiled CJS modules under
 * build/node/cjs/src/ directly, which never touches ./file/. No axios install needed.
 *
 * The package's "./*" export map also rewrites subpaths to "./*.js", so
 * require("@dha-team/arbundles/build/node/cjs/index.js") resolves to "...index.js.js"
 * and fails; we go through an absolute filesystem path instead.
 */
const path = require("node:path");

const ARB_ROOT = process.env.ARBUNDLES_ROOT || path.resolve(
  __dirname, "..", "minimal", "node_modules", "@dha-team", "arbundles", "build", "node", "cjs", "src"
);
const load = (m) => require(path.join(ARB_ROOT, m));

module.exports = {
  ARB_ROOT,
  ArweaveSigner: load("signing/chains/ArweaveSigner.js").default,
  createData: load("ar-data-create.js").createData,
  DataItem: load("DataItem.js").DataItem || load("DataItem.js").default,
  getSignatureData: load("ar-data-base.js").default,
  serializeTags: load("tags.js").serializeTags,
  deserializeTags: load("tags.js").deserializeTags,
  deepHash: load("deepHash.js").deepHash,
  sign: load("ar-data-bundle.js").sign,
};
