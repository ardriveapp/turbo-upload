"use strict";
/**
 * cross-verify.js, the package against the reference verifier, both ways, for
 * both signature types, plus tamper rejection.
 *
 *   node cross-verify.js
 *
 * verify.js proves the zero-dependency REFERENCE signer agrees with arbundles.
 * This proves the PACKAGE does, through its public exports:
 *
 *   1. an item the package signs verifies under arbundles' DataItem.verify,
 *      which is the verifier turbo-sdk and the bundlers run;
 *   2. an item arbundles signs (type 1), or turbo-sdk signed (type 4, the
 *      committed corpus), verifies under the package;
 *   3. flipping one byte in the data, the tags or the signature is rejected by
 *      BOTH verifiers. Agreement on valid items is half the job; a verifier
 *      that accepts everything agrees too.
 *
 * Exits non-zero on any failure.
 */
const { Buffer } = require("node:buffer");
const arb = require("./arbundles.js");
const cases = require("./cases.js");
const type4 = require("./type4-vectors.json");
const { loadKey } = require("./key.js");
const pkg = require("..");

/**
 * arbundles' verifier, with two of its habits normalised: it THROWS, rather
 * than returning false, on a type 4 signature whose R point is not on the
 * curve (one flipped byte is enough), and arweave-js prints a warning for
 * every failed RSA check. A throw is a rejection; the warnings are noise here.
 */
async function arbVerify(binary) {
  const saved = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  try {
    return await arb.DataItem.verify(binary);
  } catch {
    return false;
  } finally {
    [console.log, console.warn, console.error] = saved;
  }
}
const jwk = loadKey();
const arbSigner = new arb.ArweaveSigner(jwk);

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) pass++;
  else failures.push(`${label}: got ${actual}, expected ${expected}`);
};

/** The three regions a tamper test flips one byte in. */
function tamperings(binary) {
  const it = pkg.parseDataItem(binary);
  const out = [];
  const flip = (label, offset) => {
    const copy = Buffer.from(binary);
    copy[offset] ^= 0x01;
    out.push([label, copy]);
  };
  flip("signature", it.offsets.sigStart + 7);
  if (it.rawTags.length > 0) {
    // A byte inside a tag string, not a length varint, so the item still parses
    // and the rejection comes from the signature check.
    flip("tags", it.offsets.tagsStart + 16 + it.rawTags.length - 2);
  }
  if (it.rawData.length > 0) flip("data", it.offsets.dataStart + Math.floor(it.rawData.length / 2));
  return out;
}

async function bothReject(label, binary) {
  for (const [region, tampered] of tamperings(binary)) {
    check(`${label} tampered ${region}: package rejects`, pkg.verifyDataItem(tampered), false);
    check(`${label} tampered ${region}: arbundles rejects`, await arbVerify(tampered), false);
  }
}

(async () => {
  // ------------------------------ type 1 ------------------------------
  const client = new pkg.TurboUpload({ jwk });
  for (const c of cases) {
    const opts = { data: c.data, tags: c.tags, target: c.target, anchor: c.anchor };

    const ours = client.sign(opts);
    check(`type1 ${c.name}: package -> arbundles`, await arbVerify(Buffer.from(ours.binary)), true);
    await bothReject(`type1 ${c.name} (package-signed)`, ours.binary);

    const arbOpts = {};
    if (c.tags.length) arbOpts.tags = c.tags;
    if (c.target) arbOpts.target = c.target;
    if (c.anchor) arbOpts.anchor = c.anchor;
    const theirs = arb.createData(c.data, arbSigner, arbOpts);
    await arb.sign(theirs, arbSigner);
    const theirBinary = Buffer.from(theirs.getRaw());
    check(`type1 ${c.name}: arbundles -> package`, pkg.verifyDataItem(theirBinary), true);
    check(`type1 ${c.name}: arbundles -> package, strict salt`, pkg.verifyDataItem(theirBinary, { strictSaltLength: true }), true);
    await bothReject(`type1 ${c.name} (arbundles-signed)`, theirBinary);
  }

  // ------------------------------ type 4 ------------------------------
  for (const v of type4.vectors) {
    const sdkSigned = Buffer.from(v.expected.signed_item_hex, "hex");
    check(`type4 ${v.name}: turbo-sdk -> package`, pkg.verifyDataItem(sdkSigned), true);
    check(`type4 ${v.name}: turbo-sdk -> arbundles`, await arbVerify(sdkSigned), true);
    await bothReject(`type4 ${v.name} (turbo-sdk-signed)`, sdkSigned);

    const c = new pkg.TurboUpload({ jwk: Buffer.from(v.seed_hex, "hex"), token: "solana" });
    const ours = c.sign({
      data: Buffer.from(v.input.data_hex, "hex"),
      tags: v.input.tags,
      target: v.input.target_b64url ?? undefined,
      anchor: v.input.anchor_utf8 ?? undefined,
    });
    check(`type4 ${v.name}: package -> arbundles`, await arbVerify(Buffer.from(ours.binary)), true);
    await bothReject(`type4 ${v.name} (package-signed)`, ours.binary);
  }

  console.log(`cross-verification: ${pass} passed, ${failures.length} failed ` +
    `(${cases.length} type 1 cases, ${type4.vectors.length} type 4 vectors, tamper in data, tags and signature)`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
