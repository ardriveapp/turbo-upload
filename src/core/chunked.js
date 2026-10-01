"use strict";
/**
 * Chunked (multipart) upload: one data item sent as fixed-size chunks, then
 * assembled by the service. The routes, header and thresholds are
 * @ardrive/turbo-sdk 2.1.0's (src/common/chunked.ts):
 *
 *   GET  /v1/chunks/{token}/-1/-1?chunkSize=N   -> { id, min, max, chunkSize }
 *   POST /v1/chunks/{token}/{id}/{offset}        one chunk, raw bytes
 *   POST /v1/chunks/{token}/{id}/finalize        empty body; x-paid-by goes here
 *   GET  /v1/chunks/{token}/{id}/status          until FINALIZED, with the receipt
 *
 * every request carrying `x-chunking-version: 2`.
 *
 * Each chunk is its own request with its own retries, so a dropped connection
 * re-sends one chunk, not the item. Re-sending a chunk to the same offset is
 * accepted (probed on devnet). The bytes are the signed item's and never
 * change, so a retry cannot produce a second item or a second charge.
 */

const {
  TurboChunkedUploadError,
  TurboPaymentError,
  TurboTimeoutError,
  TurboValidationError,
  TurboVerificationError,
} = require("./errors.js");
const { sleep } = require("./http.js");

const MiB = 1024 * 1024;
const MIN_CHUNK_BYTES = 5 * MiB;
const MAX_CHUNK_BYTES = 500 * MiB;
const DEFAULT_CHUNK_BYTES = MIN_CHUNK_BYTES;
const DEFAULT_CHUNK_CONCURRENCY = 5;
const MAX_CHUNK_CONCURRENCY = 256;
const CHUNKING_HEADER = Object.freeze({ "x-chunking-version": "2" });

const FAILED = ["UNDERFUNDED", "INVALID", "APPROVAL_FAILED", "REVOKE_FAILED"];

/**
 * The slowest upload rate a request is given time for. A request's timeout is
 * the larger of `timeoutMs` and its byte count at this rate, so a 10 MiB POST
 * on a slow link is not cut off by a timeout sized for a 1 KiB one.
 */
const MIN_BYTES_PER_SECOND = 128 * 1024;

/** The per-request timeout for a request carrying `bytes`. */
function timeoutFor(bytes, timeoutMs) {
  return Math.max(timeoutMs, Math.ceil((bytes * 1000) / MIN_BYTES_PER_SECOND));
}

