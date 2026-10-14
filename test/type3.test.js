"use strict";
/**
 * The type 3 corpus: 22 complete signed items produced by @ardrive/turbo-sdk
 * 2.1.0 with an EVM key (conformance/type3-vectors.json), each reproduced byte
 * for byte, and the checks an EVM signer goes through before an item is used.
 *
 * No secp256k1 here, and none in the package: the signer is a replay of the
 * corpus. It asserts what it was asked to sign and answers with the reference
 * signature, and its `recoverPublicKey` answers from a table of the corpus's
 * (digest, signature) pairs, with an unrelated key for anything else, which is
 * what real recovery gives for a signature over another message. It reads v
 * as 0 or 1 the way 27 or 28 is read, and a high s with v flipped as its
 * low-s twin, because real recovery does both. The same
 * flows with real keys run in conformance/cross-verify.js and in the browser
 * harness.
 *
 * The corpus does not ship, so neither does this file (package.json `files`
 * excludes it). Run from a checkout, it runs on every Node version CI tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");

const {
  TurboUpload,
  verifyDataItem,
  createDataItem,
  getSignatureData,
  TurboSignerError,
  TurboConfigError,
  TurboValidationError,
  SIGNATURE_TYPE_ETHEREUM,
} = require("../index.js");
const { hashMessage, addressFromPublicKey, CONNECT_MESSAGE, signWithEthereumSigner, normalizeEthereumSigner } = require("../src/core/ethereum.js");

const CORPUS = path.join(__dirname, "..", "conformance", "type3-vectors.json");
const present = fs.existsSync(CORPUS);
const skip = present ? false : "conformance/type3-vectors.json is not shipped; run from a checkout";
const V = present ? JSON.parse(fs.readFileSync(CORPUS, "utf8")) : { vectors: [] };

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const UNRELATED_KEY = `0x04${"11".repeat(64)}`;

const inputOf = (v) => ({
  data: Buffer.from(v.input.data_hex, "hex"),
  tags: v.input.tags,
  target: v.input.target_b64url ?? undefined,
  anchor: v.input.anchor_utf8 ?? undefined,
});

/** `recoverPublicKey` over the corpus: each vector's signature, and its connect signature, recover its key. */
function replayRecover() {
  const table = new Map();
  for (const v of V.vectors) {
    table.set(`${v.expected.eip191_digest_hex}|${v.expected.signature_hex}`, `0x${v.public_key_hex}`);
    table.set(`${v.wallet_path.connect_digest_hex}|${v.wallet_path.connect_signature_hex}`, `0x${v.public_key_hex}`);
  }
  const calls = [];
  const recoverPublicKey = async ({ hash, signature }) => {
    assert.match(hash, /^0x[0-9a-f]{64}$/, "the hash is 0x hex, 32 bytes");
    assert.match(signature, /^0x[0-9a-f]{130}$/, "the signature is 0x hex, 65 bytes");
    calls.push({ hash, signature });
    let sig = signature.slice(2);
    let v = parseInt(sig.slice(128), 16);
    if (v < 27) v += 27;
    const s = BigInt(`0x${sig.slice(64, 128)}`);
    if (s > N / 2n) {
      sig = withS(sig, N - s);
      v = v === 27 ? 28 : 27;
    }
    return table.get(`${hash.slice(2)}|${withV(sig, v)}`) ?? UNRELATED_KEY;
  };
  recoverPublicKey.calls = calls;
  return recoverPublicKey;
}

/**
 * A signer that replays one vector. `answer` rewrites the signature it hands
 * back, to model a wallet that misbehaves.
 */
function replaySigner(v, { publicKey = true, answer = (sig) => `0x${sig}` } = {}) {
  const asked = [];
  const signer = {
    address: v.address,
    signMessage: async (args) => {
      assert.deepEqual(Object.keys(args), ["message"]);
      assert.deepEqual(Object.keys(args.message), ["raw"]);
      const raw = args.message.raw;
      assert.ok(raw instanceof Uint8Array, "the message is raw bytes");
      asked.push(Buffer.from(raw));
      if (Buffer.from(raw).toString("utf8") === CONNECT_MESSAGE) return `0x${v.wallet_path.connect_signature_hex}`;
      assert.equal(raw.length, 48, "the signer is handed exactly the 48 bytes of the deep hash");
      assert.equal(Buffer.from(raw).toString("hex"), v.expected.deep_hash_hex, "and they are the deep hash, raw");
      return answer(v.expected.signature_hex);
    },
    recoverPublicKey: replayRecover(),
    asked,
  };
  if (publicKey) signer.publicKey = `0x${v.public_key_hex}`;
  return signer;
}

