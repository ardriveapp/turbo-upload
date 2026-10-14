"use strict";
/**
 * EVM signers: ANS-104 signature type 3, the type @ardrive/turbo-sdk emits for
 * an Ethereum key or wallet, for both `token: "base-eth"` and the others.
 *
 *   owner      65 bytes, the uncompressed secp256k1 public key 0x04 || X || Y
 *   signature  65 bytes, r || s || v, v in {27, 28}, s in the lower half
 *   message    EIP-191 personal_sign over the RAW 48-byte deep hash:
 *              keccak256("\x19Ethereum Signed Message:\n48" || deepHash)
 *
 * There is no secp256k1 in this package. The caller's EVM library signs, and
 * recovers a public key from a signature; viem's names are used, so a viem
 * account plus viem's `recoverPublicKey` is a signer as is. Everything that
 * gets written wrong is done here instead: the 48 raw bytes, the 65-byte
 * layout, v and s normalisation, the EIP-55 address, and a check that the
 * key recovered from every signature is the item's owner.
 *
 * EVERY SIGNATURE IS VERIFIED BEFORE IT IS USED, as for Solana wallets: a
 * wallet that signs the hex text, or a smart-contract wallet answering with
 * an ERC-1271 or ERC-6492 signature, would otherwise produce an item that
 * verifies nowhere, found out after paying for it.
 */

const { keccak256 } = require("./keccak.js");
const { toBytes, toHex, fromHex, utf8Encode, concatBytes, bytesEqual } = require("./bytes.js");
const { TurboConfigError, TurboSignerError } = require("./errors.js");

const PUBLIC_KEY_BYTES = 65;
const SIGNATURE_BYTES = 65;
const SIGNATURE_DATA_BYTES = 48;

/** The tokens an EVM signer pays with. */
const EVM_TOKENS = ["ethereum", "base-eth", "base-usdc"];

/**
 * What a wallet with no readable public key signs once, so the key can be
 * recovered from the signature. The same text @ardrive/turbo-sdk uses, so a
 * user who has seen that prompt sees the same one here.
 */
const CONNECT_MESSAGE = "sign this message to connect to your account";

/** The order of the secp256k1 group. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Appended to every TurboSignerError from this file. */
const WHY =
  " A smart-contract wallet (ERC-1271 or ERC-6492) cannot sign data items: type 3 needs the " +
  "key of an externally owned account. Nothing was uploaded and nothing was charged.";

/** EIP-191 personal_sign digest of raw bytes. */
function hashMessage(message) {
  return keccak256(concatBytes([utf8Encode(`\x19Ethereum Signed Message:\n${message.length}`), message]));
}

/** EIP-55: the mixed-case checksum form of a 20-byte hex address. */
function toChecksumAddress(address) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new TurboConfigError(`An EVM address is 0x and 40 hex characters, got ${JSON.stringify(address)}.`);
  }
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak256(utf8Encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** The EIP-55 address of a 65-byte uncompressed public key: the last 20 bytes of keccak256(X || Y). */
function addressFromPublicKey(publicKey) {
  return toChecksumAddress(`0x${toHex(keccak256(publicKey.subarray(1)).subarray(12))}`);
}

/** Bytes from a 0x hex string or a byte view; null for anything else. */
function bytesFrom(value) {
  if (typeof value === "string") {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) return null;
    return fromHex(value.slice(2));
  }
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) return Uint8Array.from(toBytes(value));
  return null;
}

function publicKeyFrom(value, where) {
  const key = bytesFrom(value);
  if (!key || key.length !== PUBLIC_KEY_BYTES || key[0] !== 0x04) {
    return { error: `${where} is not a 65-byte uncompressed public key (0x04 || X || Y)` };
  }
  return { key };
}

/**
 * Validate an EVM signer. The public key is optional: a browser wallet has no
 * way to hand one over, so it is recovered from a signature on first use.
 *
 * Unknown keys are allowed, as for Solana signers: a viem account carries
 * several of its own.
 */
