"use strict";
/**
 * x402 uploads on the unsigned route: the caller's EVM wallet signs a USDC
 * payment authorization (EIP-3009 TransferWithAuthorization, as EIP-712 typed
 * data), and the upload service wraps the raw bytes into a data item that it
 * signs with its own key.
 *
 * The bytes and tags travel in the route's JSON envelope, the one form in
 * which the service reads tags with any value. The typed data and X-PAYMENT
 * header match the `x402` package's v1 "exact" EVM client: conformance/x402.js
 * checks them against its vectors. There is no secp256k1 or keccak here. The
 * caller's signer signs, and the service checks.
 */

const core = require("./ans104.js");
const { toBytes, toHex, utf8Encode } = require("./bytes.js");
const { request, resolveRetryConfig, DEFAULT_TIMEOUT_MS } = require("./http.js");
const { PRODUCTION, TESTNET } = require("./endpoints.js");
const { assertKnownOptions, trimUrl } = require("./client.js");
const { integerString } = require("./payment.js");
const { timeoutFor } = require("./chunked.js");
const { TurboValidationError, TurboSignerError, TurboPaymentError, TurboHTTPError, TurboNetworkError, TurboTimeoutError } = require("./errors.js");

/**
 * The networks this package pays on, with USDC pinned per network. An
 * `accepts` entry naming any other asset is refused, whatever the service says.
 */
const X402_NETWORKS = Object.freeze({
  base: Object.freeze({ chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }),
  "base-sepolia": Object.freeze({ chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }),
});

/** The largest request body the unsigned route takes: testnet answers 413 one byte over. */
const X402_MAX_BODY_BYTES = 100 * 1024 * 1024;

/**
 * The most data one request carries with no tags: base64 in the envelope
 * makes it four bytes for every three, plus `{"data":"","tags":[]}`.
 */
const X402_MAX_DATA_BYTES = Math.floor((X402_MAX_BODY_BYTES - 21) / 4) * 3;

/**
 * The most bytes the caller's tags can take on this route. The service adds
 * about 300 bytes of its own tags after the payment settles, and an item over
 * MAX_TAG_BYTES then fails with the payment already taken.
 */
const X402_MAX_TAG_BYTES = core.MAX_TAG_BYTES - 1024;

const TRANSFER_WITH_AUTHORIZATION = Object.freeze([
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
]);

const ROUTE = "/v1/x402/upload/unsigned";
/** The suffix of an ERC-6492 signature: a smart account signing before it is deployed. */
const ERC6492_SUFFIX = "6492".repeat(16);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COMMON_OPTIONS = ["uploadUrl", "network", "signal", "timeoutMs", "fetch"];

/** The network a service URL pays on. A URL this package does not know needs `network`. */
function resolveNetwork(uploadUrl, network) {
  const implied = uploadUrl === PRODUCTION.uploadUrl ? "base" : uploadUrl === TESTNET.uploadUrl ? "base-sepolia" : undefined;
  if (network === undefined) {
    if (implied) return implied;
    throw new TurboValidationError(`\`network\` is required for ${uploadUrl}: "base" or "base-sepolia".`);
  }
  if (!Object.hasOwn(X402_NETWORKS, network)) {
    throw new TurboValidationError(`\`network\` must be "base" or "base-sepolia", got ${JSON.stringify(network)}.`);
  }
  if (implied && network !== implied) {
    throw new TurboValidationError(`${uploadUrl} takes payment on ${implied}, not ${network}.`);
  }
  return network;
}

/**
 * A payment authorization is a bearer credential: anyone who reads it can
 * submit it. So it never travels over cleartext, loopback excepted, as
 * turbo-sdk refuses too.
 */
function assertSecure(uploadUrl) {
  let url;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new TurboValidationError(`\`uploadUrl\` is not a URL: ${JSON.stringify(uploadUrl)}.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TurboValidationError(
      `Refusing to send an x402 payment to ${uploadUrl}: it is not HTTPS, and a payment authorization ` +
        "is a bearer credential that anyone who reads it can submit.",
    );
  }
}

function checkTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TurboValidationError(`\`timeoutMs\` must be a positive number, got ${JSON.stringify(timeoutMs)}.`);
  }
}