/** A fetch stub that answers like the upload service and records every call. */
function echoFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "POST") {
      const id = crypto.createHash("sha256").update(Buffer.from(init.body).subarray(2, 67)).digest("base64url");
      return new Response(JSON.stringify({ id, winc: "0" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ winc: "0", bytesRemaining: 104857600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const withS = (sigHex, s) => sigHex.slice(0, 64) + s.toString(16).padStart(64, "0") + sigHex.slice(128);
const withV = (sigHex, v) => sigHex.slice(0, 128) + v.toString(16).padStart(2, "0");

test("the type 3 corpus is the one turbo-sdk 2.1.0 generated", { skip }, () => {
  assert.equal(V.format, "ans104-type3-conformance-vectors");
  assert.equal(V.generated_by, "@ardrive/turbo-sdk@2.1.0");
  assert.equal(V.signature_type.id, 3);
  assert.equal(SIGNATURE_TYPE_ETHEREUM, 3);
  assert.equal(V.connect_message, CONNECT_MESSAGE);
  assert.equal(V.vectors.length, 22);
  const vs = new Set(V.vectors.map((v) => v.expected.signature_hex.slice(-2)));
  assert.deepEqual([...vs].sort(), ["1b", "1c"], "the corpus holds both values of v");
});

test("type 3 headers, deep hashes, digests and addresses rebuilt byte for byte", { skip }, () => {
  for (const v of V.vectors) {
    const owner = Buffer.from(v.public_key_hex, "hex");
    const unsigned = createDataItem({ ...inputOf(v), owner, signatureType: 3 });
    const expected = Buffer.from(v.expected.signed_item_hex, "hex");
    expected.fill(0, 2, 67);
    assert.equal(unsigned.toString("hex"), expected.toString("hex"), `${v.name}: unsigned item`);
    const deep = getSignatureData(Buffer.from(v.expected.signed_item_hex, "hex"));
    assert.equal(deep.toString("hex"), v.expected.deep_hash_hex, `${v.name}: deep hash`);
    assert.equal(Buffer.from(hashMessage(deep)).toString("hex"), v.expected.eip191_digest_hex, `${v.name}: EIP-191 digest`);
    assert.equal(addressFromPublicKey(owner), v.address, `${v.name}: EIP-55 address`);
  }
});

test("type 3, a signer with a public key: every vector byte-identical, one signMessage call each", { skip }, async () => {
  for (const v of V.vectors) {
    const signer = replaySigner(v);
    const client = new TurboUpload({ signer, token: "base-eth" });
    assert.equal(client.address, v.address);
    assert.equal(client.signatureType, 3);
    assert.equal(client.owner.toString("hex"), v.public_key_hex);
    const item = await client.signAsync(inputOf(v));
    assert.equal(signer.asked.length, 1, `${v.name}: one call`);
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, `${v.name}: signed item`);
    assert.equal(item.signature.toString("hex"), v.expected.signature_hex);
    assert.equal(item.idB64Url, crypto.createHash("sha256").update(Buffer.from(v.expected.signature_hex, "hex")).digest("base64url"));
    assert.equal(item.idB64Url, v.expected.id_b64url, `${v.name}: id`);
    assert.equal(await verifyDataItem(item.binary, { recoverPublicKey: replayRecover(), strictV: true }), true, `${v.name}: verifies`);
  }
});

test("type 3, a wallet with no public key: the connect message once, then the deep hash per item", { skip }, async () => {
  for (const v of V.vectors) {
    const signer = replaySigner(v, { publicKey: false });
    const client = new TurboUpload({ signer, token: "ethereum" });
    assert.throws(() => client.owner, (err) => err instanceof TurboSignerError && /publicKey/.test(err.message),
      "unknown until the wallet has signed, and says so rather than answering undefined");
    assert.equal(client.getDataItemSize(inputOf(v)), v.expected.signed_item_length, "sized before the key is known");
    const item = await client.signAsync(inputOf(v));
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, v.name);
    assert.equal(client.owner.toString("hex"), v.public_key_hex);
    assert.deepEqual(signer.asked.map((m) => m.length), [Buffer.byteLength(CONNECT_MESSAGE), 48]);
    assert.equal(signer.asked[0].toString("utf8"), CONNECT_MESSAGE);
    await client.signAsync(inputOf(v));
    assert.equal(signer.asked.length, 3, "the key is cached: no second connect");
  }
});

test("a wallet that writes v as 0 or 1 signs the same item, with v normalised to 27 or 28", { skip }, async () => {
  for (const v of V.vectors.slice(0, 6)) {
    const vByte = parseInt(v.expected.signature_hex.slice(-2), 16);
    const signer = replaySigner(v, { answer: (sig) => `0x${withV(sig, vByte - 27)}` });
    const item = await new TurboUpload({ signer, token: "base-usdc" }).signAsync(inputOf(v));
    assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex, v.name);
  }
});

test("misbehaving signers throw TurboSignerError, and nothing is uploaded", { skip }, async () => {
  const v = V.vectors[3];
  const other = V.vectors[4];
  const s = BigInt(`0x${v.expected.signature_hex.slice(64, 128)}`);
  const vByte = parseInt(v.expected.signature_hex.slice(-2), 16);
  const cases = [
    ["high s, the other half of the malleable pair", { answer: (sig) => `0x${withV(withS(sig, N - s), vByte ^ 7)}` }, /low-s/],
    ["v outside 0, 1, 27, 28", { answer: (sig) => `0x${withV(sig, 29)}` }, /v = 29/],
    ["97 bytes, an ERC-6492 style answer", { answer: (sig) => `0x${sig}${"ab".repeat(32)}` }, /97 bytes/],
    ["64 bytes, no v", { answer: (sig) => `0x${sig.slice(0, 128)}` }, /64 bytes/],
    ["not hex", { answer: () => "0xzz" }, /string/],
    ["a signature over another message", { answer: () => `0x${other.expected.signature_hex}` }, /does not recover/],
    ["signMessage throws", { answer: () => { throw new Error("User rejected the request"); } }, /User rejected/],
  ];
  for (const [label, opts, pattern] of cases) {
    const fetch = echoFetch();
    const client = new TurboUpload({ signer: replaySigner(v, opts), token: "base-eth", fetch });
    await assert.rejects(client.upload(inputOf(v)), (err) => err instanceof TurboSignerError && pattern.test(err.message), label);
    assert.equal(fetch.calls.length, 0, `${label}: nothing was sent`);
  }
});

test("a signer that answers bytes rather than hex works too", { skip }, async () => {
  const v = V.vectors[5];
  const signer = replaySigner(v, { answer: (sig) => Uint8Array.from(Buffer.from(sig, "hex")) });
  const item = await new TurboUpload({ signer, token: "base-eth" }).signAsync(inputOf(v));
  assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex);
});

