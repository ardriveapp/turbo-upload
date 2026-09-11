"use strict";
/**
 * Solana signing, ANS-104 signature type 4.
 *
 * The vectors here were produced by @dha-team/arbundles' HexSolanaSigner, which
 * is what @ardrive/turbo-sdk uses for token "solana". They are checked in rather
 * than generated at test time so the suite keeps no dependency.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const {
  TurboUpload,
  TurboKeyError,
  verifyDataItem,
  signDataItem,
  parseDataItem,
  SIGNATURE_TYPE_SOLANA,
} = require("../index.js");
const { SIG_CONFIG } = require("../src/ans104.js");
const { parseSolanaKey, signEd25519, verifyEd25519, publicKeyFromSeed } = require("../src/ed25519.js");
const { encodeBase58, decodeBase58 } = require("../src/base58.js");

/* A fixed seed, so every assertion below is reproducible. */
const SEED = Buffer.from("4a1f".repeat(16), "hex");
const PUBLIC_KEY = Buffer.from("f3e0c06c4ee45b7c05b1cbd4a1de78ee97b4bf0cbcb1c8bcbb28c3e1b1c1b2f6", "hex");

/* Produced by arbundles HexSolanaSigner for data "hello solana" with one tag. */
const REFERENCE = {
  data: "hello solana",
  tags: [{ name: "Content-Type", value: "text/plain" }],
  id: "Cjdm4GQgPrRlhuaET-0CAxCAIupBg3mh0lfhHLFGqI0",
};

const secretKeyBase58 = () => encodeBase58(Buffer.concat([SEED, publicKeyFromSeed(SEED)]));

/* ------------------------------- base58 -------------------------------- */

test("base58 round-trips, including the leading zeros that get dropped", () => {
  // Leading zero bytes are '1' characters and carry no numeric value. Handling
  // them inside the accumulator emits an extra byte, which a differential test
  // against bs58 caught and reading the code did not.
  for (const hex of ["00", "0000", "01", "ff", "00ff", "000000000000", "00".repeat(32)]) {
    const bytes = Buffer.from(hex, "hex");
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes, `round trip failed for ${hex}`);
  }
  assert.equal(encodeBase58(Buffer.from("00", "hex")), "1");
  assert.equal(encodeBase58(Buffer.alloc(0)), "");
  assert.equal(decodeBase58("").length, 0);
});

test("base58 rejects characters outside the alphabet", () => {
  // 0, O, I and l are excluded precisely because they are confusable.
  for (const bad of ["0", "O", "I", "l", "abc!"]) {
    assert.throws(() => decodeBase58(bad), /invalid base58 character/);
  }
});

/* --------------------------------- keys -------------------------------- */

test("every format a Solana user actually holds parses to the same key", () => {
  const publicKey = publicKeyFromSeed(SEED);
  const secret = Buffer.concat([SEED, publicKey]);
  const forms = [
    encodeBase58(secret),      // Phantom export
    JSON.stringify([...secret]), // solana-keygen file
    secret,                    // raw 64 bytes
    SEED,                      // bare seed
  ];
  for (const form of forms) {
    const parsed = parseSolanaKey(form);
    assert.deepEqual(parsed.seed, SEED);
    assert.deepEqual(parsed.publicKey, publicKey);
    assert.equal(parsed.address, encodeBase58(publicKey));
  }
});

test("a key whose public half disagrees with its seed is refused", () => {
  // Signing with one would produce items that verify nowhere, discovered after
  // paying to upload them.
  const corrupt = Buffer.concat([SEED, crypto.randomBytes(32)]);
  assert.throws(() => parseSolanaKey(corrupt), (err) =>
    err instanceof TurboKeyError && /corrupt/.test(err.message));
});

test("malformed keys fail at parse time, not at upload time", () => {
  assert.throws(() => parseSolanaKey(crypto.randomBytes(48)), /64 bytes|32 bytes/);
  assert.throws(() => parseSolanaKey("not-a-key-0OIl"), /base58/);
  assert.throws(() => parseSolanaKey(""), TurboKeyError);
  assert.throws(() => parseSolanaKey("[1,2,3"), /JSON/);
});

/* ------------------------- the hex-encoding trap ------------------------ */