function normalizeEthereumSigner(signer) {
  if (signer === null || typeof signer !== "object") {
    throw new TurboConfigError(`\`signer\` must be an object with address and signMessage, got ${signer === null ? "null" : typeof signer}.`);
  }
  if (typeof signer.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(signer.address)) {
    throw new TurboConfigError(`\`signer.address\` must be an EVM address, 0x and 40 hex characters, got ${JSON.stringify(signer.address)}.`);
  }
  const address = toChecksumAddress(signer.address);
  const body = signer.address.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && signer.address !== address) {
    throw new TurboConfigError(`\`signer.address\` ${signer.address} fails its EIP-55 checksum: ${address} is the checksummed form.`);
  }
  if (typeof signer.signMessage !== "function") {
    throw new TurboConfigError("`signer.signMessage` must be a function: ({ message: { raw: Uint8Array } }) => Promise<`0x${string}`>.");
  }
  if (signer.recoverPublicKey !== undefined && typeof signer.recoverPublicKey !== "function") {
    throw new TurboConfigError("`signer.recoverPublicKey` must be a function: ({ hash, signature }) => Promise<`0x${string}`>.");
  }
  let publicKey;
  if (signer.publicKey !== undefined) {
    const parsed = publicKeyFrom(signer.publicKey, "`signer.publicKey`");
    if (parsed.error) throw new TurboConfigError(`${parsed.error}.`);
    if (addressFromPublicKey(parsed.key) !== address) {
      throw new TurboConfigError(`\`signer.publicKey\` belongs to ${addressFromPublicKey(parsed.key)}, not to \`signer.address\` ${address}.`);
    }
    publicKey = parsed.key;
  }
  return {
    kind: "ethereum",
    address,
    publicKey,
    signMessage: (args) => signer.signMessage(args),
    recoverPublicKey: signer.recoverPublicKey ? (args) => signer.recoverPublicKey(args) : undefined,
  };
}

/**
 * 65 signature bytes out of a wallet's answer, with v as 27 or 28. A wallet
 * that writes v as 0 or 1 signs the same thing; that is normalised. A high s
 * is the other half of a malleable pair, and arbundles refuses it, so it is
 * refused here rather than producing an item nothing will verify.
 */
function normalizeSignature(result) {
  const found = bytesFrom(result);
  if (!found || found.length !== SIGNATURE_BYTES) {
    throw new TurboSignerError(
      `The signer's signMessage returned ${found ? `${found.length} bytes` : typeof result}, ` +
        `not a ${SIGNATURE_BYTES}-byte secp256k1 signature. Turbo's x402 route, where the service ` +
        `signs the data item, needs no data-item signature from the wallet.${WHY}`,
    );
  }
  const signature = found;
  if (signature[64] === 0 || signature[64] === 1) signature[64] += 27;
  if (signature[64] !== 27 && signature[64] !== 28) {
    throw new TurboSignerError(`The signer's signature has v = ${signature[64]}; type 3 needs 27 or 28 (or 0 or 1).${WHY}`);
  }
  const r = BigInt(`0x${toHex(signature.subarray(0, 32))}`);
  const s = BigInt(`0x${toHex(signature.subarray(32, 64))}`);
  if (r === 0n || r >= N || s === 0n || s > N / 2n) {
    throw new TurboSignerError(
      "The signer's signature is not in canonical low-s form, which every verifier of type 3 items " +
        `refuses.${WHY}`,
    );
  }
  return signature;
}

/** The public key `signer.recoverPublicKey` recovers, or a TurboSignerError. */
async function recover(signer, digest, signature) {
  let result;
  try {
    result = await signer.recoverPublicKey({ hash: `0x${toHex(digest)}`, signature: `0x${toHex(signature)}` });
  } catch (cause) {
    throw new TurboSignerError(`The signer's recoverPublicKey failed: ${cause && cause.message ? cause.message : cause}.`, { cause });
  }
  const parsed = publicKeyFrom(result, "What `signer.recoverPublicKey` returned");
  if (parsed.error) throw new TurboSignerError(`${parsed.error}.`);
  return parsed.key;
}

function needsRecover(signer) {
  if (!signer.recoverPublicKey) {
    throw new TurboSignerError(
      "An EVM signer needs `recoverPublicKey({ hash, signature })`: every signature is verified before " +
        "upload, and this package carries no secp256k1. viem exports one: " +
        "`import { recoverPublicKey } from \"viem\"`.",
    );
  }
}

/**
 * Have the signer sign raw bytes as an EIP-191 personal message, and return
 * the normalised signature with the digest it covers.
 */
async function personalSign(signer, raw) {
  let result;
  try {
    result = await signer.signMessage({ message: { raw: Uint8Array.from(raw) } });
  } catch (cause) {
    throw new TurboSignerError(`The signer's signMessage failed: ${cause && cause.message ? cause.message : cause}.${WHY}`, { cause });
  }
  return { signature: normalizeSignature(result), digest: hashMessage(raw) };
}

