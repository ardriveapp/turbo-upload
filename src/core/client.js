"use strict";
/**
 * The client both builds share: options, signing through a wallet-style
 * signer, upload, and the service calls.
 *
 * What differs between Node and the browser is passed in as a `platform`:
 * which keys it can hold, how it hashes, and what type it hands bytes back as
 * (Node: Buffer, exactly as before the web build existed; web: Uint8Array).
 * The Node build is src/client.js, the web build src/web/client.js.
 */

const core = require("./ans104.js");
const { toBytes, toBase64Url } = require("./bytes.js");
const { encodeBase58 } = require("./base58.js");
const { request, resolveRetryConfig, DEFAULT_TIMEOUT_MS } = require("./http.js");
const { PRODUCTION, TESTNET } = require("./endpoints.js");
const { normalizeSigner, signWithWallet } = require("./signer.js");
const payment = require("./payment.js");
const chunked = require("./chunked.js");
const {
  TurboConfigError,
  TurboValidationError,
  TurboVerificationError,
} = require("./errors.js");

/** Options every upload call takes on top of its own. */
const TRANSFER_OPTIONS = ["signal", "timeoutMs", "paidBy", "chunking", "chunkSize", "chunkConcurrency", "onProgress"];

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

/**
 * `paidBy` is ONE address. The upload service refuses a comma-joined list with
 * a 402 whichever order it is in (probed on devnet), although turbo-sdk's types
 * allow an array, so a list is refused here, before anything is signed.
 */
function checkPaidBy(paidBy) {
  if (paidBy === undefined) return undefined;
  if (Array.isArray(paidBy)) {
    throw new TurboValidationError(
      "`paidBy` takes one address, not a list. The upload service refuses a list of payers with a 402.",
    );
  }
  if (typeof paidBy !== "string" || paidBy.trim() === "" || /[\s,]/.test(paidBy)) {
    throw new TurboValidationError(
      `\`paidBy\` must be one address as a string, got ${JSON.stringify(paidBy)}.`,
    );
  }
  return paidBy;
}

/** A stream read twice must give the same bytes twice: the signature covers the first read. */
function assertSameStream(first, second) {
  const same = second && second.length === first.length &&
    second.digest.length === first.digest.length && second.digest.every((b, i) => b === first.digest[i]);
  if (!same) {
    throw new TurboValidationError(
      "streamFactory produced different bytes the second time it was called. The item was signed over the " +
        "first read, so it is not uploaded: nothing is finalized and nothing is charged.",
    );
  }
}

/** The options every constructor accepts. `signer` is last so the error message's list keeps its old prefix. */
const CONSTRUCTOR_OPTIONS = ["jwk", "uploadUrl", "paymentUrl", "timeoutMs", "retry", "token", "fetch", "signer"];
const SIGN_OPTIONS = ["data", "tags", "target", "anchor"];

