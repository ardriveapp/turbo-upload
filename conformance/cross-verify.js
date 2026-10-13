"use strict";
/**
 * cross-verify.js, the package against the reference verifier, both ways, for
 * all three signature types, plus tamper rejection.
 *
 *   node cross-verify.js
 *
 * verify.js proves the zero-dependency REFERENCE signer agrees with arbundles.
 * This proves the PACKAGE does, through its public exports:
 *
 *   1. an item the package signs verifies under arbundles' DataItem.verify,
 *      which is the verifier turbo-sdk and the bundlers run;
 *   2. an item arbundles signs (type 1), or turbo-sdk signed (types 3 and 4,
 *      the committed corpora), verifies under the package;
 *   3. flipping one byte in the data, the tags or the signature is rejected by
 *      BOTH verifiers. Agreement on valid items is half the job; a verifier
 *      that accepts everything agrees too.
 *
 * Type 3 also goes through ethers' and viem's verifyMessage, the malleable
 * cases (a high s, a flipped v, v written as 0 or 1) where the package's
 * default and strict modes are held against arbundles, and signers that
 * misbehave with a real key, each of which must fail before anything is sent.
 *
 * Exits non-zero on any failure.
 */
const { Buffer } = require("node:buffer");
const arb = require("./arbundles.js");
const cases = require("./cases.js");
const type4 = require("./type4-vectors.json");
const type3 = require("./type3-vectors.json");
const crypto = require("node:crypto");
const ethers = require("ethers");
const { privateKeyToAccount } = require("viem/accounts");
const { recoverPublicKey, verifyMessage: viemVerifyMessage } = require("viem");
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

  // ------------------------------ type 3 ------------------------------
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const ours3 = (binary, opts = {}) => pkg.verifyDataItem(binary, { recoverPublicKey, ...opts });
  const keyFor = (name) => `0x${crypto.createHash("sha256").update(`turbo-upload type 3 corpus/${name}`).digest("hex")}`;
  const evmClient = (signer, fetch) => new pkg.TurboUpload({ signer: { recoverPublicKey, ...signer }, token: "base-eth", fetch });

  async function bothReject3(label, binary) {
    const owner = Buffer.from(binary);
    owner[2 + 65 + 40] ^= 0x01;
    for (const [region, tampered] of [...tamperings(binary), ["owner", owner]]) {
      check(`${label} tampered ${region}: package rejects`, await ours3(tampered), false);
      check(`${label} tampered ${region}: arbundles rejects`, await arbVerify(tampered), false);
    }
    const s = BigInt(`0x${binary.subarray(34, 66).toString("hex")}`);
    const highS = Buffer.from(binary);
    Buffer.from((N - s).toString(16).padStart(64, "0"), "hex").copy(highS, 34);
    highS[66] = highS[66] === 27 ? 28 : 27;
    check(`${label} high s: package rejects`, await ours3(highS), false);
    check(`${label} high s: arbundles rejects`, await arbVerify(highS), false);
    const flipped = Buffer.from(binary);
    flipped[66] = flipped[66] === 27 ? 28 : 27;
    check(`${label} flipped v: arbundles accepts`, await arbVerify(flipped), true);
    check(`${label} flipped v: package accepts by default`, await ours3(flipped), true);
    check(`${label} flipped v: package refuses with strictV`, await ours3(flipped, { strictV: true }), false);
    const zeroOne = Buffer.from(binary);
    zeroOne[66] -= 27;
    check(`${label} v as ${zeroOne[66]}: arbundles accepts`, await arbVerify(zeroOne), true);
    check(`${label} v as ${zeroOne[66]}: package accepts by default`, await ours3(zeroOne), true);
    check(`${label} v as ${zeroOne[66]}: package refuses with strictV`, await ours3(zeroOne, { strictV: true }), false);
    const anyV = Buffer.from(binary);
    anyV[66] = 0xc7;
    check(`${label} v as 199: arbundles accepts`, await arbVerify(anyV), true);
    check(`${label} v as 199: package accepts by default`, await ours3(anyV), true);
    check(`${label} v as 199: package refuses with strictV`, await ours3(anyV, { strictV: true }), false);
  }

  for (const v of type3.vectors) {
    const sdkSigned = Buffer.from(v.expected.signed_item_hex, "hex");
    check(`type3 ${v.name}: turbo-sdk -> package`, await ours3(sdkSigned), true);
    check(`type3 ${v.name}: turbo-sdk -> package, strictV`, await ours3(sdkSigned, { strictV: true }), true);
    check(`type3 ${v.name}: turbo-sdk -> arbundles`, await arbVerify(sdkSigned), true);
    await bothReject3(`type3 ${v.name} (turbo-sdk-signed)`, sdkSigned);

    const account = privateKeyToAccount(keyFor(v.name));
    const ours = await evmClient(account).signAsync({
      data: Buffer.from(v.input.data_hex, "hex"),
      tags: v.input.tags,
      target: v.input.target_b64url ?? undefined,
      anchor: v.input.anchor_utf8 ?? undefined,
    });
    const binary = Buffer.from(ours.binary);
    check(`type3 ${v.name}: package -> arbundles`, await arbVerify(binary), true);
    check(`type3 ${v.name}: package -> ethers verifyMessage`, ethers.verifyMessage(ours.signatureData, `0x${ours.signature.toString("hex")}`), account.address);
    check(`type3 ${v.name}: package -> viem verifyMessage`,
      await viemVerifyMessage({ address: account.address, message: { raw: ours.signatureData }, signature: `0x${ours.signature.toString("hex")}` }), true);
    await bothReject3(`type3 ${v.name} (package-signed)`, binary);
  }

  // Signers that misbehave, with a real key: each must throw TurboSignerError
  // before a request is made. And one that writes v as 0 or 1, which is
  // normalised into an item arbundles accepts.
  const account = privateKeyToAccount(keyFor("misbehaving signers"));
  const sign = (raw) => account.signMessage({ message: { raw } });
  const malleate = (hex) => {
    const sig = Buffer.from(hex.slice(2), "hex");
    const s = BigInt(`0x${sig.subarray(32, 64).toString("hex")}`);
    Buffer.from((N - s).toString(16).padStart(64, "0"), "hex").copy(sig, 32);
    sig[64] = sig[64] === 27 ? 28 : 27;
    return `0x${sig.toString("hex")}`;
  };
  const misbehaving = [
    ["signs the hex text of the deep hash", async ({ message }) => sign(Buffer.from(Buffer.from(message.raw).toString("hex")))],
    ["signs the deep hash decoded as text", async ({ message }) => account.signMessage({ message: Buffer.from(message.raw).toString("latin1") })],
    ["answers with high s", async ({ message }) => malleate(await sign(message.raw))],
    ["answers with 97 bytes", async ({ message }) => `${await sign(message.raw)}${"00".repeat(32)}`],
    ["answers with 64 bytes", async ({ message }) => (await sign(message.raw)).slice(0, 130)],
    ["signs with another key", async ({ message }) => privateKeyToAccount(keyFor("another key")).signMessage({ message: { raw: message.raw } })],
  ];
  for (const [label, signMessage] of misbehaving) {
    let requests = 0;
    const fetch = async () => {
      requests++;
      throw new Error("no request may be made");
    };
    let threw;
    try {
      await evmClient({ address: account.address, publicKey: account.publicKey, signMessage }, fetch).upload({ data: "x" });
    } catch (err) {
      threw = err;
    }
    check(`type3 signer that ${label}: TurboSignerError`, threw instanceof pkg.TurboSignerError, true);
    check(`type3 signer that ${label}: no request made`, requests, 0);
  }
  const zeroOne = await evmClient({
    address: account.address,
    signMessage: async (args) => {
      const sig = Buffer.from((await account.signMessage(args)).slice(2), "hex");
      sig[64] -= 27;
      return sig;
    },
  }).signAsync({ data: "v as 0 or 1" });
  check("type3 signer that writes v as 0 or 1: v normalised", [27, 28].includes(zeroOne.signature[64]), true);
  check("type3 signer that writes v as 0 or 1: arbundles accepts", await arbVerify(Buffer.from(zeroOne.binary)), true);
  check("type3 signer that writes v as 0 or 1: strictV accepts", await ours3(Buffer.from(zeroOne.binary), { strictV: true }), true);

  console.log(`cross-verification: ${pass} passed, ${failures.length} failed ` +
    `(${cases.length} type 1 cases, ${type3.vectors.length} type 3 and ${type4.vectors.length} type 4 vectors, ` +
    `tamper in data, tags and signature, type 3 owner and malleability, ${misbehaving.length + 1} type 3 signers)`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
