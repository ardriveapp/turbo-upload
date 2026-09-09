"use strict";
/**
 * Signing behaviour, including THE assertion this package exists to guarantee:
 * the PSS salt length recovered off the wire is 478, not 32.
 *
 * The key is generated at runtime. No private key ships in this package, the
 * conformance corpus carries only the public modulus, and a 4096-bit keygen
 * costs a second or two, which is cheaper than shipping a private key that
 * every secret scanner in the world will flag inside node_modules.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const ans104 = require("../src/ans104.js");

/** One ephemeral RSA-4096 key for the whole file. */
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
const JWK = privateKey.export({ format: "jwk" });
const OWNER = ans104.ownerFromJwk(JWK);
const PUB = ans104.publicKeyFromOwner(OWNER);

/**
 * Recover the PSS salt length from a signature, by hand.
 *
 * Compute sig^e mod n with NO padding removal to get the encoded message, take
 * H from the tail, unmask the DB with MGF1-SHA256, then find the 0x01 separator:
 * everything after it is the salt.
 *
 * This exists because you cannot trust the flag. Node's RSA_PSS_SALTLEN_MAX_SIGN
 * and RSA_PSS_SALTLEN_AUTO are both literally -2, and verification accepts any
 * salt length, so nothing else in a normal test suite can tell 478 from 32.
 */