function evmSigner(signer) {
  if (signer === null || typeof signer !== "object" || typeof signer.signTypedData !== "function") {
    throw new TurboValidationError(
      "`signer` must be an EVM signer with `address` and `signTypedData(typedData)`, such as viem's privateKeyToAccount(key).",
    );
  }
  if (typeof signer.address !== "string" || !ADDRESS.test(signer.address)) {
    throw new TurboValidationError(`\`signer.address\` must be a 0x-prefixed 20-byte hex address, got ${JSON.stringify(signer.address)}.`);
  }
  return signer;
}

const B64 = utf8Encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const PAD = 61; // "="

/** Standard base64 with padding, written as ASCII bytes into `out` at `at`. */
function base64Into(bytes, out, at) {
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[at++] = B64[n >> 18]; out[at++] = B64[(n >> 12) & 63]; out[at++] = B64[(n >> 6) & 63]; out[at++] = B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out[at++] = B64[n >> 18]; out[at++] = B64[(n >> 12) & 63];
    out[at++] = i + 1 < bytes.length ? B64[(n >> 6) & 63] : PAD; out[at++] = PAD;
  }
  return at;
}

/** Standard base64 as a string, which is what X-PAYMENT carries. */
function toBase64(bytes) {
  const out = new Uint8Array(4 * Math.ceil(bytes.length / 3));
  base64Into(bytes, out, 0);
  let s = "";
  for (const b of out) s += String.fromCharCode(b);
  return s;
}

/**
 * The route's JSON envelope, `{"data":"<base64>","tags":[...],"contentType":"..."}`,
 * as bytes, with the data encoded once, in place. The first Content-Type tag
 * becomes `contentType`; the rest go in `tags` as given. The service ignores
 * the x-data-item-tags header on this route, and X-Tag-* headers cannot carry
 * a value that is not ASCII, so this is the one form that keeps every tag.
 */
function envelope(data, tags = []) {
  const tagBytes = core.serializeTags(tags).length;
  if (tagBytes > X402_MAX_TAG_BYTES) {
    throw new TurboValidationError(
      `The tags take ${tagBytes} bytes, over the ${X402_MAX_TAG_BYTES} an x402 upload allows: the service adds its own tags, ` +
        `and an item's tags cannot exceed ${core.MAX_TAG_BYTES} bytes.`,
    );
  }
  const ct = tags.findIndex((t) => t.name.toLowerCase() === "content-type");
  const rest = tags.filter((_, i) => i !== ct).map(({ name, value }) => ({ name, value }));
  const head = utf8Encode('{"data":"');
  const tail = utf8Encode(`","tags":${JSON.stringify(rest)}${ct >= 0 ? `,"contentType":${JSON.stringify(tags[ct].value)}` : ""}}`);
  const size = head.length + 4 * Math.ceil(data.length / 3) + tail.length;
  if (size > X402_MAX_BODY_BYTES) {
    throw new TurboValidationError(
      `\`data\` is ${data.length} bytes, which makes a ${size}-byte request, over the ${X402_MAX_BODY_BYTES}-byte limit of a ` +
        `single x402 request (${X402_MAX_DATA_BYTES} bytes of data with no tags). Chunked x402 uploads need @ardrive/turbo-sdk.`,
    );
  }
  const out = new Uint8Array(size);
  out.set(head, 0);
  out.set(tail, base64Into(data, out, head.length));
  return out;
}

/**
 * Pick the one `accepts` entry this upload pays: scheme "exact", this
 * network, USDC, no more than `cap`. Anything else is refused before the
 * signer is asked for anything.
 */
