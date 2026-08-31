"use strict";
/**
 * A small fetch wrapper: default timeout, partial retry config, and errors that
 * say what happened.
 *
 * Uses the global `fetch` (Node >= 18), so there is no HTTP client dependency.
 */

const {
  TurboHTTPError,
  TurboPaymentError,
  TurboNetworkError,
  TurboTimeoutError,
  TurboConfigError,
} = require("./errors.js");

/**
 * Default request timeout.
 *
 * turbo-sdk sets NO timeout anywhere — a hung endpoint hangs the caller
 * forever, which in a server integration means a leaked request handler and
 * eventually a wedged process. A default is not optional for library code.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_RETRY = Object.freeze({
  /** Retry attempts AFTER the first try. 0 disables retrying. */
  retries: 3,
  /** First backoff delay; doubles each attempt, capped at maxDelayMs. */
  minDelayMs: 500,
  maxDelayMs: 8_000,
  /** Statuses worth retrying: transient server and rate-limit responses. */
  retryStatuses: [408, 429, 500, 502, 503, 504],
});

/**
 * Merge a PARTIAL retry config over the defaults.
 *
 * turbo-sdk's retry config is all-or-nothing: supplying it means supplying
 * every field, including a `retryCondition` you now own. Overriding just
 * `retries` should not mean rewriting the backoff policy.
 */
function resolveRetryConfig(retry) {
  if (retry === false || retry === null) return { ...DEFAULT_RETRY, retries: 0 };
  if (retry === undefined) return { ...DEFAULT_RETRY };
  if (typeof retry !== "object") {
    throw new TurboConfigError(`\`retry\` must be an object, false, or undefined — got ${typeof retry}.`);
  }
  const merged = { ...DEFAULT_RETRY, ...retry };
  for (const field of ["retries", "minDelayMs", "maxDelayMs"]) {
    if (typeof merged[field] !== "number" || !Number.isFinite(merged[field]) || merged[field] < 0) {
      throw new TurboConfigError(`\`retry.${field}\` must be a non-negative number, got ${JSON.stringify(merged[field])}.`);
    }
  }
  if (!Array.isArray(merged.retryStatuses)) {
    throw new TurboConfigError("`retry.retryStatuses` must be an array of HTTP status codes.");
  }
  return merged;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** Parse a response body as JSON when it looks like JSON, else as text. */
async function readBody(res) {
  const text = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json") || (text.startsWith("{") || text.startsWith("["))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Perform one HTTP request with a timeout, retries and rich errors.
 *
 * @param {object} opts
 * @param {string} opts.url absolute URL
 * @param {string} [opts.method]
 * @param {BodyInit} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal] caller's signal; composed with the timeout
 * @param {object} [opts.retry] resolved retry config
 * @param {number[]} [opts.allowedStatuses] statuses to return rather than throw on
 * @param {typeof fetch} [opts.fetch]
 */
async function request({
  url,
  method = "GET",
  body,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  retry,
  allowedStatuses = [],
  fetch: fetchImpl,
}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new TurboConfigError(
      "No global fetch available. Node 18 or newer is required, or pass a `fetch` implementation in the client options.",
    );
  }
  const cfg = retry ?? resolveRetryConfig(undefined);

  let attempt = 0;
  let lastError;
  for (;;) {
    // A fresh timeout per attempt: `timeoutMs` bounds each request, and the
    // caller's own signal still aborts the whole operation immediately.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

    let res;
    try {
      res = await doFetch(url, { method, body, headers, signal: composed });
    } catch (cause) {
      clearTimeout(timer);
      // Distinguish the caller aborting from our own timeout firing: the caller
      // wants to know which, and "fetch failed" tells them neither.
      if (signal?.aborted) {
        throw new TurboTimeoutError(`${method} ${url} was aborted by the caller's signal.`, {
          endpoint: url,
          method,
          timeoutMs,
          cause,
        });
      }
      if (timeoutController.signal.aborted) {
        lastError = new TurboTimeoutError(`${method} ${url} timed out after ${timeoutMs}ms.`, {
          endpoint: url,
          method,
          timeoutMs,
          cause,
        });
      } else {
        lastError = new TurboNetworkError(
          `${method} ${url} failed before any response was received: ${cause?.message ?? cause}. ` +
            `Check the hostname resolves and is reachable.`,
          { endpoint: url, method, cause },
        );
      }
      if (attempt++ < cfg.retries) {
        await sleep(Math.min(cfg.minDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs), signal);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);

    if (res.ok || allowedStatuses.includes(res.status)) {
      return { status: res.status, headers: res.headers, body: await readBody(res) };
    }

    const parsedBody = await readBody(res);
    lastError = new (res.status === 402 ? TurboPaymentError : TurboHTTPError)({
      status: res.status,
      statusText: res.statusText,
      endpoint: url,
      method,
      body: parsedBody,
    });
    if (cfg.retryStatuses.includes(res.status) && attempt++ < cfg.retries) {
      await sleep(Math.min(cfg.minDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs), signal);
      continue;
    }
    throw lastError;
  }
}

module.exports = { request, resolveRetryConfig, DEFAULT_TIMEOUT_MS, DEFAULT_RETRY };
