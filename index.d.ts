/**
 * @ardrive/turbo-upload, the Node build: sign ANS-104 data items with an
 * Arweave JWK, a Solana key or a wallet-style signer, and upload them to Turbo.
 * Zero runtime dependencies. The browser build's declarations are web.d.ts.
 *
 * Hand-written declarations: no `typescript` build step, no `@types/*`, nothing
 * in `dependencies`.
 */

/// <reference types="node" />

import type { KeyObject } from "node:crypto";

/**
 * An ANS-104 tag. Exported so you never have to go read a third-party package's
 * .d.ts to learn that it is `{ name, value }` and not `{ key, value }`.
 */
export interface Tag {
  name: string;
  value: string;
}

/** An Arweave RSA-4096 JWK. Only `n`/`e` are public; the rest are the private key. */
export interface ArweaveJWK {
  kty?: "RSA";
  n: string;
  e: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  [key: string]: unknown;
}

/** A JWK object, or the JSON string form that comes out of an environment variable. */
export type JWKInput = ArweaveJWK | string;

/**
 * A Solana secret key in any form a user actually holds: a base58 secret key,
 * the JSON array `solana-keygen` writes, raw bytes, or a bare 32-byte seed.
 */
export type SolanaKeyInput = string | Buffer | Uint8Array | number[];

/** Tokens this package can sign for. Anything else throws in the constructor. */
export type TurboToken = "arweave" | "solana";

export interface RetryConfig {
  /** Attempts AFTER the first try. 0 disables retrying. Default 3. */
  retries: number;
  /** First backoff delay in ms; doubles per attempt. Default 500. */
  minDelayMs: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxDelayMs: number;
  /** Statuses worth retrying. Default [408, 429, 500, 502, 503, 504]. */
  retryStatuses: number[];
}

/**
 * A wallet-style signer: the shape of a Solana wallet adapter. Pass the adapter
 * itself; its other properties are ignored.
 *
 * `signMessage` is called once per item with the 96 ASCII bytes of the hex of
 * the item's deep hash, and must sign exactly those bytes. Its signature is
 * verified before it is used: a wallet that signs anything else (a prefixed
 * message, a hardware wallet's off-chain format) throws TurboSignerError and
 * nothing is uploaded.
 */
export interface SolanaWalletSigner {
  /** 32 bytes, a base58 string, or an object with toBytes() (web3.js) or toBuffer(). */
  publicKey: Uint8Array | string | number[] | { toBytes(): Uint8Array } | { toBuffer(): Uint8Array };
  /** Sign the bytes given, raw. A wallet that answers `{ signature }` (Phantom's provider) works too. */
  signMessage(message: Uint8Array): Promise<Uint8Array | { signature: Uint8Array }> | Uint8Array | { signature: Uint8Array };
  /**
   * Ed25519 verification, in the order `(message, signature, publicKey)`. Optional in Node,
   * which verifies with node:crypto; the web build uses it when the runtime has no WebCrypto Ed25519.
   */
  verify?(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean | Promise<boolean>;
}

export interface TurboUploadOptions {
  /**
   * The signing key. An Arweave JWK by default, or a Solana secret key when
   * `token` is `"solana"`. Validated in the constructor either way. Pass this
   * or `signer`, not both.
   */
  jwk?: JWKInput | SolanaKeyInput;
  /**
   * A wallet-style signer, in place of `jwk`. Signs Solana items (type 4), so
   * `token` defaults to "solana". Use `signAsync()` rather than `sign()`.
   */
  signer?: SolanaWalletSigner;
  /** Upload service base URL. Default https://upload.ardrive.io */
  uploadUrl?: string;
  /** Payment service base URL. Default https://payment.ardrive.io */
  paymentUrl?: string;
  /** Per-request timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Partial retry config, merged over the defaults. `false` disables retrying. */
  retry?: Partial<RetryConfig> | false;
  /**
   * Which key `jwk` holds. Default "arweave", or "solana" with `signer`.
   *
   * "solana" signs ANS-104 type 4, matching what `@ardrive/turbo-sdk` emits for
   * the same token, so ids agree between the two. Any other value throws a
   * TurboConfigError up front.
   */
  token?: TurboToken;
  /** Inject a fetch implementation (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface SignOptions {
  data: Buffer | Uint8Array | string;
  tags?: Tag[];
  /** An Arweave address, base64url, decoding to exactly 32 bytes. */
  target?: string | Buffer | Uint8Array;
  /**
   * 32 bytes of replay protection. A string is used as RAW UTF-8 BYTES, NOT
   * base64url, the opposite convention to `target`. Pass 32 raw bytes or a
   * 32-character string.
   */
  anchor?: string | Buffer | Uint8Array;
}

export interface UploadOptions extends SignOptions, ChunkingOptions {
  signal?: AbortSignal;
  /** Overrides the client's timeoutMs for this call. */
  timeoutMs?: number;
  /**
   * ONE address whose credits pay for this upload, sent as `x-paid-by`. That
   * address must first have shared credits with the signer (see
   * `shareCredits`). A list is refused: the service answers 402 to one.
   */
  paidBy?: string;
}

export interface UploadSignedOptions extends ChunkingOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** ONE paying address, as in UploadOptions. */
  paidBy?: string;
}