function selectRequirement(body, { network, cap, endpoint }) {
  const refuse = (why) =>
    new TurboPaymentError({ status: 402, method: "POST", endpoint, body, message: `${why} Nothing was signed and nothing was paid.` });
  if (!body || typeof body !== "object" || body.x402Version !== 1 || !Array.isArray(body.accepts)) {
    return refuse(`The service at ${endpoint} answered 402 without an x402 version 1 payment request.`);
  }
  const { asset, chainId } = X402_NETWORKS[network];
  const exact = body.accepts.filter((a) => a && a.scheme === "exact");
  const onNetwork = exact.filter((a) => a.network === network);
  if (onNetwork.length === 0) {
    const offered = [...new Set(exact.map((a) => a.network))].join(", ") || "nothing";
    return refuse(`The service asks for payment on ${offered}, and this upload pays on ${network} (chain ${chainId}) only.`);
  }
  const req = onNetwork.find((a) => typeof a.asset === "string" && a.asset.toLowerCase() === asset.toLowerCase());
  if (!req) {
    return refuse(`The service asks for payment in ${onNetwork.map((a) => a.asset).join(", ")}, which is not USDC on ${network} (${asset}).`);
  }
  const amount = req.maxAmountRequired;
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) === 0n || !ADDRESS.test(req.payTo) ||
    !Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0 ||
    !req.extra || typeof req.extra.name !== "string" || typeof req.extra.version !== "string") {
    return refuse("The service's payment request has a missing or malformed maxAmountRequired, payTo, maxTimeoutSeconds or extra.");
  }
  if (BigInt(amount) > cap) {
    return refuse(`The service asks ${amount} USDC base units, more than \`maxUsdc\` (${cap}).`);
  }
  return req;
}

/** The EIP-712 typed data for one TransferWithAuthorization, as the `x402` package builds it. */
function x402TypedData({ authorization, requirement, network }) {
  return {
    domain: {
      name: requirement.extra.name,
      version: requirement.extra.version,
      chainId: X402_NETWORKS[network].chainId,
      verifyingContract: X402_NETWORKS[network].asset,
    },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION.map((f) => ({ ...f })) },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization },
  };
}

/**
 * Upload raw bytes, paid for with an x402 USDC authorization.
 *
 * The bytes are sent twice: once to be quoted (the service answers 402 with
 * its terms), once with the signed payment. The paid request is never
 * retried, so an authorization is submitted at most once.
 *
 * @param {object} options see UploadUnsignedX402Options in index.d.ts / web.d.ts
 * @param {{randomBytes: (n: number) => Uint8Array}} platform
 */
async function uploadUnsignedX402(options, platform) {
  if (options === null || typeof options !== "object") {
    throw new TurboValidationError("uploadUnsignedX402() takes an options object.");
  }
  assertKnownOptions(options, ["data", "tags", "signer", "maxUsdc", ...COMMON_OPTIONS], "uploadUnsignedX402()", TurboValidationError);
  const { data, tags, signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetch } = options;
  checkTimeout(timeoutMs);
  const uploadUrl = trimUrl(options.uploadUrl ?? PRODUCTION.uploadUrl);
  const network = resolveNetwork(uploadUrl, options.network);
  assertSecure(uploadUrl);
  if (options.maxUsdc === undefined) {
    throw new TurboValidationError("`maxUsdc` is required: the most this upload may pay, in USDC base units (6 decimals, so 50000 is 0.05 USDC).");
  }
  const cap = BigInt(integerString(options.maxUsdc, "maxUsdc", { positive: true }));
  const signer = evmSigner(options.signer);
  if (data === undefined || data === null) {
    throw new TurboValidationError("`data` is required. Pass a Uint8Array or a string.");
  }
  let body;
  try {
    body = toBytes(data);
  } catch (cause) {
    throw new TurboValidationError(`\`data\` must be a Uint8Array or a string: ${cause.message}.`, { cause });
  }
  if (body.length === 0) throw new TurboValidationError("`data` is empty. The service refuses an empty upload.");
  const requestBody = envelope(body, tags);

  const endpoint = `${uploadUrl}${ROUTE}`;
  const send = (extra, retry) =>
    request({
      url: endpoint,
      method: "POST",
      body: requestBody,
      headers: { "content-type": "application/json", ...extra },
      signal,
      timeoutMs: timeoutFor(requestBody.length, timeoutMs),
      retry,
      allowedStatuses: extra ? [] : [402],
      // A redirect would carry X-PAYMENT wherever it points, cleartext included.
      redirect: "error",
      fetch,
    });

  // Drawn before anything is sent, so a runtime with no randomness fails here.
  const nonce = `0x${toHex(platform.randomBytes(32))}`;
  const quote = await send(undefined, resolveRetryConfig(undefined));
  if (quote.status === 402) {
    const requirement = selectRequirement(quote.body, { network, cap, endpoint });
    if (requirement instanceof Error) throw requirement;
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: signer.address,
      to: requirement.payTo,
      value: requirement.maxAmountRequired,
      validAfter: String(now - 600),
      validBefore: String(now + requirement.maxTimeoutSeconds),
      nonce,
    };
    let signature;
    try {
      signature = await signer.signTypedData(x402TypedData({ authorization, requirement, network }));
    } catch (cause) {
      throw new TurboSignerError(`The signer's signTypedData failed: ${cause && cause.message ? cause.message : String(cause)}. Nothing was paid.`, { cause });
    }
    // 65 bytes from an ordinary wallet; a smart-contract wallet's can be longer.
    if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){65,}$/.test(signature)) {
      throw new TurboSignerError(
        `The signer's signTypedData returned ${typeof signature === "string" ? JSON.stringify(signature.slice(0, 20)) : typeof signature}, ` +
          "not a 0x-prefixed hex signature of at least 65 bytes. Nothing was paid.",
      );
    }
    const payment = { x402Version: 1, scheme: "exact", network, payload: { signature, authorization } };
    let paid;
    try {
      paid = await send({ "X-PAYMENT": toBase64(utf8Encode(JSON.stringify(payment))) }, resolveRetryConfig(false));
    } catch (err) {
      // An undeployed smart account signs with an ERC-6492 wrapper, which the
      // service does not verify today. Not refused before sending, so support
      // added on the service side works with no change here.
      if (err instanceof TurboPaymentError && signature.toLowerCase().endsWith(ERC6492_SUFFIX)) {
        const said = err.body && typeof err.body === "object" ? err.body.error ?? JSON.stringify(err.body) : err.body;
        throw new TurboPaymentError({
          status: err.status, statusText: err.statusText, endpoint, method: "POST", body: err.body, cause: err,
          message: `The service refused the payment (HTTP ${err.status}: ${said}). The signer is a smart account that is not ` +
            "deployed yet: its ERC-6492 signature is not accepted. Deploy the account (any first transaction does it), then pay again.",
        });
      }
      // The service also answers 402 when settling fails, which can be after the transfer was sent.
      if (err instanceof TurboNetworkError || err instanceof TurboTimeoutError || err instanceof TurboHTTPError) {
        err.message += " The payment might have settled: check the payer's USDC transfers before uploading again.";
      }
      throw err;
    }
    return result(paid, endpoint);
  }
  return result(quote, endpoint);
}