/** Validate and default the chunking options a call accepts. */
function chunkingOptions({ chunking = "auto", chunkSize = DEFAULT_CHUNK_BYTES, chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY, onProgress }) {
  if (!["auto", "force", "disabled"].includes(chunking)) {
    throw new TurboValidationError(`\`chunking\` must be "auto", "force" or "disabled", got ${JSON.stringify(chunking)}.`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) {
    throw new TurboValidationError(`\`chunkSize\` must be an integer from ${MIN_CHUNK_BYTES} (5 MiB) to ${MAX_CHUNK_BYTES} (500 MiB), got ${JSON.stringify(chunkSize)}.`);
  }
  if (!Number.isSafeInteger(chunkConcurrency) || chunkConcurrency < 1 || chunkConcurrency > MAX_CHUNK_CONCURRENCY) {
    throw new TurboValidationError(`\`chunkConcurrency\` must be an integer from 1 to ${MAX_CHUNK_CONCURRENCY}, got ${JSON.stringify(chunkConcurrency)}.`);
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TurboValidationError("`onProgress` must be a function ({ processedBytes, totalBytes }) => void.");
  }
  return { chunking, chunkSize, chunkConcurrency, onProgress };
}

/**
 * Whether an item of `byteCount` goes chunked: turbo-sdk's rule, more than two
 * chunks of data, and anything over a single-item limit the service has
 * already reported to this client.
 */
function shouldChunk(byteCount, { chunking, chunkSize }, knownSingleItemLimit) {
  if (chunking === "disabled") return false;
  if (chunking === "force") return true;
  if (knownSingleItemLimit !== undefined && byteCount > knownSingleItemLimit) return true;
  return byteCount > chunkSize * 2;
}

/**
 * The single-item limit, read from the service's refusal. The upload service
 * answers an oversized single POST with HTTP 400 and
 * "this service only accepts data items up to N bytes". Nothing hardcodes N.
 *
 * @returns {number|undefined}
 */
function singleItemLimitFrom(err) {
  if (!err || (err.status !== 400 && err.status !== 413)) return undefined;
  const text = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
  const m = /accepts data items up to (\d+) bytes/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Cut a stream of byte pieces into chunks of exactly `chunkSize` (the last one
 * shorter). Accepts anything async-iterable, or a web ReadableStream without
 * async iteration (Safari).
 */
async function* rechunk(source, chunkSize) {
  let parts = [];
  let held = 0;
  const take = () => {
    const out = new Uint8Array(chunkSize);
    let pos = 0;
    while (pos < chunkSize) {
      const head = parts[0];
      const n = Math.min(chunkSize - pos, head.length);
      out.set(head.subarray(0, n), pos);
      pos += n;
      if (n === head.length) parts.shift();
      else parts[0] = head.subarray(n);
    }
    held -= chunkSize;
    return out;
  };
  for await (const piece of iterate(source)) {
    if (!(piece instanceof Uint8Array)) {
      throw new TurboValidationError(`The stream produced ${typeof piece}, not bytes. Do not set an encoding on it.`);
    }
    if (piece.length === 0) continue;
    parts.push(piece);
    held += piece.length;
    while (held >= chunkSize) yield take();
  }
  if (held > 0) {
    const out = new Uint8Array(held);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    parts = [];
    yield out;
  }
}

/** Async iteration over a Node stream, an async iterable, or a web ReadableStream. */
async function* iterate(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    yield* source;
    return;
  }
  if (source && typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (source && typeof source[Symbol.iterator] === "function") {
    yield* source;
    return;
  }
  throw new TurboValidationError("The stream must be a Node stream, a web ReadableStream or an async iterable of bytes.");
}

/**
 * Upload one signed item in chunks.
 *
 * @param {object} client a TurboUploadCore
 * @param {object} opts
 * @param {AsyncIterable<Uint8Array>|Uint8Array} opts.source the item's bytes, in order
 * @param {number} opts.byteCount the item's total length
 * @param {string} opts.expectedId the id computed from our own signature
 * @param {() => void} [opts.beforeFinalize] runs after the last chunk; throw to abandon the upload
 * @returns {Promise<object>} the service's receipt
 */
async function uploadChunked(client, { source, byteCount, expectedId, paidBy, signal, timeoutMs, chunkSize, chunkConcurrency, onProgress, beforeFinalize }) {
  const token = client.token;
  const base = `/v1/chunks/${token}`;
  const perRequest = timeoutMs ?? client.timeoutMs;

  const init = await client._request(client.uploadUrl, `${base}/-1/-1?chunkSize=${chunkSize}`, {
    headers: { ...CHUNKING_HEADER },
    signal,
    timeoutMs: perRequest,
  });
  const uploadId = init.body && init.body.id;
  if (typeof uploadId !== "string" || uploadId === "") {
    throw new TurboChunkedUploadError(`The upload service did not open a chunked upload: ${JSON.stringify(init.body).slice(0, 200)}`, {
      endpoint: `${client.uploadUrl}${base}/-1/-1`,
    });
  }
  // The service may answer with its own chunk size; turbo-sdk follows it, so do we.
  const size = Number.isSafeInteger(init.body.chunkSize) && init.body.chunkSize > 0 ? init.body.chunkSize : chunkSize;

  const chunks = source instanceof Uint8Array
    ? (function* () {
      for (let off = 0; off < source.length; off += size) yield source.subarray(off, off + size);
    })()
    : rechunk(source, size);

  let offset = 0;
  let sent = 0;
  let firstError;
  const inFlight = new Set();
  const post = async (chunk, at) => {
    await client._request(client.uploadUrl, `${base}/${uploadId}/${at}`, {
      method: "POST",
      body: client._platform.output(chunk),
      headers: { "content-type": "application/octet-stream", ...CHUNKING_HEADER },
      signal,
      timeoutMs: timeoutFor(chunk.length, perRequest),
    });
    sent += chunk.length;
    if (onProgress) onProgress({ processedBytes: sent, totalBytes: byteCount, uploadId });
  };

  for await (const chunk of chunks) {
    if (firstError) break;
    const at = offset;
    offset += chunk.length;
    const p = post(chunk, at).catch((err) => {
      firstError = firstError || err;
    });
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    // Bound memory: at most `chunkConcurrency` chunks held or in flight.
    if (inFlight.size >= chunkConcurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  if (firstError) {
    firstError.uploadId = uploadId;
    throw firstError;
  }
  if (offset !== byteCount) {
    throw new TurboValidationError(`The item was ${byteCount} bytes, but ${offset} were produced for upload ${uploadId}.`);
  }
  if (beforeFinalize) beforeFinalize();

  const finalizeHeaders = { "content-type": "application/octet-stream", ...CHUNKING_HEADER };
  if (paidBy) finalizeHeaders["x-paid-by"] = paidBy;
  await client._request(client.uploadUrl, `${base}/${uploadId}/finalize`, {
    method: "POST",
    body: new Uint8Array(0),
    headers: finalizeHeaders,
    signal,
    timeoutMs: perRequest,
  });

  // turbo-sdk's wait: 2.5 minutes per started GiB, polled every 2 s under
  // 100 MiB and every 4 s under 3 GiB. A status the service answers with 503
  // before it has caught up is retried by the transport like any other.
  const gib = Math.max(1, Math.ceil(byteCount / 1024 ** 3));
  const deadline = Date.now() + gib * 2.5 * 60_000;
  const every = byteCount < 100 * MiB ? 2000 : byteCount < 3 * 1024 * MiB ? 4000 : Math.max(1500 * gib, 15000);
  const statusUrl = `${client.uploadUrl}${base}/${uploadId}/status`;
  let last;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    // The first check is immediate; a small item is often already done.
    if (attempt > 0) {
      try {
        await sleep(Math.min(every, Math.max(0, deadline - Date.now())), signal);
      } catch (cause) {
        throw new TurboTimeoutError(`Chunked upload ${uploadId} was aborted by the caller's signal while it finalized.`, {
          endpoint: statusUrl,
          method: "GET",
          cause,
        });
      }
    }
    // Before the service has caught up with a finalize, status can answer 503
    // or 404 (seen on devnet). That is "not yet", not a failure.
    const res = await client._request(client.uploadUrl, `${base}/${uploadId}/status`, {
      signal,
      timeoutMs: perRequest,
      allowedStatuses: [404, 503],
    });
    last = res.status === 404 || res.status === 503 ? `HTTP ${res.status}` : res.body && res.body.status;
    if (last === "FINALIZED") {
      const receipt = res.body.receipt || {};
      if (receipt.id && receipt.id !== expectedId) {
        throw new TurboVerificationError(
          `Chunked upload ${uploadId} finalized as "${receipt.id}", but the item we sent has id "${expectedId}".`,
          { expectedId, receivedId: receipt.id, endpoint: statusUrl },
        );
      }
      return { ...receipt, uploadId };
    }
    if (last === "UNDERFUNDED") {
      const err = new TurboPaymentError({ status: 402, statusText: "UNDERFUNDED", endpoint: statusUrl, method: "GET", body: res.body });
      err.uploadId = uploadId;
      throw err;
    }
    if (FAILED.includes(last)) {
      throw new TurboChunkedUploadError(
        `Chunked upload ${uploadId} of ${byteCount} bytes did not finalize: the service reports ${last}.`,
        { uploadId, uploadStatus: last, endpoint: statusUrl },
      );
    }
    // ASSEMBLING, VALIDATING, FINALIZING, or a state added later: keep waiting.
  }
  throw new TurboChunkedUploadError(
    `Chunked upload ${uploadId} was still ${last ?? "unreported"} after the wait ran out.`,
    { uploadId, uploadStatus: last, endpoint: statusUrl },
  );
}

module.exports = {
  uploadChunked,
  chunkingOptions,
  shouldChunk,
  singleItemLimitFrom,
  timeoutFor,
  rechunk,
  iterate,
  MIN_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_CHUNK_CONCURRENCY,
  MIN_BYTES_PER_SECOND,
};
