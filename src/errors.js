"use strict";
/**
 * Error types.
 *
 * Design note: every error carries enough context to debug it from the message
 * alone. `@ardrive/turbo-sdk` surfaces a DNS failure as a bare `fetch failed`
 * with no endpoint, no status and no body — you cannot tell a typo'd hostname
 * from a 500 from a timeout. Every error here names the endpoint, and HTTP
 * errors carry the status and the (truncated) response body.
 */

/** Longest response body we paste into an error message. */
const MAX_BODY_IN_MESSAGE = 512;

function truncate(s, n = MAX_BODY_IN_MESSAGE) {
  if (typeof s !== "string") return s;
  return s.length > n ? `${s.slice(0, n)}… (${s.length} bytes total)` : s;
}

/** Base class. Everything this package throws is an instance of this. */
class TurboError extends Error {
  constructor(message, options = {}) {
    // `cause` goes through the standard Error option so `console.log(err)` and
    // `--stack-trace-limit` style tooling chain it for free.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }
}

/**
 * Bad configuration, thrown eagerly from the constructor rather than deep in a
 * later call. turbo-sdk's signer factory has no `default:` branch, so an
 * unsupported token yields `undefined` and dies much later with
 * `Cannot read properties of undefined (reading 'publicKey')`.
 */
class TurboConfigError extends TurboError {}

/** The JWK is missing, malformed, not RSA, or not a 4096-bit Arweave key. */
class TurboKeyError extends TurboConfigError {}

/** Invalid arguments to a call (bad tags, wrong-size target/anchor, …). */
class TurboValidationError extends TurboError {}

/** The request never produced an HTTP response: DNS, TLS, connection reset. */
class TurboNetworkError extends TurboError {
  constructor(message, { endpoint, method, cause } = {}) {
    super(message, { cause });
    this.endpoint = endpoint;
    this.method = method;
  }
}

/** The request exceeded `timeoutMs`, or the caller's `signal` aborted it. */
class TurboTimeoutError extends TurboError {
  constructor(message, { endpoint, method, timeoutMs, cause } = {}) {
    super(message, { cause });
    this.endpoint = endpoint;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** A non-2xx HTTP response. Carries status, endpoint and response body. */
class TurboHTTPError extends TurboError {
  constructor({ status, statusText, endpoint, method, body, cause }) {
    const detail = body ? ` — ${truncate(typeof body === "string" ? body : JSON.stringify(body))}` : "";
    super(`${method} ${endpoint} failed: HTTP ${status}${statusText ? ` ${statusText}` : ""}${detail}`, { cause });
    this.status = status;
    this.statusText = statusText;
    this.endpoint = endpoint;
    this.method = method;
    /** Parsed JSON when the response was JSON, otherwise the raw text. */
    this.body = body;
  }
}

/**
 * The upload service returned an id that is not SHA-256 of the signature we
 * sent. Either the service mutated the item or we are talking to something that
 * is not a Turbo upload service. Never ignore this.
 */
class TurboVerificationError extends TurboError {
  constructor(message, { expectedId, receivedId, endpoint } = {}) {
    super(message);
    this.expectedId = expectedId;
    this.receivedId = receivedId;
    this.endpoint = endpoint;
  }
}

module.exports = {
  TurboError,
  TurboConfigError,
  TurboKeyError,
  TurboValidationError,
  TurboNetworkError,
  TurboTimeoutError,
  TurboHTTPError,
  TurboVerificationError,
};