test("recoverPublicKey is required, and what it returns is checked", { skip }, async () => {
  const v = V.vectors[1];
  const { recoverPublicKey, ...noRecover } = replaySigner(v);
  await assert.rejects(new TurboUpload({ signer: noRecover, token: "base-eth" }).signAsync(inputOf(v)),
    (err) => err instanceof TurboSignerError && /recoverPublicKey/.test(err.message));
  const garbage = { ...replaySigner(v), recoverPublicKey: async () => "0x1234" };
  await assert.rejects(new TurboUpload({ signer: garbage, token: "base-eth" }).signAsync(inputOf(v)),
    (err) => err instanceof TurboSignerError && /65-byte uncompressed/.test(err.message));
  const throws = { ...replaySigner(v), recoverPublicKey: async () => { throw new Error("invalid signature"); } };
  await assert.rejects(new TurboUpload({ signer: throws, token: "base-eth" }).signAsync(inputOf(v)),
    (err) => err instanceof TurboSignerError && err.cause instanceof Error);
});

test("the address is checked against the public key, given or recovered", { skip }, async () => {
  const v = V.vectors[2];
  const other = V.vectors[7];
  assert.throws(() => new TurboUpload({ signer: { ...replaySigner(v), publicKey: `0x${other.public_key_hex}` }, token: "base-eth" }),
    (err) => err instanceof TurboConfigError && err.message.includes(other.address));
  // A wallet whose connect signature recovers to another account.
  const lying = { ...replaySigner(v, { publicKey: false }), address: other.address };
  await assert.rejects(new TurboUpload({ signer: lying, token: "base-eth" }).signAsync(inputOf(v)),
    (err) => err instanceof TurboSignerError && err.message.includes(v.address));
  // A mixed-case address with a broken checksum is refused; all lower case is accepted and checksummed.
  const broken = v.address.slice(0, 2) + [...v.address.slice(2)].map((c) => (/[a-f]/.test(c) ? c.toUpperCase() : /[A-F]/.test(c) ? c.toLowerCase() : c)).join("");
  assert.throws(() => new TurboUpload({ signer: { ...replaySigner(v), address: broken }, token: "base-eth" }), /EIP-55/);
  assert.equal(new TurboUpload({ signer: { ...replaySigner(v), address: v.address.toLowerCase() }, token: "base-eth" }).address, v.address);
});

