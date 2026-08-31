// Empirical probe: what salt length does arbundles actually emit, and is PSS randomised?
const crypto = require("node:crypto");
const ARB = "/tmp/claude-1000/-mnt-c-source-sanning-io-aom/53472aba-ef33-4ece-94cd-bbb80849d7f8/scratchpad/minimal/node_modules/@dha-team/arbundles/build/node/cjs/src/";
const ArweaveSigner = require(ARB + "signing/chains/ArweaveSigner.js").default;
const { createData } = require(ARB + "ar-data-create.js");
const getSignatureData = require(ARB + "ar-data-base.js").default;

const jwk = require("./test-key.json");
const signer = new ArweaveSigner(jwk);

(async () => {
  const item = createData("probe", signer, { tags: [{ name: "a", value: "b" }] });
  const msg = Buffer.from(await getSignatureData(item));

  // --- randomness ---
  const s1 = Buffer.from(await signer.sign(msg));
  const s2 = Buffer.from(await signer.sign(msg));
  console.log("sig length:", s1.length);
  console.log("two signatures over identical input equal?", s1.equals(s2));
  console.log("  sig1[0..16]:", s1.subarray(0, 16).toString("hex"));
  console.log("  sig2[0..16]:", s2.subarray(0, 16).toString("hex"));

  const pub = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  console.log("modulusLength:", pub.asymmetricKeyDetails.modulusLength);

  // --- recover EM directly: sig^e mod n with no padding removal ---
  const em = crypto.publicDecrypt({ key: pub, padding: crypto.constants.RSA_NO_PADDING }, s1);
  const hLen = 32, emLen = em.length, emBits = pub.asymmetricKeyDetails.modulusLength - 1;
  console.log("emLen:", emLen, "emBits:", emBits, "trailer byte:", em[emLen - 1].toString(16));
  const maskedDB = em.subarray(0, emLen - hLen - 1);
  const H = em.subarray(emLen - hLen - 1, emLen - 1);
  // MGF1-SHA256
  const mgf1 = (seed, len) => {
    const out = [];
    for (let c = 0, n = 0; n < len; c++) {
      const cb = Buffer.alloc(4); cb.writeUInt32BE(c);
      const h = crypto.createHash("sha256").update(seed).update(cb).digest();
      out.push(h); n += h.length;
    }
    return Buffer.concat(out).subarray(0, len);
  };
  const db = Buffer.from(maskedDB);
  const mask = mgf1(H, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  // clear the leftmost 8*emLen - emBits bits
  const clearBits = 8 * emLen - emBits;
  db[0] &= 0xff >> clearBits;
  const sep = db.indexOf(0x01);
  const salt = db.subarray(sep + 1);
  console.log("DB length:", db.length, "0x01 separator at:", sep);
  console.log("RECOVERED SALT LENGTH:", salt.length, "bytes");
  console.log("  (digest len =", hLen, "; theoretical max = emLen - hLen - 2 =", emLen - hLen - 2, ")");

  // --- which explicit saltLength values does Node's verifier accept? ---
  const tryVerify = (sl) => {
    try {
      return crypto.createVerify("sha256").update(msg).verify(
        { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: sl }, s1);
    } catch (e) { return "ERR:" + e.message.split("\n")[0]; }
  };
  console.log("verify saltLength=32 (DIGEST):", tryVerify(32));
  console.log("verify saltLength=" + salt.length + " (recovered):", tryVerify(salt.length));
  console.log("verify saltLength=RSA_PSS_SALTLEN_MAX_SIGN(-2):", tryVerify(crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN));
  console.log("verify saltLength=RSA_PSS_SALTLEN_AUTO(-2? ->)", crypto.constants.RSA_PSS_SALTLEN_AUTO, ":", tryVerify(crypto.constants.RSA_PSS_SALTLEN_AUTO));
  console.log("verify with NO saltLength given (Node default):",
    crypto.createVerify("sha256").update(msg).verify({ key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, s1));

  // --- does arbundles' own verifier accept a DIGEST-salt (32) signature? ---
  const priv = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const sigDigestSalt = crypto.createSign("sha256").update(msg).sign({
    key: priv, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  const emD = crypto.publicDecrypt({ key: pub, padding: crypto.constants.RSA_NO_PADDING }, sigDigestSalt);
  console.log("--- cross-tolerance ---");
  console.log("arbundles verifier accepts salt=32 signature?",
    await ArweaveSigner.verify(jwk.n, msg, sigDigestSalt));
  console.log("constants: SALTLEN_DIGEST=", crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    "SALTLEN_MAX_SIGN=", crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN,
    "SALTLEN_AUTO=", crypto.constants.RSA_PSS_SALTLEN_AUTO);
})();