/** How an upload is sent: "auto" chunks items over two chunks; "force" always; "disabled" never. */
export type ChunkingMode = "auto" | "force" | "disabled";

export interface ChunkingOptions {
  chunking?: ChunkingMode;
  /** Bytes per chunk, 5 MiB (the default) to 500 MiB. */
  chunkSize?: number;
  /** Chunks in flight at once, default 5. Also bounds the memory a stream upload holds. */
  chunkConcurrency?: number;
  /** Called after each chunk lands, and once for a single POST. */
  onProgress?: (progress: { processedBytes: number; totalBytes: number; uploadId?: string }) => void;
}

export interface UploadStreamOptions extends ChunkingOptions {
  /** Called TWICE: once to hash the data, once to send it. Must give the same bytes both times. */
  streamFactory: () => AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  /** The data's length in bytes. */
  size: number;
  tags?: Tag[];
  target?: string | Uint8Array;
  anchor?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  paidBy?: string;
}

export interface DataItemSizeOptions {
  /** The payload, or its length as `dataSize`: exactly one of the two. */
  data?: Buffer | Uint8Array | string;
  dataSize?: number;
  tags?: Tag[];
  target?: string | Buffer | Uint8Array;
  anchor?: string | Buffer | Uint8Array;
}

export interface SignedDataItem {
  /** The complete signed data item, ready to POST. */
  binary: Buffer;
  /** The 512 raw signature bytes. */
  signature: Buffer;
  /** The raw 32-byte id: SHA-256 of the signature. */
  id: Buffer;
  /** The id as a 43-character base64url string. */
  idB64Url: string;
  /** The 48-byte deep hash that was signed. */
  signatureData: Buffer;
}

export interface UploadResult {
  /** The data-item id, base64url. Verified against what the service returned. */
  id: string;
  /** The signing wallet's Arweave address. */
  owner: string;
  /** Size of the signed item on the wire, in bytes. */
  byteCount: number;
  /** Set when the item went in chunks: the service's multipart upload id. */
  uploadId?: string;
  /** Winston credits charged. Absent or "0" for a free-tier upload. */
  winc?: string;
  dataCaches?: string[];
  fastFinalityIndexes?: string[];
  deadlineHeight?: number;
  timestamp?: number;
  version?: string;
  [key: string]: unknown;
}

export interface UploadCost {
  /** Price in winston credits, as a decimal string (may exceed Number.MAX_SAFE_INTEGER). */
  winc: string;
  adjustments?: unknown[];
}

export interface Balance {
  winc: string;
  controlledWinc: string;
  effectiveBalance: string;
  address: string;
  [key: string]: unknown;
}