test("an EVM signer needs an EVM token, and a raw key with one is pointed at signer", { skip }, () => {
  const v = V.vectors[0];
  assert.throws(() => new TurboUpload({ signer: replaySigner(v) }), (err) => err instanceof TurboConfigError && /base-eth/.test(err.message));
  assert.throws(() => new TurboUpload({ signer: replaySigner(v), token: "solana" }), TurboConfigError);
  assert.throws(() => new TurboUpload({ jwk: crypto.randomBytes(32), token: "base-eth" }), (err) => err instanceof TurboConfigError && /signer/.test(err.message));
});

test("verifyDataItem: type 3 needs recoverPublicKey, and strictV pins v", { skip }, async () => {
  const recoverPublicKey = replayRecover();
  for (const v of V.vectors) {
    const item = Buffer.from(v.expected.signed_item_hex, "hex");
    assert.throws(() => verifyDataItem(item), (err) => err instanceof TurboValidationError && /recoverPublicKey/.test(err.message));
    assert.equal(await verifyDataItem(item, { recoverPublicKey }), true, `${v.name}: turbo-sdk's item verifies`);

    const vByte = item[66];
    const flipped = Buffer.from(item);
    flipped[66] = vByte === 27 ? 28 : 27;
    assert.equal(await verifyDataItem(flipped, { recoverPublicKey }), true, `${v.name}: a flipped v passes, as arbundles passes it`);
    assert.equal(await verifyDataItem(flipped, { recoverPublicKey, strictV: true }), false, `${v.name}: strictV refuses a flipped v`);

    const zeroOne = Buffer.from(item);
    zeroOne[66] = vByte - 27;
    assert.equal(await verifyDataItem(zeroOne, { recoverPublicKey }), true, `${v.name}: v as 0 or 1 passes by default`);
    assert.equal(await verifyDataItem(zeroOne, { recoverPublicKey, strictV: true }), false, `${v.name}: strictV refuses v as 0 or 1`);

    const highS = Buffer.from(withS(v.expected.signed_item_hex.slice(4, 134), N - BigInt(`0x${v.expected.signature_hex.slice(64, 128)}`)), "hex");
    const malleated = Buffer.from(item);
    highS.copy(malleated, 2);
    assert.equal(await verifyDataItem(malleated, { recoverPublicKey }), false, `${v.name}: high s is refused`);

    const owner = Buffer.from(item);
    owner[100] ^= 1;
    assert.equal(await verifyDataItem(owner, { recoverPublicKey }), false, `${v.name}: a flipped owner byte is refused`);
    if (v.input.data_hex !== "") {
      const data = Buffer.from(item);
      data[data.length - 1] ^= 1;
      assert.equal(await verifyDataItem(data, { recoverPublicKey }), false, `${v.name}: a flipped data byte is refused`);
    }
    if (v.input.tags.length) {
      const it = require("../index.js").parseDataItem(item);
      const tags = Buffer.from(item);
      tags[it.offsets.tagsStart + 16 + it.rawTags.length - 2] ^= 1;
      assert.equal(await verifyDataItem(tags, { recoverPublicKey }), false, `${v.name}: a flipped tag byte is refused`);
    }
  }
});

test("prices, balances and the free quota go out with the 0x address and the EVM token", { skip }, async () => {
  const v = V.vectors[0];
  const fetch = echoFetch();
  const client = new TurboUpload({ signer: replaySigner(v), token: "base-eth", fetch, uploadUrl: "https://u.test", paymentUrl: "https://p.test" });
  await client.getBalance();
  await client.getWincForToken(10n ** 15n);
  await client.getFreeQuota();
  const res = await client.upload(inputOf(v));
  assert.deepEqual(fetch.calls.map((c) => c.url), [
    `https://p.test/v1/account/balance/base-eth?address=${v.address}`,
    "https://p.test/v1/price/base-eth/1000000000000000",
    `https://p.test/v1/account/free?address=${v.address}`,
    "https://u.test/v1/tx",
  ]);
  assert.equal(Buffer.from(fetch.calls[3].init.body).readUInt16LE(0), 3, "a type 3 item went out");
  assert.equal(res.id, v.expected.id_b64url);
});

