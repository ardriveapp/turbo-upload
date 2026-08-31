"use strict";
/**
 * JWK intake and validation.
 *
 * Everything here runs EAGERLY, in the constructor, so a bad key fails at
 * startup with a message that names the problem. turbo-sdk's signer factory has
 * no `default:` branch for an unrecognised token, so it hands back `undefined`
 * and the process dies much later with
 *   TypeError: Cannot read properties of undefined (reading 'publicKey')
 * which tells you nothing about what you actually got wrong.
 */

const { Buffer } = require("node:buffer");
const { privateKeyFromJwk, ownerFromJwk, addressFromOwner } = require("./ans104.js");
const { TurboKeyError, TurboConfigError } = require("./errors.js");

/** The only token this package signs for. */
const SUPPORTED_TOKENS = ["arweave"];

/** Fields an Arweave JWK must carry to be usable for signing. */
const REQUIRED_PRIVATE_FIELDS = ["n", "e", "d", "p", "q", "dp", "dq", "qi"];

/**
 * Accept a JWK as an object OR as a JSON string.
 *
 * The string form is not a convenience, it is the normal case: keys arrive in
 * environment variables, and `process.env.ARWEAVE_JWK` is a string. Requiring
 * the caller to remember JSON.parse is a papercut that shows up as a confusing
 * downstream error rather than at the point of the mistake.
 */
function parseJwk(input) {
  if (input == null) {
    throw new TurboKeyError("No JWK supplied. Pass `jwk` as an Arweave JWK object or a JSON string.");
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") throw new TurboKeyError("The JWK string is empty.");
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TurboKeyError(`The JWK string parsed to ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object.`);
      }
      return parsed;
    } catch (cause) {
      if (cause instanceof TurboKeyError) throw cause;
      throw new TurboKeyError(
        "The JWK string is not valid JSON. An Arweave JWK is a JSON object with n/e/d/p/q/dp/dq/qi fields — " +
          "if it came from an environment variable, check it was not truncated or shell-quoted.",
        { cause },
      );
    }
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TurboKeyError(`Expected the JWK to be an object or a JSON string, got ${Array.isArray(input) ? "an array" : typeof input}.`);
  }
  return input;
}

/**
 * Validate an Arweave JWK and derive everything we need from it.
 *
 * @returns {{jwk: object, owner: Buffer, address: string, privateKey: import("node:crypto").KeyObject}}
 */
function loadJwk(input, { token = "arweave" } = {}) {
  if (!SUPPORTED_TOKENS.includes(token)) {
    throw new TurboConfigError(
      `Unsupported token "${token}". This package signs Arweave JWKs only (token: "arweave"). ` +
        `For Ethereum, Solana, KYVE or other chains use @ardrive/turbo-sdk.`,
    );
  }

  const jwk = parseJwk(input);

  if (jwk.kty !== undefined && jwk.kty !== "RSA") {
    throw new TurboKeyError(
      `Expected an RSA JWK (kty "RSA"), got kty "${jwk.kty}". ` +
        `An Arweave wallet key is RSA-4096; an Ethereum or Solana key is not usable here.`,
    );
  }

  const missing = REQUIRED_PRIVATE_FIELDS.filter((f) => typeof jwk[f] !== "string" || jwk[f] === "");
  if (missing.length) {
    const isPublicOnly = missing.includes("d") && typeof jwk.n === "string";
    throw new TurboKeyError(
      `The JWK is missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` +
        (isPublicOnly ? " This looks like a PUBLIC key — signing needs the full private JWK." : ""),
    );
  }

  // DE-FACTO: the public exponent is not carried on the wire, so every Arweave
  // implementation reconstructs the public key with e = 65537. A key with any
  // other exponent produces items that nothing can verify. Reject it here
  // rather than emitting items that silently fail downstream.
  if (jwk.e !== "AQAB") {
    throw new TurboKeyError(
      `The JWK public exponent must be 65537 ("AQAB"), got "${jwk.e}". ` +
        `ANS-104 does not carry the exponent on the wire — every verifier assumes 65537, ` +
        `so items signed with any other exponent cannot be verified by anyone.`,
    );
  }

  let owner;
  try {
    owner = ownerFromJwk(jwk);
  } catch (cause) {
    const len = (() => {
      try {
        return Buffer.from(jwk.n, "base64url").length;
      } catch {
        return "unknown";
      }
    })();
    throw new TurboKeyError(
      `The JWK modulus must be 512 bytes (RSA-4096), got ${len} bytes. Arweave wallet keys are always RSA-4096.`,
      { cause },
    );
  }

  let privateKey;
  try {
    privateKey = privateKeyFromJwk(jwk);
  } catch (cause) {
    throw new TurboKeyError(
      `The JWK fields are present but do not form a usable RSA private key: ${cause.message}`,
      { cause },
    );
  }

  return { jwk, owner, address: addressFromOwner(owner), privateKey };
}

module.exports = { parseJwk, loadJwk, SUPPORTED_TOKENS };
