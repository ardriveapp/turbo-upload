"use strict";
/**
 * The type 4 corpus: 22 complete signed items produced by @ardrive/turbo-sdk
 * 2.1.0 (conformance/type4-vectors.json), each reproduced byte for byte.
 *
 * Ed25519 is deterministic, so unlike the type 1 corpus this one pins the
 * signature and the id too. Each vector's key is derived from its name by the
 * rule in conformance/type4.js; the seed is stored, nothing else.
 *
 * The corpus lives in conformance/ and does not ship, to keep the tarball
 * small. Run from an installed package, these tests skip and say so; run from
 * a checkout, they run on every Node version CI tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");

const { TurboUpload, verifyDataItem } = require("../index.js");

const CORPUS = path.join(__dirname, "..", "conformance", "type4-vectors.json");
const present = fs.existsSync(CORPUS);
const skip = present ? false : "conformance/type4-vectors.json is not shipped; run from a checkout";
const V = present ? JSON.parse(fs.readFileSync(CORPUS, "utf8")) : { vectors: [] };

const inputOf = (v) => ({
  data: Buffer.from(v.input.data_hex, "hex"),
  tags: v.input.tags,
  target: v.input.target_b64url ?? undefined,
  anchor: v.input.anchor_utf8 ?? undefined,
});

test("the type 4 corpus is the one turbo-sdk 2.1.0 generated", { skip }, () => {
  assert.equal(V.format, "ans104-type4-conformance-vectors");
  assert.equal(V.generated_by, "@ardrive/turbo-sdk@2.1.0");
  assert.equal(V.signature_type.id, 4);
  assert.equal(V.vectors.length, 22);
});

test("type 4, synchronous Node signer: every vector byte-identical to turbo-sdk", { skip }, () => {
  for (const v of V.vectors) {
    const client = new TurboUpload({ jwk: Buffer.from(v.seed_hex, "hex"), token: "solana" });
    assert.equal(client.address, v.public_key_base58, `${v.name}: address`);
    const item = client.sign(inputOf(v));
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, `${v.name}: signed item`);
    assert.equal(item.idB64Url, v.expected.id_b64url, `${v.name}: id`);
    assert.equal(verifyDataItem(item.binary), true, `${v.name}: verifies`);
  }
});

test("type 4, every turbo-sdk item verifies here, and a flipped byte does not", { skip }, () => {
  for (const v of V.vectors) {
    const binary = Buffer.from(v.expected.signed_item_hex, "hex");
    assert.equal(verifyDataItem(binary), true, `${v.name}: turbo-sdk's item verifies`);
    const signature = Buffer.from(binary);
    signature[2] ^= 0x01;
    assert.equal(verifyDataItem(signature), false, `${v.name}: a flipped signature byte is refused`);
    if (v.input.data_hex !== "") {
      const data = Buffer.from(binary);
      data[data.length - 1] ^= 0x01;
      assert.equal(verifyDataItem(data), false, `${v.name}: a flipped data byte is refused`);
    }
  }
});

test("type 4, signAsync with a keypair signer: byte-identical", { skip }, async () => {
  const { createSolanaSigner } = require("../index.js");
  for (const v of V.vectors) {
    const client = new TurboUpload({ signer: createSolanaSigner(Buffer.from(v.seed_hex, "hex")) });
    const item = await client.signAsync(inputOf(v));
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, v.name);
    assert.equal(item.idB64Url, v.expected.id_b64url, v.name);
  }
});

test("type 4, signAsync with a wallet-style signMessage signer: byte-identical", { skip }, async () => {
  // The shape a browser wallet adapter has: a base58 public key and a
  // signMessage that signs whatever bytes it is handed and answers
  // { signature }, as Phantom's injected provider does. Built here on
  // node:crypto, with nothing from this package.
  const crypto = require("node:crypto");
  for (const v of V.vectors) {
    const seed = Buffer.from(v.seed_hex, "hex");
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    let calls = 0;
    const wallet = {
      publicKey: v.public_key_base58,
      signMessage: async (message) => {
        calls++;
        assert.equal(message.length, 96, "the wallet is handed the 96 hex bytes of the deep hash");
        assert.match(Buffer.from(message).toString("utf8"), /^[0-9a-f]{96}$/);
        return { signature: new Uint8Array(crypto.sign(null, Buffer.from(message), privateKey)) };
      },
    };
    const client = new TurboUpload({ signer: wallet });
    const item = await client.signAsync(inputOf(v));
    assert.equal(calls, 1, "one signMessage call per item");
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, v.name);
  }
});
