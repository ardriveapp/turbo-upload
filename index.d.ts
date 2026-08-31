/**
 * @ardrive/turbo-upload — sign ANS-104 data items with an Arweave JWK and upload
 * them to a Turbo upload service. Zero runtime dependencies.
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

export interface TurboUploadOptions {
  /** Arweave JWK, as an object or a JSON string. Validated in the constructor. */
  jwk: JWKInput;
  /** Upload service base URL. Default https://upload.ardrive.io */
  uploadUrl?: string;
  /** Payment service base URL. Default https://payment.ardrive.io */
  paymentUrl?: string;
  /** Per-request timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Partial retry config, merged over the defaults. `false` disables retrying. */
  retry?: Partial<RetryConfig> | false;
  /** Must be "arweave". Anything else throws a TurboConfigError up front. */
  token?: "arweave";
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
   * base64url — the opposite convention to `target`. Pass 32 raw bytes or a
   * 32-character string.
   */
  anchor?: string | Buffer | Uint8Array;
}

export interface UploadOptions extends SignOptions {
  signal?: AbortSignal;
  /** Overrides the client's timeoutMs for this call. */
  timeoutMs?: number;
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
 * Testnet / dev. Note the `.services.` — this is NOT `upload.ar-io.dev`, which
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

  /** The signing wallet's Arweave address: base64url(SHA-256(owner)). */
  readonly address: string;
  /** The 512-byte RSA modulus as it appears on the wire. */
  readonly owner: Buffer;
  readonly uploadUrl: string;
  readonly paymentUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryConfig;

  /** Sign a data item without uploading it. */
  sign(options: SignOptions): SignedDataItem;
  /** Sign and upload. Throws if the service returns an id we did not produce. */
  upload(options: UploadOptions): Promise<UploadResult>;
  /**
   * Upload an item already signed by `sign()`.
   *
   * The only correct way to do sign-then-upload: RSA-PSS is randomised, so
   * calling `sign()` and then `upload()` signs twice and yields two different
   * ids.
   */
  uploadSigned(
    item: SignedDataItem | Buffer | Uint8Array,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<UploadResult>;
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
}

/* ------------------------------------------------------------------ *
 * Low-level ANS-104                                                   *
 * ------------------------------------------------------------------ */

export interface CreateDataItemOptions extends SignOptions {
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

/** Accept a JWK as an object or a JSON string; throws a clear error otherwise. */
export declare function parseJwk(input: JWKInput): ArweaveJWK;

/** The 512-byte modulus from a JWK. */
export declare function ownerFromJwk(jwk: ArweaveJWK): Buffer;

/** base64url(SHA-256(owner)) — the wallet address. */
export declare function addressFromOwner(owner: Buffer | Uint8Array): string;

/** Rebuild the public key from owner bytes, assuming e = 65537. */
export declare function publicKeyFromOwner(owner: Buffer | Uint8Array): KeyObject;

/** 4096 — cap on the SERIALIZED tag region in bytes, not the tag count. */
export declare const MAX_TAG_BYTES: number;
/** 1044 — the smallest possible signed item. */
export declare const MIN_ITEM_SIZE: number;
/** 478 — the PSS salt length this package emits. See the README. */
export declare const PSS_SALT_LENGTH_BYTES: number;
/** 1 */
export declare const SIGNATURE_TYPE_ARWEAVE: number;
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
  constructor(init: { endpoint: string; method: string; cause?: unknown });
  readonly endpoint?: string;
  readonly method?: string;
}
/** The request exceeded timeoutMs, or the caller's signal aborted it. */
export declare class TurboTimeoutError extends TurboError {
  constructor(init: { endpoint: string; method: string; timeoutMs: number; cause?: unknown });
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
}
/** The service returned an id we did not produce. */
/**
 * The service refused the upload because the wallet cannot pay: HTTP 402.
 *
 * Catch this to tell "we cannot pay" apart from a transient failure. Retrying
 * will not help, and treating it like a 503 makes an integration go quiet while
 * reporting healthy. Still a `TurboHTTPError`, so existing catches keep working.
 */
export declare class TurboPaymentError extends TurboHTTPError {}

export declare class TurboVerificationError extends TurboError {
  constructor(init: { expectedId: string; receivedId: string });
  readonly expectedId?: string;
  readonly receivedId?: string;
  readonly endpoint?: string;
}
