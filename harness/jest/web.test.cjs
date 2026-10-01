/**
 * The web build under Jest's jsdom environment: resolved through the browser
 * condition, signing the type 4 corpus byte for byte with a wallet-style
 * signer. The wallet is built on node:crypto, which test code may use; the
 * package under test never sees it.
 */
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs");
const turbo = require("@ardrive/turbo-upload");

const V = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "conformance", "type4-vectors.json"), "utf8"));

function wallet(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const pub = crypto.createPublicKey(privateKey);
  return {
    publicKey: new Uint8Array(Buffer.from(publicKey.x, "base64url")),
    signMessage: async (m) => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)),
    verify: (m, s) => crypto.verify(null, Buffer.from(m), pub, Buffer.from(s)),
  };
}

test("the browser condition resolves the web build under jest-environment-jsdom", () => {
  expect(require.resolve("@ardrive/turbo-upload")).toMatch(/[\\/]web\.js$/);
  expect(typeof turbo.TurboUpload.prototype.signAsync).toBe("function");
  expect(turbo.signMessage).toBeUndefined(); // an RSA export of the Node build only
});

test("the type 4 corpus, byte-identical to turbo-sdk, under jsdom", async () => {
  for (const v of V.vectors) {
    const client = turbo.TurboUpload.testnet({ signer: wallet(v.seed_hex) });
    const item = await client.signAsync({
      data: new Uint8Array(Buffer.from(v.input.data_hex, "hex")),
      tags: v.input.tags,
      target: v.input.target_b64url ?? undefined,
      anchor: v.input.anchor_utf8 ?? undefined,
    });
    expect(Buffer.from(item.binary).toString("hex")).toBe(v.expected.signed_item_hex);
    expect(item.idB64Url).toBe(v.expected.id_b64url);
  }
});