test("concurrent first signatures share one connect prompt", { skip }, async () => {
  const v = V.vectors[6];
  const signer = replaySigner(v, { publicKey: false });
  const client = new TurboUpload({ signer, token: "base-eth" });
  const items = await Promise.all([1, 2, 3].map(() => client.signAsync(inputOf(v))));
  const connects = signer.asked.filter((m) => m.toString("utf8") === CONNECT_MESSAGE).length;
  assert.equal(connects, 1, "one connect prompt for three concurrent first calls");
  assert.equal(signer.asked.length, 4);
  for (const item of items) assert.equal(item.binary.toString("hex"), v.expected.signed_item_hex);
});

test("the signer is only ever handed 48 bytes: anything else is refused before it is asked", { skip }, async () => {
  const v = V.vectors[0];
  const signer = replaySigner(v);
  const normalized = normalizeEthereumSigner(signer);
  for (const length of [0, 32, 47, 49, 96]) {
    await assert.rejects(signWithEthereumSigner(normalized, new Uint8Array(length)),
      (err) => err instanceof TurboSignerError && err.message.includes(`got ${length} bytes`), `${length} bytes`);
  }
  assert.equal(signer.asked.length, 0, "the wallet was never prompted");
});

test("Node client.verify with no options is a synchronous boolean on an EVM client, and throws for type 3", { skip }, async () => {
  const v = V.vectors[8];
  const signer = replaySigner(v);
  const client = new TurboUpload({ signer, token: "base-eth" });
  const type3 = Buffer.from(v.expected.signed_item_hex, "hex");
  const seed = crypto.randomBytes(32);
  const type4 = Buffer.from(new TurboUpload({ jwk: seed, token: "solana" }).sign({ data: "x" }).binary);
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 4096 });
  const type1 = Buffer.from(new TurboUpload({ jwk: privateKey.export({ format: "jwk" }) }).sign({ data: "x" }).binary);
  for (const [label, item] of [["type 1", type1], ["type 4", type4]]) {
    assert.equal(client.verify(item), true, `${label} verifies`);
    const bad = Buffer.from(item);
    bad[bad.length - 1] ^= 1;
    assert.equal(client.verify(bad), false, `${label}: a tampered item is a plain false, not a truthy promise`);
  }
  assert.throws(() => client.verify(type3), (err) => err instanceof TurboValidationError && /recoverPublicKey/.test(err.message));
  assert.equal(signer.recoverPublicKey.calls.length, 0, "the signer's recoverPublicKey is not filled in");
  // With it passed, the promise overload.
  const answer = client.verify(type3, { recoverPublicKey: signer.recoverPublicKey, strictV: true });
  assert.ok(answer instanceof Promise);
  assert.equal(await answer, true);
});

test("any v byte verifies by default, as arbundles accepts it, and strictV refuses all but the original", { skip }, async () => {
  const recoverPublicKey = replayRecover();
  const v = V.vectors[9];
  const item = Buffer.from(v.expected.signed_item_hex, "hex");
  let accepted = 0;
  for (let b = 0; b < 256; b++) {
    const copy = Buffer.from(item);
    copy[66] = b;
    if (await verifyDataItem(copy, { recoverPublicKey })) accepted++;
    assert.equal(await verifyDataItem(copy, { recoverPublicKey, strictV: true }), b === item[66], `strictV, v = ${b}`);
  }
  assert.equal(accepted, 256);
});

test("a type 3 item whose declared tag length runs past its end is refused before any key is recovered", { skip }, async () => {
  const v = V.vectors.find((x) => x.name === "empty-data-empty-tags");
  const bad = Buffer.from(v.expected.signed_item_hex, "hex");
  bad[bad.length - 1] ^= 0x80;
  const recoverPublicKey = replayRecover();
  // Structure first: no throw for the missing recoverPublicKey, and no call to it.
  assert.equal(verifyDataItem(bad), false);
  assert.equal(await verifyDataItem(bad, { recoverPublicKey }), false);
  assert.equal(await verifyDataItem(bad, { recoverPublicKey, strictV: true }), false);
  assert.equal(recoverPublicKey.calls.length, 0);
});
