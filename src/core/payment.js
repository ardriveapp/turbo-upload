"use strict";
/**
 * The payment service calls: request shaping and response mapping, no I/O.
 *
 * Every route, query and body here matches what @ardrive/turbo-sdk 2.1.0
 * sends, and conformance/wire-parity.js holds the two side by side against a
 * capture server. Response shapes follow turbo-sdk's too, so code moving from
 * one to the other reads the same fields.
 */

const { utf8Encode } = require("./bytes.js");
const { TurboValidationError } = require("./errors.js");

/** A non-negative integer amount as a decimal string. Accepts number, bigint or a digit string. */
function integerString(value, name, { positive = false } = {}) {
  let s;
  if (typeof value === "bigint") s = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value)) s = String(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) s = value.replace(/^0+(?=\d)/, "");
  else {
    throw new TurboValidationError(
      `\`${name}\` must be a non-negative integer (a number, bigint or digit string), got ${JSON.stringify(typeof value === "bigint" ? String(value) : value)}.`,
    );
  }
  if (s.startsWith("-")) throw new TurboValidationError(`\`${name}\` must not be negative, got ${s}.`);
  if (positive && /^0+$/.test(s)) throw new TurboValidationError(`\`${name}\` must be greater than zero.`);
  return s;
}

/** An address that goes into a path, a query or a tag: one token, no whitespace. */
function addressString(value, name) {
  if (typeof value !== "string" || value.trim() === "" || /[\s,/?#]/.test(value)) {
    throw new TurboValidationError(`\`${name}\` must be one address as a string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The body of POST /v1/account/balance/{token}: `{"tx_id": ...}` as UTF-8
 * BYTES, with no content-type header, exactly as turbo-sdk sends it. Bytes
 * rather than a string, because a browser labels a string body
 * `text/plain;charset=UTF-8`, and the payment service refuses text/plain
 * (probed on devnet: JSON or binary only).
 */
function fundTransactionBody(txId) {
  if (typeof txId !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$|^[A-Za-z0-9_-]{43}$|^0x[0-9a-fA-F]{64}$/.test(txId)) {
    throw new TurboValidationError(`\`txId\` must be a transaction id, got ${JSON.stringify(txId)}.`);
  }
  return utf8Encode(JSON.stringify({ tx_id: txId }));
}

/**
 * Map the payment service's answer to a submitted transaction, the way
 * turbo-sdk does: one of credited, pending or failed. A 202 with no
 * recognisable body is pending: the service has seen the id and keeps checking.
 */
function fundTransactionResult(status, body, txId) {
  const pick = (t, state) => ({
    id: t.transactionId,
    quantity: t.transactionQuantity,
    owner: t.transactionSenderAddress ?? t.destinationAddress,
    winc: t.winstonCreditAmount,
    token: t.tokenType,
    status: state,
    ...(t.blockHeight !== undefined ? { block: t.blockHeight } : {}),
    recipient: t.destinationAddress,
  });
  if (body && typeof body === "object") {
    if (body.creditedTransaction) return pick(body.creditedTransaction, "confirmed");
    if (body.pendingTransaction) return pick(body.pendingTransaction, "pending");
    if (body.failedTransaction) return pick(body.failedTransaction, "failed");
  }
  if (status === 202) return { id: txId, status: "pending", message: typeof body === "string" ? body : undefined };
  throw new TurboValidationError(
    `The payment service answered the transaction ${txId} with HTTP ${status} and a body this package does not recognise: ` +
      `${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`,
  );
}

/** turbo-sdk's shape for a token price: what that many base units buy, after fees. */
function wincForTokenResult(body, tokenAmount) {
  return {
    winc: body.winc,
    fees: body.fees,
    actualTokenAmount: tokenAmount,
    equivalentWincTokenAmount: body.actualPaymentAmount === undefined ? undefined : String(body.actualPaymentAmount),
  };
}

/**
 * The query string turbo-sdk builds for a checkout session, in its order:
 * token, uiMode, promoCode (comma-joined), successUrl, cancelUrl, returnUrl.
 * `token=solana` is what makes a base58 owner valid to the payment service.
 */
function checkoutQuery({ token, uiMode, promoCodes, successUrl, cancelUrl, returnUrl }) {
  const q = new URLSearchParams();
  q.append("token", token);
  if (uiMode) q.append("uiMode", uiMode);
  if (promoCodes && promoCodes.length > 0) q.append("promoCode", promoCodes.join(","));
  if (successUrl !== undefined) q.append("successUrl", successUrl);
  if (cancelUrl !== undefined) q.append("cancelUrl", cancelUrl);
  if (returnUrl !== undefined) q.append("returnUrl", returnUrl);
  return q.toString();
}

function checkoutResult(body) {
  const quote = body.topUpQuote || {};
  const session = body.paymentSession || {};
  return {
    winc: quote.winstonCreditAmount,
    adjustments: body.adjustments,
    fees: body.fees,
    url: session.url ?? undefined,
    id: session.id,
    client_secret: session.client_secret ?? undefined,
    actualPaymentAmount: quote.paymentAmount,
    quotedPaymentAmount: quote.quotedPaymentAmount,
  };
}

/** The tags of a credit-share approval, in turbo-sdk's order. */
function shareCreditsTags({ approvedAddress, approvedWincAmount, expiresBySeconds }) {
  const tags = [
    { name: "x-approve-payment", value: approvedAddress },
    { name: "x-amount", value: approvedWincAmount },
  ];
  if (expiresBySeconds !== undefined) tags.push({ name: "x-expires-seconds", value: String(expiresBySeconds) });
  return tags;
}

module.exports = {
  integerString,
  addressString,
  fundTransactionBody,
  fundTransactionResult,
  wincForTokenResult,
  checkoutQuery,
  checkoutResult,
  shareCreditsTags,
};
