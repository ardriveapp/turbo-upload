"use strict";
/**
 * TurboUpload — sign an ANS-104 data item with an Arweave JWK and upload it to
 * a Turbo upload service.
 *
 * Scope is deliberately one thing: Arweave JWK signing plus upload. No
 * multi-chain signers, no wallet connectors, no CLI, no browser build, no
 * fiat top-ups. See README for when to reach for @ardrive/turbo-sdk instead.
 */

const { Buffer } = require("node:buffer");
const ans104 = require("./ans104.js");
const { loadJwk } = require("./jwk.js");
const { request, resolveRetryConfig, DEFAULT_TIMEOUT_MS } = require("./http.js");
const { PRODUCTION, TESTNET } = require("./endpoints.js");
const { TurboConfigError, TurboValidationError, TurboVerificationError } = require("./errors.js");

/** Strip one trailing slash so `${url}/v1/tx` never doubles up. */
const trimUrl = (u) => String(u).replace(/\/+$/, "");

/**
 * Reject any option key the caller did not mean to pass.
 *
 * An ignored option is the most expensive typo this package can have, because
 * nothing in the return value says it happened. `uploadServiceUrl` instead of
 * `uploadUrl` leaves the client on PRODUCTION, so data meant for a throwaway
 * testnet is written permanently and billed for. `tag` instead of `tags`
 * uploads an item that no tag query will ever find again.
 *
 * Both were real. The second cost an hour of debugging a service that looked
 * healthy, and the first was found by a probe that reported testnet failing
 * when it had never been talking to testnet.
 *
 * @param {object} options    the object the caller passed
 * @param {string[]} allowed  every key this call accepts
 * @param {string} context    what to call the offending call in the message
 * @param {Function} ErrorClass
 */
function assertKnownOptions(options, allowed, context, ErrorClass) {
  const unknown = Object.keys(options).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  // Suggest on a shared prefix. It catches the two shapes that actually happen,
  // a longer name for the same thing (uploadServiceUrl) and a dropped plural
  // (tag), without pretending to be a spell checker.
  const suggestion = (key) => {
    const lower = key.toLowerCase();
    const hit = allowed.find((candidate) => {
      const other = candidate.toLowerCase();
      let i = 0;
      while (i < other.length && i < lower.length && other[i] === lower[i]) i++;
      return i >= 3;
    });
    return hit ? ` (did you mean \`${hit}\`?)` : "";
  };
  throw new ErrorClass(
    `${context}: unknown option${unknown.length > 1 ? "s" : ""} ` +
      unknown.map((k) => `\`${k}\`${suggestion(k)}`).join(", ") +
      `. Accepted: ${allowed.join(", ")}.`,
  );
}

