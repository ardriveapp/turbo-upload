// Isolation test: reference-signer.js alone, no node_modules anywhere on the resolution
// path, no arbundles, no network. Reproduces every deterministic field in vectors.json.
const crypto = require("node:crypto");
const ref = require("./reference-signer.js");
const V = require("./vectors.json");
const jwk = require("./test-key.json");
const hex = (b) => Buffer.from(b).toString("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
let ok = 0, bad = 0;
const eq = (n, l, a, e) => { if (a === e) ok++; else { bad++; console.log(`  FAIL ${n} :: ${l}`); } };
for (const v of V.vectors) {
  const i = v.input;
  const b = ref.createDataItem({
    data: Buffer.from(i.data_hex, "hex"), tags: i.tags,
    target: i.target_b64url ?? undefined, anchor: i.anchor_utf8 ?? undefined,
    owner: ref.ownerFromJwk(jwk),
  });
  eq(v.name, "unsigned_item_hex", hex(b), v.expected.unsigned_item_hex);
  eq(v.name, "deep_hash_hex", hex(ref.getSignatureData(b)), v.expected.deep_hash_hex);
  eq(v.name, "tag_bytes_hex", hex(ref.parseDataItem(b).rawTags), v.expected.tag_bytes_hex);
  // verify the pinned sample signature with no help from anyone
  const spliced = Buffer.from(v.expected.unsigned_item_hex, "hex");
  spliced.set(Buffer.from(v.sample_signature.signature_hex, "hex"), 2);
  eq(v.name, "sample signature verifies", ref.verifyDataItem(spliced), true);
  eq(v.name, "sample id", hex(sha256(Buffer.from(v.sample_signature.signature_hex, "hex"))), v.sample_signature.id_hex);
  // and round-trip our own signature through our own verifier
  const mine = ref.signDataItem(jwk, {
    data: Buffer.from(i.data_hex, "hex"), tags: i.tags,
    target: i.target_b64url ?? undefined, anchor: i.anchor_utf8 ?? undefined,
  });
  eq(v.name, "self round-trip", ref.verifyDataItem(mine.binary), true);
}
console.log(`isolation: ${ok} passed, ${bad} failed across ${V.vectors.length} vectors`);
process.exit(bad ? 1 : 0);