export interface ServiceInfo {
  version?: string;
  gateway?: string;
  gateways?: string[];
  /** The free-upload threshold in bytes. 107520 at the time of writing. */
  freeUploadLimitBytes?: number;
  freeTier?: { lifetimeBytes?: number; ipBytes?: number; maxItemBytes?: number };
  addresses?: Record<string, string>;
  [key: string]: unknown;
}

export interface EndpointConfig {
  readonly name: string;
  readonly uploadUrl: string;
  readonly paymentUrl: string;
  readonly gatewayUrl: string;
}

/** Mainnet. Permanent, and costs real money. */
export declare const PRODUCTION: EndpointConfig;

/**
 * Testnet / dev. Note the `.services.`, this is NOT `upload.ar-io.dev`, which
 * resolves but serves an HTML SPA on every path. The published
 * @ardrive/turbo-sdk ships `upload.ardrive.dev`, which is NXDOMAIN.
 */
export declare const TESTNET: EndpointConfig;

export declare class TurboUpload {
  constructor(options: TurboUploadOptions);
  /** A client pointed at the testnet services. */
  static testnet(options: Omit<TurboUploadOptions, "uploadUrl" | "paymentUrl"> & Partial<TurboUploadOptions>): TurboUpload;
  /** A client pointed at production. */
  static production(options: Omit<TurboUploadOptions, "uploadUrl" | "paymentUrl"> & Partial<TurboUploadOptions>): TurboUpload;

  /** The signing address: base64url(SHA-256(owner)) for Arweave, base58 for Solana. */
  readonly address: string;
  /** The owner field as it appears on the wire: the 512-byte RSA modulus, or the 32-byte Ed25519 public key. */
  readonly owner: Buffer;
  /** 1 (Arweave) or 4 (Solana). */
  readonly signatureType: number;
  readonly token: TurboToken;
  readonly uploadUrl: string;
  readonly paymentUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryConfig;