/** The service nests its signed receipt under `receipt`; lift it, as turbo-sdk does. */
function result({ status, body }, endpoint) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.id !== "string") {
    throw new TurboHTTPError({
      status, endpoint, method: "POST", body,
      message: `POST ${endpoint} answered HTTP ${status} with no data item id. If a payment was sent, it might have settled.`,
    });
  }
  return { ...(b.receipt && typeof b.receipt === "object" ? b.receipt : {}), ...b };
}

/**
 * What the unsigned route quotes for `byteCount` raw bytes:
 * GET /v1/price/x402/data/usdc-{network}/{byteCount}. An estimate: the 402
 * an upload receives is what is paid, and it can be higher.
 */
async function getUnsignedX402Price(options) {
  if (options === null || typeof options !== "object") {
    throw new TurboValidationError("getUnsignedX402Price() takes an options object.");
  }
  assertKnownOptions(options, ["byteCount", "tags", ...COMMON_OPTIONS], "getUnsignedX402Price()", TurboValidationError);
  const { byteCount, tags, signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetch } = options;
  checkTimeout(timeoutMs);
  const uploadUrl = trimUrl(options.uploadUrl ?? PRODUCTION.uploadUrl);
  const network = resolveNetwork(uploadUrl, options.network);
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) {
    throw new TurboValidationError(`\`byteCount\` must be a positive integer, got ${JSON.stringify(byteCount)}.`);
  }
  if (tags !== undefined) core.serializeTags(tags);
  const query = tags === undefined ? "" : `?tags=${tags.length}`;
  const res = await request({
    url: `${uploadUrl}/v1/price/x402/data/usdc-${network}/${byteCount}${query}`,
    signal,
    timeoutMs,
    retry: resolveRetryConfig(undefined),
    fetch,
  });
  return res.body;
}

module.exports = {
  uploadUnsignedX402,
  getUnsignedX402Price,
  X402_NETWORKS,
  X402_MAX_DATA_BYTES,
};