class TurboUploadCore {
  /**
   * @param {object} options see TurboUploadOptions in index.d.ts / web.d.ts
   * @param {object} platform what the build provides; see src/client.js and src/web/client.js
   */
  constructor(options, platform) {
    if (options === null || typeof options !== "object") {
      throw new TurboConfigError(`TurboUpload options must be an object, got ${typeof options}.`);
    }
    assertKnownOptions(options, CONSTRUCTOR_OPTIONS, "new TurboUpload", TurboConfigError);
    Object.defineProperty(this, "_platform", { value: platform });

    const {
      jwk,
      signer,
      uploadUrl = PRODUCTION.uploadUrl,
      paymentUrl = PRODUCTION.paymentUrl,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retry,
      fetch: fetchImpl,
    } = options;

    // Validate everything NOW. A bad key or a typo'd option is a startup
    // failure, not a mystery at the first upload.
    if (signer !== undefined && signer !== null) {
      if (jwk !== undefined && jwk !== null) {
        throw new TurboConfigError("Pass `jwk` or `signer`, not both: they are two ways to sign.");
      }
      const token = options.token ?? "solana";
      if (token !== "solana") {
        throw new TurboConfigError(
          `A \`signer\` signs Solana data items (ANS-104 type 4), so \`token\` must be "solana", got ${JSON.stringify(token)}.`,
        );
      }
      const wallet = normalizeSigner(signer);
      Object.defineProperty(this, "_walletSigner", { value: wallet });
      this.owner = platform.output(wallet.publicKey);
      this.address = encodeBase58(wallet.publicKey);
      this.signatureType = core.SIG_TYPE_SOLANA;
      this.#finish({ timeoutMs, retry, uploadUrl, paymentUrl, token, fetchImpl });
      return;
    }

    // A raw key. The platform owns key formats: Node holds Arweave JWKs and
    // Solana keys, and the web build refuses both, because a raw key does not
    // belong in a browser page.
    const token = options.token ?? "arweave";
    const key = platform.loadKey(jwk, token);
    Object.assign(this, key.fields);
    this.owner = key.owner;
    this.address = key.address;
    this.signatureType = key.signatureType;
    this.#finish({ timeoutMs, retry, uploadUrl, paymentUrl, token, fetchImpl });
  }