test("type 4 signs the HEX of the signature data, not the bytes", () => {
  // This is the whole compatibility question. arbundles' HexSolanaSigner does
  // sign(Buffer.from(message.toString("hex"))), and turbo-sdk uses that signer
  // for token "solana". Signing the raw bytes yields a valid signature over the
  // wrong message: a different id, verifiable by nothing.
  const message = Buffer.from("some signature data");
  const key = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]),
    format: "der",
    type: "pkcs8",
  });
  const raw = crypto.sign(null, message, key);
  const ours = signEd25519(SEED, message);
  assert.notDeepEqual(ours, raw, "signEd25519 must not sign the raw bytes");
  assert.deepEqual(ours, crypto.sign(null, Buffer.from(message.toString("hex")), key));
});

test("verifyEd25519 applies the same hex step, so sign and verify agree", () => {
  const message = Buffer.from("round trip");
  const signature = signEd25519(SEED, message);
  assert.equal(verifyEd25519(publicKeyFromSeed(SEED), message, signature), true);
  assert.equal(verifyEd25519(publicKeyFromSeed(SEED), Buffer.from("other"), signature), false);
  assert.equal(verifyEd25519(crypto.randomBytes(32), message, signature), false);
  assert.equal(verifyEd25519(Buffer.alloc(31), message, signature), false, "wrong key width");
});

/* ----------------------------- conformance ----------------------------- */

test("a signed item is byte-identical to the reference implementation's", () => {
  const client = new TurboUpload({ jwk: secretKeyBase58(), token: "solana" });
  const item = client.sign({ data: Buffer.from(REFERENCE.data), tags: REFERENCE.tags });
  assert.equal(item.idB64Url, REFERENCE.id, "id must match arbundles HexSolanaSigner");
  assert.equal(verifyDataItem(Buffer.from(item.binary)), true);
});

test("the item carries type 4 with the widths the spec gives it", () => {
  const client = new TurboUpload({ jwk: secretKeyBase58(), token: "solana" });
  const item = client.sign({ data: "x" });
  const parsed = parseDataItem(Buffer.from(item.binary));
  assert.equal(parsed.signatureType, SIGNATURE_TYPE_SOLANA);
  assert.equal(SIGNATURE_TYPE_SOLANA, 4);
  assert.equal(SIG_CONFIG[4].sigLength, 64);
  assert.equal(SIG_CONFIG[4].ownerLength, 32);
  assert.equal(Buffer.from(parsed.rawOwner).length, 32);
  assert.deepEqual(Buffer.from(parsed.rawOwner), publicKeyFromSeed(SEED));
});

test("Ed25519 is deterministic, so the same input always gives the same id", () => {
  const client = new TurboUpload({ jwk: secretKeyBase58(), token: "solana" });
  const a = client.sign({ data: "same", tags: [{ name: "a", value: "b" }], anchor: Buffer.alloc(32) });
  const b = client.sign({ data: "same", tags: [{ name: "a", value: "b" }], anchor: Buffer.alloc(32) });
  assert.equal(a.idB64Url, b.idB64Url);
  // Unlike RSA-PSS, which draws a fresh salt and so cannot repeat an id.
});

/* ------------------------------- client -------------------------------- */

test("the client exposes a Solana address, not an Arweave one", () => {
  const client = new TurboUpload({ jwk: secretKeyBase58(), token: "solana" });
  assert.equal(client.address, encodeBase58(publicKeyFromSeed(SEED)));
  assert.equal(client.signatureType, 4);
  assert.equal(client.token, "solana");
  assert.match(client.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a Solana address is base58");
});

test("an Arweave client is unchanged by any of this", () => {
  const jwk = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey.export({ format: "jwk" });
  const client = new TurboUpload({ jwk });
  assert.equal(client.signatureType, 1);
  assert.equal(client.token, "arweave");
  const item = client.sign({ data: "x" });
  assert.equal(parseDataItem(Buffer.from(item.binary)).signatureType, 1);
  assert.equal(verifyDataItem(Buffer.from(item.binary)), true);
});

test("an unsupported token still names what to use instead", () => {
  assert.throws(
    () => new TurboUpload({ jwk: secretKeyBase58(), token: "ethereum" }),
    /turbo-sdk/,
  );
});

test("signDataItem refuses a type 4 item with no seed", () => {
  // The failure if this regressed is an unhandled throw deep in node:crypto.
  assert.throws(() => signDataItem(null, {
    data: Buffer.from("x"),
    owner: publicKeyFromSeed(SEED),
    signatureType: 4,
  }));
});