  /** Sign a data item without uploading it. Needs `jwk`; a `signer` client uses signAsync(). */
  sign(options: SignOptions): SignedDataItem;
  /** Sign through whichever signer this client has. With a wallet signer, the signature is verified first. */
  signAsync(options: SignOptions): Promise<SignedDataItem>;
  /** The byte length of the signed item these options would produce. Price this, not the payload. */
  getDataItemSize(options: DataItemSizeOptions): number;
  /** Sign and upload data from a stream, chunked when large, without holding the data in memory. */
  uploadStream(options: UploadStreamOptions): Promise<UploadResult>;
  /** Sign and upload. Throws if the service returns an id we did not produce. */
  upload(options: UploadOptions): Promise<UploadResult>;
  /**
   * Upload an item already signed by `sign()`.
   *
   * The only correct way to do sign-then-upload: RSA-PSS is randomised, so
   * calling `sign()` and then `upload()` signs twice and yields two different
   * ids.
   */
  uploadSigned(item: SignedDataItem | Buffer | Uint8Array, options?: UploadSignedOptions): Promise<UploadResult>;
  /** Price in winc for a given raw byte count. */
  getUploadCost(bytes: number, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UploadCost>;
  /** Credit balance. An unknown wallet reports zeros rather than throwing. */
  getBalance(options?: { address?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Balance>;
  /** The upload service's /v1/info. */
  getInfo(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ServiceInfo>;
  /** The free-upload threshold, read live from /v1/info rather than hardcoded. */
  getFreeUploadLimitBytes(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<number>;
  /** Verify a serialized item. `strictSaltLength` also pins the PSS salt length. */
  verify(binary: Buffer | Uint8Array, options?: { strictSaltLength?: boolean }): boolean;
  /** What `tokenAmount` base units of this client's token buy, in winc (lamports for Solana). */
  getWincForToken(tokenAmount: IntegerAmount, options?: CallOptions): Promise<WincForToken>;
  /** The payment service's /v1/info. */
  getPaymentInfo(options?: CallOptions): Promise<PaymentInfo>;
  /** Where a top-up in this client's token is sent, read live from the payment service. */
  getFundingAddress(options?: CallOptions): Promise<string>;
  /** Free-tier bytes left for an address as signer (default: this client's). */
  getFreeQuota(options?: CallOptions & { address?: string }): Promise<FreeQuota>;
  /**
   * Report a top-up transaction already sent to getFundingAddress() and finalized.
   * Submitting the same id twice is safe: nothing is credited twice.
   */
  submitFundTransaction(txId: string, options?: CallOptions): Promise<FundTransactionResult>;
  /** Approve another address to spend up to `approvedWincAmount` of this client's credits. */
  shareCredits(options: ShareCreditsOptions): Promise<CreditShareApproval>;
  /** A Stripe checkout session that buys credits. */
  createCheckoutSession(options: CheckoutSessionOptions): Promise<CheckoutSession>;
}

/* ------------------------------------------------------------------ *
 * Payments                                                            *
 * ------------------------------------------------------------------ */

/** An integer amount: a number, a bigint, or a string of digits. */
export type IntegerAmount = number | bigint | string;

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WincForToken {
  /** What the amount buys, in winc, after fees. */
  winc: string;
  fees: unknown[];
  /** The amount priced, in base units (lamports for Solana). */
  actualTokenAmount: string;
  equivalentWincTokenAmount: string;
}

export interface PaymentInfo {
  version?: string;
  /** Funding address per token. */
  addresses?: Record<string, string>;
  [key: string]: unknown;
}

export interface FreeQuota {
  /** Free-tier bytes left for this address as SIGNER. null when the service reports no limit. */
  bytesRemaining: number | null;
  address: string;
}

export interface FundTransactionResult {
  id: string;
  /** "confirmed": credited. "pending": not seen yet, submit again later. "failed": not creditable. */
  status: "confirmed" | "pending" | "failed";
  quantity?: string;
  owner?: string;
  winc?: string;
  token?: string;
  block?: number;
  recipient?: string;
  message?: string;
}

export interface ShareCreditsOptions extends CallOptions {
  /** The address that may spend the credits, uploading with `paidBy: client.address`. */
  approvedAddress: string;
  approvedWincAmount: IntegerAmount;
  /** The approval expires after this many seconds, and the unused part returns. */
  expiresBySeconds?: number;
}

export interface CreditShareApproval {
  approvalDataItemId: string;
  approvedAddress: string;
  payingAddress?: string;
  approvedWincAmount: string;
  usedWincAmount?: string;
  expirationDate?: string;
  [key: string]: unknown;
}

export interface CheckoutSessionOptions extends CallOptions {
  /** In the currency's smallest unit: cents for "usd", so 1000 is $10.00. */
  amount: IntegerAmount;
  /** Default "usd". */
  currency?: string;
  /** Who is credited. Default: this client's address. */
  owner?: string;
  uiMode?: "hosted" | "embedded";
  promoCodes?: string[];
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
}

export interface CheckoutSession {
  winc: string;
  adjustments: unknown[];
  fees: unknown[];
  /** Open this to pay. */
  url?: string;
  id: string;
  client_secret?: string;
  actualPaymentAmount: number;
  quotedPaymentAmount: number;
}

/* ------------------------------------------------------------------ *
 * Low-level ANS-104                                                   *
 * ------------------------------------------------------------------ */

/**
 * `data` is optional here and required in `SignOptions`, so this omits it and
 * redeclares it. Extending directly is a type error: an interface cannot widen
 * an inherited required property to optional. `createDataItem` genuinely
 * accepts an item with no data; `sign()` does not.
 */
export interface CreateDataItemOptions extends Omit<SignOptions, "data"> {
  /** 512-byte raw RSA modulus. */
  owner: Buffer | Uint8Array;
  /** "arbundles" (default, byte-exact with the reference) or "utf8" (strict). */
  stringEncoding?: "arbundles" | "utf8";
  data?: Buffer | Uint8Array | string;
}

export interface ParsedDataItem {
  signatureType: number;
  signatureLength: number;
  ownerLength: number;
  offsets: {
    sigStart: number;
    ownerStart: number;
    targetStart: number;
    anchorStart: number;
    tagsStart: number;
    dataStart: number;
    totalLength: number;
  };
  rawSignature: Buffer;
  rawOwner: Buffer;
  rawTarget: Buffer;
  rawAnchor: Buffer;
  tagCount: number;
  rawTags: Buffer;
  rawData: Buffer;
}

/** Build and sign a data item. RSA-PSS is randomised: the id differs every call. */
export declare function signDataItem(
  jwk: ArweaveJWK,
  options: SignOptions & { owner?: Buffer | Uint8Array; privateKey?: KeyObject; saltLength?: number },
): SignedDataItem;

/** Structural + cryptographic verification of a serialized item. */
export declare function verifyDataItem(
  binary: Buffer | Uint8Array,
  options?: { strictSaltLength?: boolean },
): boolean;

/** Build the unsigned item bytes (signature region zeroed). */
export declare function createDataItem(options: CreateDataItemOptions): Buffer;

/** Resolve every field offset of a serialized item. */
export declare function parseDataItem(binary: Buffer | Uint8Array): ParsedDataItem;

/** The 48-byte deep hash that a given item's signature covers. */
export declare function getSignatureData(binary: Buffer | Uint8Array): Buffer;

/** Arweave's SHA-384 structured transcript hash. */
export declare function deepHash(chunk: Buffer | Uint8Array | string | Array<unknown>): Buffer;

/** Avro-encode tags to the ANS-104 tag region. An empty list encodes to zero bytes. */
export declare function serializeTags(
  tags: Tag[],
  options?: { stringEncoding?: "arbundles" | "utf8" },
): Buffer;

/** Decode a serialized tag region. */
export declare function deserializeTags(buffer: Buffer | Uint8Array): Tag[];

/** RSA-PSS-SHA256 sign with a 478-byte salt. */
export declare function signMessage(
  jwk: ArweaveJWK,
  message: Buffer | Uint8Array,
  options?: { saltLength?: number; privateKey?: KeyObject },
): Buffer;

/** Verify a signature over a message given raw owner bytes. */
export declare function verifyMessage(
  rawOwner: Buffer | Uint8Array,
  message: Buffer | Uint8Array,
  signature: Buffer | Uint8Array,
  options?: { strictSaltLength?: boolean },
): boolean;

/** id = SHA-256(signature). */
export declare function idFromSignature(signature: Buffer | Uint8Array): Buffer;

/**
 * A wallet-style signer over a Solana key this process holds, the same shape as
 * a browser wallet adapter. Takes every form `jwk` does with token "solana".
 */
export declare function createSolanaSigner(secretKey: SolanaKeyInput): Readonly<{
  publicKey: Uint8Array;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  verify(message: Uint8Array, signature: Uint8Array, publicKey?: Uint8Array): boolean;
}>;

/** Accept a JWK as an object or a JSON string; throws a clear error otherwise. */
export declare function parseJwk(input: JWKInput): ArweaveJWK;

/** The 512-byte modulus from a JWK. */
export declare function ownerFromJwk(jwk: ArweaveJWK): Buffer;

/** base64url(SHA-256(owner)), the wallet address. */
export declare function addressFromOwner(owner: Buffer | Uint8Array): string;

/** Rebuild the public key from owner bytes, assuming e = 65537. */
export declare function publicKeyFromOwner(owner: Buffer | Uint8Array): KeyObject;

/** 4096, cap on the SERIALIZED tag region in bytes, not the tag count. */
export declare const MAX_TAG_BYTES: number;
/** 1044, the smallest possible signed item. */
export declare const MIN_ITEM_SIZE: number;
/** 478, the PSS salt length this package emits. See the README. */
export declare const PSS_SALT_LENGTH_BYTES: number;
/** 1 */
export declare const SIGNATURE_TYPE_ARWEAVE: number;
export declare const SIGNATURE_TYPE_SOLANA: number;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_RETRY: RetryConfig;

/* ------------------------------------------------------------------ *
 * Errors                                                              *
 * ------------------------------------------------------------------ */

/** Base class for everything this package throws. */
export declare class TurboError extends Error {
  constructor(message: string, options?: { cause?: unknown });
  readonly cause?: unknown;
}
/** Bad client configuration, thrown from the constructor. */
export declare class TurboConfigError extends TurboError {
  constructor(message: string, options?: { cause?: unknown });
}
/** The JWK is missing, malformed, not RSA, or not RSA-4096. */
export declare class TurboKeyError extends TurboConfigError {
  constructor(message: string, options?: { cause?: unknown });
}
/** Bad arguments to a call. */
export declare class TurboValidationError extends TurboError {
  constructor(message: string, options?: { cause?: unknown });
}
/** No HTTP response at all: DNS, TLS, connection reset. */
export declare class TurboNetworkError extends TurboError {
  constructor(message: string, init?: { endpoint?: string; method?: string; cause?: unknown });
  readonly endpoint?: string;
  readonly method?: string;
}
/** The request exceeded timeoutMs, or the caller's signal aborted it. */
export declare class TurboTimeoutError extends TurboError {
  constructor(message: string, init?: { endpoint?: string; method?: string; timeoutMs?: number; cause?: unknown });
  readonly endpoint?: string;
  readonly method?: string;
  readonly timeoutMs?: number;
}
/** A non-2xx response. Carries status, endpoint and body. */
export declare class TurboHTTPError extends TurboError {
  constructor(init: {
    status: number;
    statusText?: string;
    endpoint: string;
    method: string;
    body?: unknown;
    cause?: unknown;
  });
  readonly status: number;
  readonly statusText?: string;
  readonly endpoint: string;
  readonly method: string;
  /** Parsed JSON when the response was JSON, otherwise raw text. */
  readonly body: unknown;
  /** Set when the request was part of a chunked upload. */
  readonly uploadId?: string;
}
/**
 * The service refused the upload because the wallet cannot pay: HTTP 402.
 *
 * Catch this to tell "we cannot pay" apart from a transient failure. Retrying
 * will not help, and treating it like a 503 makes an integration go quiet while
 * reporting healthy. Still a `TurboHTTPError`, so existing catches keep working.
 */
export declare class TurboPaymentError extends TurboHTTPError {}

/**
 * The service returned an id we did not produce.
 *
 * Either the service mutated the item, or this is not a Turbo upload service.
 * Never ignore it: the id is what proves the bytes that arrived are the bytes
 * that were signed.
 */
export declare class TurboVerificationError extends TurboError {
  constructor(message: string, init?: { expectedId?: string; receivedId?: string; endpoint?: string });
  readonly expectedId?: string;
  readonly receivedId?: string;
  readonly endpoint?: string;
}

/**
 * A wallet-style signer could not produce a usable signature: signMessage
 * threw, returned something that is not 64 bytes, or returned a signature
 * that does not verify. Nothing was uploaded. Hardware wallets are the usual
 * cause: they cannot sign data items.
 */
export declare class TurboSignerError extends TurboError {
  constructor(message: string, options?: { cause?: unknown });
}

/**
 * A chunked upload did not finalize: the service reported INVALID (or another
 * failed state), or the wait ran out. UNDERFUNDED is a TurboPaymentError
 * instead. The testnet service finalizes every item over 10,485,760 bytes as
 * INVALID.
 */
export declare class TurboChunkedUploadError extends TurboError {
  constructor(message: string, init?: { uploadId?: string; uploadStatus?: string; endpoint?: string; cause?: unknown });
  readonly uploadId?: string;
  readonly uploadStatus?: string;
  readonly endpoint?: string;
}