function recoverSaltLength(signature) {
  const em = crypto.publicDecrypt({ key: PUB, padding: crypto.constants.RSA_NO_PADDING }, signature);
  const hLen = 32;
  const emLen = em.length;
  const emBits = 4095; // modBits - 1
  const H = em.subarray(emLen - hLen - 1, emLen - 1);
  const db = Buffer.from(em.subarray(0, emLen - hLen - 1));
  const mask = [];
  for (let counter = 0, produced = 0; produced < db.length; counter++) {
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE(counter);
    const block = crypto.createHash("sha256").update(H).update(cb).digest();
    mask.push(block);
    produced += block.length;
  }
  const maskBuf = Buffer.concat(mask).subarray(0, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= maskBuf[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  return db.length - db.indexOf(0x01) - 1;
}

test("THE SALT LENGTH: signatures carry a 478-byte salt, recovered off the wire", () => {
  const item = ans104.signDataItem(JWK, { data: "salt check", tags: [{ name: "a", value: "b" }] });
  const recovered = recoverSaltLength(item.signature);
  assert.equal(
    recovered,
    478,
    "A 32-byte (digest-length) salt is what almost every crypto library defaults to. " +
      "It verifies everywhere today and is non-conformant. This must be 478.",
  );
  assert.equal(recovered, ans104.PSS_SALT_LENGTH_BYTES);
});

test("the salt-length trap: a 32-byte-salt signature still verifies loosely", () => {
  // Demonstrates why the assertion above cannot be replaced by a round-trip
  // test. This signature is WRONG and every ordinary check passes it.
  const unsigned = ans104.createDataItem({ data: "trap", owner: OWNER });
  const msg = ans104.getSignatureData(unsigned);
  const wrong = ans104.signMessage(JWK, msg, { saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  const item = Buffer.from(unsigned);
  item.set(wrong, 2);

  assert.equal(recoverSaltLength(wrong), 32, "the wrong signature really does have a 32-byte salt");
  assert.equal(ans104.verifyDataItem(item), true, "and it verifies loosely, as it does at the gateway today");
  assert.equal(
    ans104.verifyDataItem(item, { strictSaltLength: true }),
    false,
    "only the strict salt check catches it",
  );
});

test("RSA-PSS is randomised: the same input signs to different bytes and different ids", () => {
  const opts = { data: "same input", tags: [{ name: "n", value: "v" }] };
  const a = ans104.signDataItem(JWK, opts);
  const b = ans104.signDataItem(JWK, opts);
  assert.notEqual(a.signature.toString("hex"), b.signature.toString("hex"));
  assert.notEqual(a.idB64Url, b.idB64Url, "ids are NOT reproducible from the inputs alone");
  // ...but both are valid, and both items are byte-identical apart from the signature.
  assert.equal(ans104.verifyDataItem(a.binary), true);
  assert.equal(ans104.verifyDataItem(b.binary), true);
  const stripA = Buffer.from(a.binary);
  const stripB = Buffer.from(b.binary);
  stripA.fill(0, 2, 514);
  stripB.fill(0, 2, 514);
  assert.equal(stripA.toString("hex"), stripB.toString("hex"));
});

test("id is SHA-256 of the signature, 43 base64url characters", () => {
  const item = ans104.signDataItem(JWK, { data: "id check" });
  assert.equal(item.id.length, 32);
  assert.equal(item.idB64Url.length, 43);
  assert.equal(
    item.id.toString("hex"),
    crypto.createHash("sha256").update(item.signature).digest("hex"),
  );
});

test("signed items round-trip through our own verifier across the shape matrix", () => {
  const target = Buffer.alloc(32, 7).toString("base64url");
  const anchor = "anchor--------------------------"; // 32 raw bytes
  const shapes = [
    { label: "bare", opts: { data: "" } },
    { label: "data only", opts: { data: "hello" } },
    { label: "tags only", opts: { data: "", tags: [{ name: "a", value: "b" }] } },
    { label: "target", opts: { data: "x", target } },
    { label: "anchor", opts: { data: "x", anchor } },
    { label: "everything", opts: { data: "x", tags: [{ name: "a", value: "b" }], target, anchor } },
    { label: "binary data", opts: { data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) } },
    { label: "unicode tags", opts: { data: "x", tags: [{ name: "Тема", value: "всё 🎉" }] } },
  ];
  for (const { label, opts } of shapes) {
    const item = ans104.signDataItem(JWK, opts);
    assert.equal(ans104.verifyDataItem(item.binary), true, `${label}: verifies`);
    assert.equal(ans104.verifyDataItem(item.binary, { strictSaltLength: true }), true, `${label}: strict salt`);
  }
});

test("tampering is detected: data, tags, target, anchor, owner and signature", () => {
  const item = ans104.signDataItem(JWK, {
    data: "tamper me",
    tags: [{ name: "a", value: "b" }],
    target: Buffer.alloc(32, 3).toString("base64url"),
    anchor: "anchor--------------------------",
  });
  const parsed = ans104.parseDataItem(item.binary);
  const mutations = {
    "last data byte": (b) => (b[b.length - 1] ^= 0x01),
    "a tag byte": (b) => (b[parsed.offsets.tagsStart + 17] ^= 0x01),
    "a signature byte": (b) => (b[10] ^= 0x01),
    "an owner byte": (b) => (b[parsed.offsets.ownerStart + 5] ^= 0x01),
    "a target byte": (b) => (b[parsed.offsets.targetStart + 3] ^= 0x01),
    "an anchor byte": (b) => (b[parsed.offsets.anchorStart + 3] ^= 0x01),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const bad = Buffer.from(item.binary);
    mutate(bad);
    assert.equal(ans104.verifyDataItem(bad), false, `flipping ${what} must fail verification`);
  }
});

test("a truncated or garbage item is rejected, not thrown on", () => {
  assert.equal(ans104.verifyDataItem(Buffer.alloc(0)), false);
  assert.equal(ans104.verifyDataItem(Buffer.alloc(79)), false);
  assert.equal(ans104.verifyDataItem(Buffer.alloc(2000)), false); // signature type 0
  assert.equal(ans104.verifyDataItem(crypto.randomBytes(1500)), false);
});

test("the wallet address is base64url(sha256(owner))", () => {
  const expected = crypto.createHash("sha256").update(OWNER).digest().toString("base64url");
  assert.equal(ans104.addressFromOwner(OWNER), expected);
  assert.equal(expected.length, 43);
});

test("a key with a non-65537 exponent is rejected up front", () => {
  // The exponent is not carried on the wire, so items signed with any other
  // exponent verify nowhere. Better to refuse the key than emit dead items.
  const { loadJwk } = require("../src/jwk.js");
  const odd = { ...JWK, e: "AwE" };
  assert.throws(() => loadJwk(odd), /exponent must be 65537/);
});