  /** Shared tail of the constructor, so the key paths cannot drift. */
  #finish({ timeoutMs, retry, uploadUrl, paymentUrl, token, fetchImpl }) {
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
    return new this({ uploadUrl, paymentUrl, ...options });
  }

  /** A client pointed at production. Uploads are permanent and cost real money. */
  static production(options = {}) {
    const { uploadUrl, paymentUrl } = PRODUCTION;
    return new this({ uploadUrl, paymentUrl, ...options });
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

  /** True when this client holds a key and can sign without awaiting anything. */
  get _signsSync() {
    return !this._walletSigner && typeof this._platform.signSync === "function";
  }

  /**
   * Sign a data item locally without uploading it. Synchronous, so it needs a
   * key this client holds; a client built with `signer` uses signAsync().
   *
   * @returns {{binary, id, idB64Url, signature, signatureData}}
   */
  sign(options = {}) {
    assertKnownOptions(options, SIGN_OPTIONS, "sign()", TurboValidationError);
    if (!this._signsSync) {
      throw new TurboConfigError(
        "sign() is synchronous, and this client signs through `signer`, which is not. " +
          "Use `await client.signAsync(...)`; it returns the same thing.",
      );
    }
    const { data, tags, target, anchor } = options;
    if (data === undefined || data === null) {
      throw new TurboValidationError("`data` is required. Pass a Buffer, Uint8Array or string.");
    }
    return this._platform.signSync(this, { data, tags, target, anchor });
  }

  /**
   * Sign a data item, through whichever signer this client has.
   *
   * With a key this is sign(), wrapped in a promise. With a wallet-style
   * signer, `signMessage` is called once, its signature is verified, and only
   * then is the item stamped. A signature that does not verify throws
   * TurboSignerError; nothing is returned that could be uploaded.
   */
  async signAsync(options = {}) {
    assertKnownOptions(options, SIGN_OPTIONS, "signAsync()", TurboValidationError);
    if (this._signsSync) return this.sign(options);
    const { data, tags, target, anchor } = options;
    if (data === undefined || data === null) {
      throw new TurboValidationError("`data` is required. Pass a Buffer, Uint8Array or string.");
    }
    const p = this._platform;
    const binary = p.createDataItem({ data, tags, target, anchor, owner: this._walletSigner.publicKey, signatureType: this.signatureType });
    const signatureData = p.getSignatureData(binary);
    const signature = await signWithWallet(this._walletSigner, signatureData, p.verifyEd25519Raw);
    binary.set(signature, 2);
    const id = p.hashes.sha256(signature);
    return {
      binary,
      signature: p.output(signature),
      id: p.output(id),
      idB64Url: toBase64Url(id),
      signatureData: p.output(signatureData),
    };
  }

  /**
   * The size in bytes of the signed item these options would produce, for this
   * client's signature type. Price this, not the payload length.
   *
   * @param {{dataSize?: number, data?: Uint8Array|string, tags?, target?, anchor?}} options
   */
  getDataItemSize(options = {}) {
    assertKnownOptions(options, ["data", "dataSize", "tags", "target", "anchor"], "getDataItemSize()", TurboValidationError);
    const { data, dataSize, tags, target, anchor } = options;
    if ((data === undefined) === (dataSize === undefined)) {
      throw new TurboValidationError("getDataItemSize() takes exactly one of `data` or `dataSize`.");
    }
    const size = data !== undefined ? toBytes(data).length : dataSize;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TurboValidationError(`\`dataSize\` must be a non-negative integer, got ${JSON.stringify(dataSize)}.`);
    }
    // Building the header validates target, anchor and tags exactly as signing
    // would, so a size is never returned for an item that cannot be made.
    const header = this._platform.createDataItem({
      tags, target, anchor, owner: this.owner, signatureType: this.signatureType,
    });
    return header.length + size;
  }

  /**
   * Sign and upload a data item.
   *
   * The id returned by the service is checked against the id computed locally
   * from our own signature. A mismatch means the item was mutated in flight or
   * the endpoint is not a Turbo upload service; it throws rather than returning
   * an id you did not produce.
   */
  async upload(options = {}) {
    assertKnownOptions(options, [...SIGN_OPTIONS, ...TRANSFER_OPTIONS], "upload()", TurboValidationError);
    const { data, tags, target, anchor, ...transfer } = options;
    // Checked before signing, so a wallet is never asked to sign an item that
    // is then refused for a malformed option.
    checkPaidBy(transfer.paidBy);
    chunked.chunkingOptions(transfer);
    const item = this._signsSync
      ? this.sign({ data, tags, target, anchor })
      : await this.signAsync({ data, tags, target, anchor });
    return this.uploadSigned(item, transfer);
  }

  /**
   * Upload an item that has ALREADY been signed by `sign()` or `signAsync()`.
   *
   * This is not a convenience wrapper, it is the only correct way to do
   * sign-then-upload: RSA-PSS draws a fresh random salt per signature, so
   * calling `sign()` and then `upload()` signs the payload TWICE and produces
   * TWO DIFFERENT IDS. The id you printed would not be the id that landed.
   *
   * @param {{binary: Uint8Array}|Uint8Array} item a SignedDataItem or its raw bytes
   * @param {{signal?: AbortSignal, timeoutMs?: number, paidBy?: string}} [options]
   */
  async uploadSigned(item, options = {}) {
    assertKnownOptions(options, TRANSFER_OPTIONS, "uploadSigned()", TurboValidationError);
    const { signal, timeoutMs } = options;
    const paidBy = checkPaidBy(options.paidBy);
    const chunking = chunked.chunkingOptions(options);
    const raw =
      item instanceof Uint8Array || ArrayBuffer.isView(item)
        ? item
        : item && (item.binary instanceof Uint8Array)
          ? item.binary
          : null;
    if (!raw) {
      throw new TurboValidationError(
        "`uploadSigned` expects the result of `sign()`, or the raw signed item bytes.",
      );
    }
    const binary = this._platform.output(toBytes(raw));

    let parsed;
    try {
      parsed = core.parseDataItem(binary);
    } catch (cause) {
      throw new TurboValidationError(`Not a parseable ANS-104 data item: ${cause.message}`, { cause });
    }
    // Cheap guard against POSTing an unsigned skeleton, which the service would
    // reject with an opaque error much further away from the mistake.
    if (parsed.rawSignature.every((b) => b === 0)) {
      throw new TurboValidationError("This data item is not signed, its signature region is all zeroes.");
    }

    const expectedId = toBase64Url(this._platform.hashes.sha256(parsed.rawSignature));
    const owner = toBase64Url(this._platform.hashes.sha256(parsed.rawOwner));
    const transfer = { expectedId, owner, paidBy, signal, timeoutMs, ...chunking };

    if (chunked.shouldChunk(binary.length, chunking, this._singleItemLimit)) {
      return this.#chunkedResult(binary, binary.length, transfer);
    }
    try {
      return await this.#postSingle(binary, transfer);
    } catch (err) {
      // An item over the service's single-item limit is refused with a 400
      // that states the limit. Remember it for this client and send the item
      // in chunks instead, unless the caller turned chunking off.
      const limit = chunked.singleItemLimitFrom(err);
      if (limit === undefined || chunking.chunking === "disabled") throw err;
      this._singleItemLimit = limit;
      return this.#chunkedResult(binary, binary.length, transfer);
    }
  }

  /** One POST to /v1/tx, the way every version of this package has sent an item. */
  async #postSingle(binary, { expectedId, owner, paidBy, signal, timeoutMs, onProgress }) {
    const endpoint = `${this.uploadUrl}/v1/tx`;
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(binary.length),
    };
    if (paidBy) headers["x-paid-by"] = paidBy;

    const res = await this._request(this.uploadUrl, "/v1/tx", {
      method: "POST",
      body: binary,
      headers,
      signal,
      // Sized from the byte count, so a large item on a slow link is not cut
      // off by a timeout meant for a small one. Unchanged for anything under
      // 7.5 MiB at the default 60 s.
      timeoutMs: chunked.timeoutFor(binary.length, timeoutMs ?? this.timeoutMs),
    });

    const body = res.body && typeof res.body === "object" ? res.body : {};
    if (body.id && body.id !== expectedId) {
      throw new TurboVerificationError(
        `The upload service returned id "${body.id}" but the item we sent has id "${expectedId}". ` +
          `The item was altered in flight, or this endpoint is not a Turbo upload service.`,
        { expectedId, receivedId: body.id, endpoint },
      );
    }
    if (onProgress) onProgress({ processedBytes: binary.length, totalBytes: binary.length });
    return { ...body, id: expectedId, owner, byteCount: binary.length, winc: body.winc };
  }

  /** A chunked upload, returned in the same shape as a single POST. */
  async #chunkedResult(source, byteCount, { expectedId, owner, paidBy, signal, timeoutMs, chunkSize, chunkConcurrency, onProgress, beforeFinalize }) {
    const receipt = await chunked.uploadChunked(this, {
      source, byteCount, expectedId, paidBy, signal, timeoutMs, chunkSize, chunkConcurrency, onProgress, beforeFinalize,
    });
    return { ...receipt, id: expectedId, owner, byteCount, winc: receipt.winc };
  }

  /**
   * Sign and upload data read from a stream, without holding it in memory.
   *
   * `streamFactory` is called TWICE and must give the same bytes both times:
   * once to hash the data for the signature, once to send it. A Node stream,
   * a web ReadableStream or any async iterable of bytes works. The second
   * pass is hashed too, and if it differs from the first the upload is
   * abandoned before it is finalized, so no item with a bad signature is paid
   * for.
   *
   * Items over two chunks go chunked; smaller ones are read into memory and
   * sent in one POST, as upload() does.
   */
  async uploadStream(options = {}) {
    assertKnownOptions(options, ["streamFactory", "size", "tags", "target", "anchor", ...TRANSFER_OPTIONS], "uploadStream()", TurboValidationError);
    const { streamFactory, size, tags, target, anchor, signal, timeoutMs } = options;
    if (typeof streamFactory !== "function") {
      throw new TurboValidationError("`streamFactory` must be a function that returns a new stream of the data each time it is called.");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TurboValidationError(`\`size\` must be the data's length in bytes, got ${JSON.stringify(size)}.`);
    }
    const paidBy = checkPaidBy(options.paidBy);
    const chunking = chunked.chunkingOptions(options);
    const p = this._platform;

    // The header carries no data, so it is small; the data follows it as is.
    const header = p.createDataItem({ tags, target, anchor, owner: this.owner, signatureType: this.signatureType });
    const fields = core.parseDataItem(header);

    const hashData = async (source, onPiece) => {
      const h = p.hashes.createSha384();
      let n = 0;
      for await (const piece of chunked.iterate(source)) {
        if (!(piece instanceof Uint8Array)) throw new TurboValidationError("The stream produced something other than bytes.");
        h.update(piece);
        n += piece.length;
        if (onPiece) onPiece(piece);
      }
      return { digest: toBytes(h.digest()), length: n };
    };

    const first = await hashData(streamFactory());
    if (first.length !== size) {
      throw new TurboValidationError(`\`size\` is ${size}, but the stream produced ${first.length} bytes.`);
    }
    const signatureData = core.deepHash(
      core.signatureDataChunks({ ...fields, data: { byteLength: size, sha384: first.digest } }),
      p.hashes,
    );
    const signature = this._signsSync
      ? p.signSignatureData(this, signatureData)
      : await signWithWallet(this._walletSigner, signatureData, p.verifyEd25519Raw);
    header.set(signature, 2);
    const expectedId = toBase64Url(p.hashes.sha256(signature));
    const owner = toBase64Url(p.hashes.sha256(fields.rawOwner));
    const byteCount = header.length + size;

    if (!chunked.shouldChunk(byteCount, chunking, this._singleItemLimit)) {
      const parts = [header];
      const second = await hashData(streamFactory(), (piece) => parts.push(Uint8Array.from(piece)));
      assertSameStream(first, second);
      const binary = new Uint8Array(byteCount);
      let pos = 0;
      for (const part of parts) {
        binary.set(part, pos);
        pos += part.length;
      }
      return this.uploadSigned(p.output(binary), { paidBy, signal, timeoutMs, ...chunking, chunking: "disabled" });
    }

    // The second read is hashed as it is sent. It is pulled chunk by chunk as
    // the upload has room, so no more than `chunkConcurrency` chunks are held.
    const second = { hash: p.hashes.createSha384(), length: 0 };
    async function* itemBytes() {
      yield header;
      for await (const piece of chunked.iterate(streamFactory())) {
        if (!(piece instanceof Uint8Array)) throw new TurboValidationError("The stream produced something other than bytes.");
        second.hash.update(piece);
        second.length += piece.length;
        yield piece;
      }
    }
    return this.#chunkedResult(itemBytes(), byteCount, {
      expectedId, owner, paidBy, signal, timeoutMs, ...chunking,
      beforeFinalize: () => assertSameStream(first, { length: second.length, digest: toBytes(second.hash.digest()) }),
    });
  }

  /**
   * Price, in winston credits (winc), to upload `bytes` bytes.
   *
   * This is the price for the RAW BYTE COUNT you pass. Price the signed item's
   * length, from `getDataItemSize()` or `item.binary.length`, not the payload's.
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
   * That is a zero balance, not an error, so it is normalised to zeros here:
   * a brand-new wallet asking its balance should not throw.
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
   * This is where `freeUploadLimitBytes` and `freeTier` come from. They are
   * service policy and NOT hardcoded here on purpose: read them if you need to
   * branch on them.
   */
  async getInfo(options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getInfo()", TurboValidationError);
    const { signal, timeoutMs } = options;
    const res = await this._request(this.uploadUrl, "/v1/info", { signal, timeoutMs });
    return res.body;
  }

  /**
   * The current free-upload threshold in bytes, read from /v1/info.
   * Items at or below this size upload without any credit balance, while the
   * signer's free quota lasts (see getFreeQuota()).
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
  /* ---------------------------- payments ---------------------------- */

  /**
   * What `tokenAmount` base units of this client's token buy, in winc, after
   * the service's fees: GET /v1/price/{token}/{amount}. For Solana the unit is
   * the lamport, so 1 SOL is 1_000_000_000.
   *
   * @returns {Promise<{winc: string, fees: Array, actualTokenAmount: string, equivalentWincTokenAmount: string}>}
   */
  async getWincForToken(tokenAmount, options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getWincForToken()", TurboValidationError);
    const amount = payment.integerString(tokenAmount, "tokenAmount");
    const { signal, timeoutMs } = options;
    const res = await this._request(this.paymentUrl, `/v1/price/${this.token}/${amount}`, { signal, timeoutMs });
    return payment.wincForTokenResult(res.body, amount);
  }

  /** The payment service's own /v1/info: the funding addresses per token, among other things. */
  async getPaymentInfo(options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getPaymentInfo()", TurboValidationError);
    const { signal, timeoutMs } = options;
    const res = await this._request(this.paymentUrl, "/v1/info", { signal, timeoutMs });
    return res.body;
  }

  /**
   * The address a top-up for this client's token is sent to, read from the
   * payment service every time rather than kept here: it is the service's to
   * change, and a stale address is money sent to the wrong place.
   */
  async getFundingAddress(options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "getFundingAddress()", TurboValidationError);
    const info = await this.getPaymentInfo(options);
    const address = info && info.addresses && info.addresses[this.token];
    if (typeof address !== "string" || address === "") {
      throw new TurboValidationError(`The payment service at ${this.paymentUrl} reports no funding address for token "${this.token}".`);
    }
    return address;
  }

  /**
   * How many free-tier bytes an address has left: GET /v1/account/free.
   *
   * The free tier is a QUOTA that belongs to the address that SIGNS an item,
   * not to the one that pays for it with `paidBy`, and it is service policy:
   * read it, never assume it. `bytesRemaining` is null when the service
   * reports no limit for the address. There is also a per-IP quota, which no
   * endpoint reports.
   *
   * @returns {Promise<{bytesRemaining: number|null, address: string}>}
   */
  async getFreeQuota(options = {}) {
    assertKnownOptions(options, ["address", "signal", "timeoutMs"], "getFreeQuota()", TurboValidationError);
    const { address = this.address, signal, timeoutMs } = options;
    payment.addressString(address, "address");
    const res = await this._request(this.paymentUrl, `/v1/account/free?address=${encodeURIComponent(address)}`, {
      signal,
      timeoutMs,
      allowedStatuses: [404],
    });
    const body = res.body && typeof res.body === "object" ? res.body : {};
    return { bytesRemaining: body.bytesRemaining ?? null, address };
  }

  /**
   * Tell the payment service about a top-up transaction you have already sent
   * to the funding address: POST /v1/account/balance/{token}.
   *
   * This package does not build or send the transfer: your wallet or RPC
   * library does, to `getFundingAddress()`, optionally with the memo
   * `turboCreditDestinationAddress=<address>` to credit another address. Wait
   * until the transaction is `finalized` before submitting it.
   *
   * The answer is `status` "confirmed" (credited), "pending" (the service has
   * not seen it yet and keeps checking: submit again later) or "failed".
   * Submitting the same id again is safe: the service answers that it is
   * already credited and credits nothing twice.
   */
  async submitFundTransaction(txId, options = {}) {
    assertKnownOptions(options, ["signal", "timeoutMs"], "submitFundTransaction()", TurboValidationError);
    const body = payment.fundTransactionBody(txId);
    const { signal, timeoutMs } = options;
    const res = await this._request(this.paymentUrl, `/v1/account/balance/${this.token}`, {
      method: "POST",
      body,
      signal,
      timeoutMs,
    });
    return payment.fundTransactionResult(res.status, res.body, txId);
  }

  /**
   * Let another address spend up to `approvedWincAmount` of this client's
   * credits, by uploading an approval data item that this client signs.
   * The approved address then uploads with `paidBy: client.address`.
   *
   * The unused part of an approval returns when it expires
   * (`expiresBySeconds`). The approval is itself a data item, so a wallet
   * signer is asked to sign once.
   *
   * @returns {Promise<object>} the service's `createdApproval`
   */
  async shareCredits(options = {}) {
    assertKnownOptions(
      options,
      ["approvedAddress", "approvedWincAmount", "expiresBySeconds", "signal", "timeoutMs"],
      "shareCredits()",
      TurboValidationError,
    );
    const approvedAddress = payment.addressString(options.approvedAddress, "approvedAddress");
    const approvedWincAmount = payment.integerString(options.approvedWincAmount, "approvedWincAmount", { positive: true });
    const { expiresBySeconds, signal, timeoutMs } = options;
    if (expiresBySeconds !== undefined && (!Number.isSafeInteger(expiresBySeconds) || expiresBySeconds <= 0)) {
      throw new TurboValidationError(`\`expiresBySeconds\` must be a positive integer, got ${JSON.stringify(expiresBySeconds)}.`);
    }
    // The data is a nonce, as turbo-sdk writes it: two approvals for the same
    // address and amount must still be two different items.
    const data = approvedAddress + approvedWincAmount + Date.now();
    const tags = payment.shareCreditsTags({ approvedAddress, approvedWincAmount, expiresBySeconds });
    const item = await this.signAsync({ data, tags });
    const res = await this.uploadSigned(item, { signal, timeoutMs });
    if (!res.createdApproval) {
      throw new TurboValidationError(
        `The approval item ${res.id} was uploaded, but the service reported no createdApproval for it.`,
      );
    }
    return res.createdApproval;
  }

  /**
   * A Stripe checkout session that buys credits for `owner` (this client's
   * address unless given): GET /v1/top-up/checkout-session/{owner}/{currency}/{amount}.
   *
   * `amount` is in the currency's smallest unit: cents for "usd", so 1000 is
   * $10.00. Open `url` to pay. The testnet payment service answers with a
   * Stripe test-mode session, which a test card completes.
   */
  async createCheckoutSession(options = {}) {
    assertKnownOptions(
      options,
      ["amount", "currency", "owner", "uiMode", "promoCodes", "successUrl", "cancelUrl", "returnUrl", "signal", "timeoutMs"],
      "createCheckoutSession()",
      TurboValidationError,
    );
    const { currency = "usd", owner = this.address, uiMode = "hosted", promoCodes = [], successUrl, cancelUrl, returnUrl, signal, timeoutMs } = options;
    const amount = payment.integerString(options.amount, "amount", { positive: true });
    if (typeof currency !== "string" || !/^[a-z]{3}$/i.test(currency)) {
      throw new TurboValidationError(`\`currency\` must be a three-letter currency code such as "usd", got ${JSON.stringify(currency)}.`);
    }
    payment.addressString(owner, "owner");
    if (!["hosted", "embedded"].includes(uiMode)) {
      throw new TurboValidationError(`\`uiMode\` must be "hosted" or "embedded", got ${JSON.stringify(uiMode)}.`);
    }
    if (!Array.isArray(promoCodes)) throw new TurboValidationError("`promoCodes` must be an array of strings.");
    const query = payment.checkoutQuery({ token: this.token, uiMode, promoCodes, successUrl, cancelUrl, returnUrl });
    const res = await this._request(
      this.paymentUrl,
      `/v1/top-up/checkout-session/${owner}/${currency.toLowerCase()}/${amount}?${query}`,
      { signal, timeoutMs },
    );
    return payment.checkoutResult(res.body);
  }
}

module.exports = { TurboUploadCore, assertKnownOptions, checkPaidBy, trimUrl };