class TurboUpload {
  /**
   * @param {object} options
   * @param {object|string} options.jwk Arweave JWK, as an object or a JSON string
   * @param {string} [options.uploadUrl]  default https://upload.ardrive.io
   * @param {string} [options.paymentUrl] default https://payment.ardrive.io
   * @param {number} [options.timeoutMs]  default 60000, per request
   * @param {object|false} [options.retry] partial retry config; merged over defaults
   * @param {string} [options.token] must be "arweave" (validated, not ignored)
   * @param {typeof fetch} [options.fetch] injectable for tests/proxies
   */
  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TurboConfigError(`TurboUpload options must be an object, got ${typeof options}.`);
    }
    assertKnownOptions(
      options,
      ["jwk", "uploadUrl", "paymentUrl", "timeoutMs", "retry", "token", "fetch"],
      "new TurboUpload",
      TurboConfigError,
    );
    const {
      jwk,
      uploadUrl = PRODUCTION.uploadUrl,
      paymentUrl = PRODUCTION.paymentUrl,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retry,
      token = "arweave",
      fetch: fetchImpl,
    } = options;

    // Validate everything NOW. A bad key or a typo'd option is a startup
    // failure, not a mystery at the first upload.
    const loaded = loadJwk(jwk, { token });
    this.jwk = loaded.jwk;
    this.owner = loaded.owner;
    /** The Arweave wallet address: base64url(SHA-256(owner)). */
    this.address = loaded.address;
    this.privateKey = loaded.privateKey;

    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TurboConfigError(`\`timeoutMs\` must be a positive number, got ${JSON.stringify(timeoutMs)}.`);
    }
    this.timeoutMs = timeoutMs;
    this.retry = resolveRetryConfig(retry);
    this.uploadUrl = trimUrl(uploadUrl);
    this.paymentUrl = trimUrl(paymentUrl);
    this.token = token;
    this.fetch = fetchImpl;
  }

  /** A client pointed at the testnet services. Uploads there are not permanent. */
  static testnet(options = {}) {
    // The endpoint record also carries `name` and `gatewayUrl`, which are not
    // client options. Pick the two that are, rather than spreading the record,
    // so a field added to it later cannot break this call.
    const { uploadUrl, paymentUrl } = TESTNET;
    return new TurboUpload({ uploadUrl, paymentUrl, ...options });
  }

  /** A client pointed at production. Uploads are permanent and cost real money. */
  static production(options = {}) {
    const { uploadUrl, paymentUrl } = PRODUCTION;
    return new TurboUpload({ uploadUrl, paymentUrl, ...options });
  }

  /** @private */
  async _request(base, path, opts = {}) {
    // Spread `opts` FIRST. Spreading it last lets an explicitly-undefined
    // `timeoutMs` (which every caller here passes, via destructuring) overwrite
    // the resolved value, so the client's configured timeout is silently
    // ignored and the transport default applies instead. Pinned by the
    // "a hung endpoint aborts" test in test/client.test.js.
    return request({
      ...opts,
      url: `${base}${path}`,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      fetch: this.fetch,
    });
  }

  /**
   * Sign a data item locally without uploading it.
   *
   * Useful when you want to inspect, store or verify the bytes first, or upload
   * them through your own transport.
   *
   * @param {object} opts
   * @param {Buffer|Uint8Array|string} opts.data
   * @param {Array<{name:string,value:string}>} [opts.tags]
   * @param {string|Buffer} [opts.target] base64url, decodes to 32 bytes
   * @param {string|Buffer} [opts.anchor] 32 RAW bytes (NOT base64url)
   * @returns {{binary: Buffer, id: Buffer, idB64Url: string, signature: Buffer}}
   */
  sign(options = {}) {
    assertKnownOptions(options, ["data", "tags", "target", "anchor"], "sign()", TurboValidationError);
    const { data, tags, target, anchor } = options;
    if (data === undefined || data === null) {
      throw new TurboValidationError("`data` is required. Pass a Buffer, Uint8Array or string.");
    }
    return ans104.signDataItem(this.jwk, {
      data,
      tags,
      target,
      anchor,
      owner: this.owner,
      privateKey: this.privateKey,
    });
  }

  /**
   * Sign and upload a data item.
   *
   * The id returned by the service is checked against the id computed locally
   * from our own signature. A mismatch means the item was mutated in flight or
   * the endpoint is not a Turbo upload service; it throws rather than returning
   * an id you did not produce.
   *
   * @param {object} opts
   * @param {Buffer|Uint8Array|string} opts.data
   * @param {Array<{name:string,value:string}>} [opts.tags]
   * @param {string|Buffer} [opts.target]
   * @param {string|Buffer} [opts.anchor]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs] overrides the client default for this call
   * @returns {Promise<object>} the service response, plus `id`, `winc` and `byteCount`
   */
  async upload(options = {}) {
    assertKnownOptions(
      options,
      ["data", "tags", "target", "anchor", "signal", "timeoutMs"],
      "upload()",
      TurboValidationError,
    );
    const { data, tags, target, anchor, signal, timeoutMs } = options;
    const item = this.sign({ data, tags, target, anchor });
    return this.uploadSigned(item, { signal, timeoutMs });
  }

  /**
   * Upload an item that has ALREADY been signed by `sign()`.
   *
   * Use this whenever you need the id before the upload — to record it, to
   * check the price of the real item length, or to hand the bytes to your own
   * transport and upload later.
   *
   * This is not a convenience wrapper, it is the only correct way to do
   * sign-then-upload: RSA-PSS draws a fresh random salt per signature, so
   * calling `sign()` and then `upload()` signs the payload TWICE and produces
   * TWO DIFFERENT IDS. The id you printed would not be the id that landed.
   *
   * @param {{binary: Buffer}|Buffer|Uint8Array} item a SignedDataItem or its raw bytes
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<object>}
   */
  async uploadSigned(item, options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "uploadSigned()", TurboValidationError);
    const { signal, timeoutMs } = options;
    const binary = Buffer.isBuffer(item)
      ? item
      : ArrayBuffer.isView(item)
        ? Buffer.from(item.buffer, item.byteOffset, item.byteLength)
        : Buffer.isBuffer(item?.binary)
          ? item.binary
          : null;
    if (!binary) {
      throw new TurboValidationError(
        "`uploadSigned` expects the result of `sign()`, or the raw signed item bytes.",
      );
    }

    let parsed;
    try {
      parsed = ans104.parseDataItem(binary);
    } catch (cause) {
      throw new TurboValidationError(`Not a parseable ANS-104 data item: ${cause.message}`, { cause });
    }
    // Cheap guard against POSTing an unsigned skeleton, which the service would
    // reject with an opaque error much further away from the mistake.
    if (parsed.rawSignature.every((b) => b === 0)) {
      throw new TurboValidationError("This data item is not signed — its signature region is all zeroes.");
    }

    const expectedId = ans104.idFromSignature(parsed.rawSignature).toString("base64url");
    const endpoint = `${this.uploadUrl}/v1/tx`;

    const res = await this._request(this.uploadUrl, "/v1/tx", {
      method: "POST",
      body: binary,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(binary.length),
      },
      signal,
      timeoutMs,
    });

    const body = res.body && typeof res.body === "object" ? res.body : {};
    if (body.id && body.id !== expectedId) {
      throw new TurboVerificationError(
        `The upload service returned id "${body.id}" but the item we sent has id "${expectedId}". ` +
          `The item was altered in flight, or this endpoint is not a Turbo upload service.`,
        { expectedId, receivedId: body.id, endpoint },
      );
    }

    return {
      ...body,
      id: expectedId,
      owner: ans104.addressFromOwner(parsed.rawOwner),
      byteCount: binary.length,
      winc: body.winc,
    };
  }

  /**
   * Price, in winston credits (winc), to upload `bytes` bytes.
   *
   * Note this is the price for the RAW BYTE COUNT you pass. A signed data item
   * is ~1044 bytes larger than its payload, so price your item length, not your
   * payload length, if you want the real figure: `client.sign(...)` then
   * `getUploadCost(item.binary.length)`.
   *
   * @param {number} bytes
   * @returns {Promise<{winc: string, adjustments: Array}>}
   */
  async getUploadCost(bytes, options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getUploadCost()", TurboValidationError);
    const { signal, timeoutMs } = options;
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new TurboValidationError(`\`bytes\` must be a non-negative integer, got ${JSON.stringify(bytes)}.`);
    }
    const res = await this._request(this.paymentUrl, `/v1/price/bytes/${bytes}`, { signal, timeoutMs });
    return res.body;
  }

  /**
   * The wallet's Turbo credit balance.
   *
   * A wallet the payment service has never seen returns 404 "User Not Found".
   * That is a zero balance, not an error, so it is normalised to zeros here —
   * a brand-new wallet asking its balance should not throw.
   *
   * @returns {Promise<{winc: string, controlledWinc: string, effectiveBalance: string}>}
   */
  async getBalance(options = {}) {
    assertKnownOptions(options, ["address", "signal", "timeoutMs"], "getBalance()", TurboValidationError);
    const { address = this.address, signal, timeoutMs } = options;
    const res = await this._request(
      this.paymentUrl,
      `/v1/account/balance/${this.token}?address=${encodeURIComponent(address)}`,
      { signal, timeoutMs, allowedStatuses: [404] },
    );
    const body = res.body && typeof res.body === "object" ? res.body : {};
    if (res.status === 404 || body.winc === undefined) {
      return { winc: "0", controlledWinc: "0", effectiveBalance: "0", address };
    }
    return { ...body, address };
  }

  /**
   * The upload service's own /v1/info.
   *
   * This is where `freeUploadLimitBytes` comes from. It is a service policy
   * number (107520 at the time of writing) and it is NOT hardcoded here on
   * purpose — read it if you need to branch on it.
   *
   * @returns {Promise<object>}
   */
  async getInfo(options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getInfo()", TurboValidationError);
    const { signal, timeoutMs } = options;
    const res = await this._request(this.uploadUrl, "/v1/info", { signal, timeoutMs });
    return res.body;
  }

  /**
   * The current free-upload threshold in bytes, read from /v1/info.
   * Items at or below this size upload without any credit balance.
   */
  async getFreeUploadLimitBytes(opts = {}) {
    assertKnownOptions(opts, ["signal", "timeoutMs"], "getFreeUploadLimitBytes()", TurboValidationError);
    const info = await this.getInfo(opts);
    const limit = info?.freeUploadLimitBytes;
    if (typeof limit !== "number") {
      throw new TurboValidationError(
        `The upload service at ${this.uploadUrl} did not report freeUploadLimitBytes in /v1/info.`,
      );
    }
    return limit;
  }

  /** Verify a serialized data item. Pass `{strictSaltLength:true}` to also pin the PSS salt length. */
  verify(binary, opts = {}) {
    assertKnownOptions(opts, ["strictSaltLength"], "verify()", TurboValidationError);
    return ans104.verifyDataItem(Buffer.isBuffer(binary) ? binary : Buffer.from(binary), opts);
  }
}

module.exports = { TurboUpload };