/**
 * The signer's public key, which is the item's owner. Read from the signer
 * when it has one; otherwise recovered from a signature over CONNECT_MESSAGE,
 * once per signer, and checked against `signer.address` either way.
 *
 * @returns {Promise<Uint8Array>} 65 bytes
 */
function ethereumPublicKey(signer) {
  if (signer.publicKey) return Promise.resolve(signer.publicKey);
  if (!signer.connecting) {
    signer.connecting = (async () => {
      needsRecover(signer);
      const { signature, digest } = await personalSign(signer, utf8Encode(CONNECT_MESSAGE));
      const key = await recover(signer, digest, signature);
      if (addressFromPublicKey(key) !== signer.address) {
        throw new TurboSignerError(
          `The signer signed the connect message with the key of ${addressFromPublicKey(key)}, not of ` +
            `\`signer.address\` ${signer.address}.${WHY}`,
        );
      }
      signer.publicKey = key;
      return key;
    })();
    // A refused prompt can be tried again.
    signer.connecting.catch(() => {
      signer.connecting = undefined;
    });
  }
  return signer.connecting;
}

/**
 * Have the signer sign one item's deep hash, and verify the result.
 *
 * @param {object} signer normalized
 * @param {Uint8Array} signatureData the 48-byte deep hash
 * @returns {Promise<Uint8Array>} the 65-byte signature, v as 27 or 28, verified
 */
async function signWithEthereumSigner(signer, signatureData) {
  if (signatureData.length !== SIGNATURE_DATA_BYTES) {
    throw new TurboSignerError(`Type 3 signs the ${SIGNATURE_DATA_BYTES}-byte deep hash, got ${signatureData.length} bytes.`);
  }
  needsRecover(signer);
  const owner = await ethereumPublicKey(signer);
  const { signature, digest } = await personalSign(signer, signatureData);
  const recovered = await recover(signer, digest, signature);
  if (!bytesEqual(recovered, owner)) {
    throw new TurboSignerError(
      "The signer returned a signature that does not recover to its public key over the message it " +
        "was given. The wallet most likely signed something else, such as the hex text of the bytes " +
        `rather than the bytes.${WHY}`,
    );
  }
  return signature;
}

/**
 * Verify a type 3 signature against its owner.
 *
 * By default this accepts what @dha-team/arbundles accepts: its check ignores
 * the v byte entirely, so the key is recovered with both recovery ids and
 * either may match. Any of the 256 values of v then verifies, which gives the
 * same content up to 255 more valid ids. `strictV` refuses all of them but
 * the original: v must be 27 or 28 and the one that recovers the owner. A
 * high s is refused in both modes, as arbundles refuses it.
 *
 * One exception, in both modes: the owner must be 0x04 || X || Y. arbundles
 * also accepts the hybrid prefixes 0x06 and 0x07, which no EVM library
 * produces and turbo-sdk never writes; this refuses them.
 *
 * @param {{owner: Uint8Array, signatureData: Uint8Array, signature: Uint8Array,
 *   recoverPublicKey: Function, strictV?: boolean}} opts
 * @returns {Promise<boolean>}
 */
async function verifyEthereumSignature({ owner, signatureData, signature, recoverPublicKey, strictV }) {
  if (owner.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  const r = BigInt(`0x${toHex(signature.subarray(0, 32))}`);
  const s = BigInt(`0x${toHex(signature.subarray(32, 64))}`);
  if (r === 0n || r >= N || s === 0n || s > N / 2n) return false;
  const v = signature[64];
  if (strictV && v !== 27 && v !== 28) return false;
  const digest = hashMessage(signatureData);
  const signer = { recoverPublicKey };
  for (const candidate of strictV ? [v] : [27, 28]) {
    const sig = Uint8Array.from(signature);
    sig[64] = candidate;
    try {
      if (bytesEqual(await recover(signer, digest, sig), owner)) return true;
    } catch {
      // A signature that recovers to no point is a signature that does not verify.
    }
  }
  return false;
}

module.exports = {
  EVM_TOKENS,
  CONNECT_MESSAGE,
  hashMessage,
  toChecksumAddress,
  addressFromPublicKey,
  normalizeEthereumSigner,
  ethereumPublicKey,
  signWithEthereumSigner,
  verifyEthereumSignature,
};
