/**
 * @ardrive/turbo-upload, the web build: browsers, workers, jsdom. Signs ANS-104
 * type 4 (Solana) data items through a wallet-style signer and uploads them to
 * Turbo. Bytes are Uint8Array, never Buffer, and nothing here needs Node types.
 *
 * Hand-written declarations, like index.d.ts.
 */

/** An ANS-104 tag. */
export interface Tag {
  name: string;
  value: string;
}

/**
 * A wallet-style signer: the shape of a Solana wallet adapter. Pass the adapter
 * itself; its other properties are ignored.
 *
 * `signMessage` is called once per item with the 96 ASCII bytes of the hex of
 * the item's deep hash, and must sign exactly those bytes. The signature is
 * verified before it is used, with `verify` when given, otherwise WebCrypto's
 * Ed25519. A runtime with neither (jsdom, React Native, an older browser)
 * needs `verify`: a wrapper over @noble/ed25519's `verify` is enough.
 */
export interface SolanaWalletSigner {
  /** 32 bytes, a base58 string, or an object with toBytes() (web3.js) or toBuffer(). */
  publicKey: Uint8Array | string | number[] | { toBytes(): Uint8Array } | { toBuffer(): Uint8Array };
  /** Sign the bytes given, raw. A wallet that answers `{ signature }` works too. */
  signMessage(message: Uint8Array): Promise<Uint8Array | { signature: Uint8Array }> | Uint8Array | { signature: Uint8Array };
  /** Ed25519 verification, `(message, signature, publicKey)`. */
  verify?(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean | Promise<boolean>;
}

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
  /** The wallet that signs. Required: the web build holds no raw keys. */
  signer: SolanaWalletSigner;
  /** Upload service base URL. Default https://upload.ardrive.io */
  uploadUrl?: string;
  /** Payment service base URL. Default https://payment.ardrive.io */
  paymentUrl?: string;
  /** Per-request timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Partial retry config, merged over the defaults. `false` disables retrying. */
  retry?: Partial<RetryConfig> | false;
  /** Only "solana" here. */
  token?: "solana";
  /** Inject a fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface SignOptions {
  data: Uint8Array | string;
  tags?: Tag[];
  /** An Arweave address, base64url, decoding to exactly 32 bytes. */
  target?: string | Uint8Array;
  /** 32 RAW bytes. A string is used as its UTF-8 bytes, NOT base64url. */
  anchor?: string | Uint8Array;
}

export interface UploadOptions extends SignOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** ONE address whose shared credits pay for this upload, sent as `x-paid-by`. */
  paidBy?: string;
}

export interface UploadSignedOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  paidBy?: string;
}

export interface DataItemSizeOptions {
  /** The payload, or its length as `dataSize`: exactly one of the two. */
  data?: Uint8Array | string;
  dataSize?: number;
  tags?: Tag[];
  target?: string | Uint8Array;
  anchor?: string | Uint8Array;
}

export interface SignedDataItem {
  /** The complete signed data item, ready to POST. */
  binary: Uint8Array;
  /** The 64 raw signature bytes. */
  signature: Uint8Array;
  /** The raw 32-byte id: SHA-256 of the signature. */
  id: Uint8Array;
  /** The id as a 43-character base64url string. */
  idB64Url: string;
  /** The 48-byte deep hash that was signed. */
  signatureData: Uint8Array;
}

export interface UploadResult {
  /** The data-item id, base64url. Verified against what the service returned. */
  id: string;
  /** base64url(SHA-256(owner)), the form the upload service reports. */
  owner: string;
  /** Size of the signed item on the wire, in bytes. */
  byteCount: number;
  /** Winston credits charged. "0" for a free upload. */
  winc?: string;
  [key: string]: unknown;
}

export interface UploadCost {
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

export declare const PRODUCTION: EndpointConfig;
export declare const TESTNET: EndpointConfig;

export declare class TurboUpload {
  constructor(options: TurboUploadOptions);
  static testnet(options: Omit<TurboUploadOptions, "uploadUrl" | "paymentUrl"> & Partial<TurboUploadOptions>): TurboUpload;
  static production(options: Omit<TurboUploadOptions, "uploadUrl" | "paymentUrl"> & Partial<TurboUploadOptions>): TurboUpload;

  /** The signer's base58 Solana address. */
  readonly address: string;
  /** The 32-byte public key. */
  readonly owner: Uint8Array;
  readonly signatureType: number;
  readonly token: "solana";
  readonly uploadUrl: string;
  readonly paymentUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryConfig;

  /** Always throws here: signing is asynchronous in the web build. Use signAsync(). */
  sign(options: SignOptions): never;
  /** Sign through the wallet: one signMessage call, verified before it is returned. */
  signAsync(options: SignOptions): Promise<SignedDataItem>;
  /** The byte length of the signed item these options would produce. */
  getDataItemSize(options: DataItemSizeOptions): number;
  upload(options: UploadOptions): Promise<UploadResult>;
  uploadSigned(item: SignedDataItem | Uint8Array, options?: UploadSignedOptions): Promise<UploadResult>;
  getUploadCost(bytes: number, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UploadCost>;
  getBalance(options?: { address?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Balance>;
  getInfo(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ServiceInfo>;
  getFreeUploadLimitBytes(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<number>;
  /** Verify a type 4 item with the signer's verify or WebCrypto. Asynchronous, unlike the Node build. */
  verify(binary: Uint8Array): Promise<boolean>;
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

/* Low-level ANS-104 */

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
  rawSignature: Uint8Array;
  rawOwner: Uint8Array;
  rawTarget: Uint8Array;
  rawAnchor: Uint8Array;
  tagCount: number;
  rawTags: Uint8Array;
  rawData: Uint8Array;
}

export interface CreateDataItemOptions {
  owner: Uint8Array;
  /** 1 (default) or 4. */
  signatureType?: number;
  data?: Uint8Array | string;
  tags?: Tag[];
  target?: string | Uint8Array;
  anchor?: string | Uint8Array;
  stringEncoding?: "arbundles" | "utf8";
}

/** Build the unsigned item bytes (signature region zeroed). */
export declare function createDataItem(options: CreateDataItemOptions): Uint8Array;
/** Resolve every field offset of a serialized item. Fields are views into the input. */
export declare function parseDataItem(binary: Uint8Array): ParsedDataItem;
/** The 48-byte deep hash a given item's signature covers. */
export declare function getSignatureData(binary: Uint8Array): Uint8Array;
/** Arweave's SHA-384 structured transcript hash. */
export declare function deepHash(chunk: Uint8Array | string | Array<unknown>): Uint8Array;
/** Avro-encode tags to the ANS-104 tag region. An empty list encodes to zero bytes. */
export declare function serializeTags(tags: Tag[], options?: { stringEncoding?: "arbundles" | "utf8" }): Uint8Array;
export declare function deserializeTags(bytes: Uint8Array): Tag[];
/** id = SHA-256(signature). */
export declare function idFromSignature(signature: Uint8Array): Uint8Array;
/** base64url(SHA-256(owner)). */
export declare function addressFromOwner(owner: Uint8Array): string;
/**
 * Verify a type 4 item. `verify` is an Ed25519 verifier; without one WebCrypto
 * is used, and a runtime with neither throws rather than answering false.
 */
export declare function verifyDataItem(
  binary: Uint8Array,
  options?: { verify?: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean | Promise<boolean> },
): Promise<boolean>;

export declare const MAX_TAG_BYTES: number;
export declare const MIN_ITEM_SIZE: number;
export declare const SIGNATURE_TYPE_ARWEAVE: number;
export declare const SIGNATURE_TYPE_SOLANA: number;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_RETRY: RetryConfig;

/* Errors: the same classes, the same fields, as the Node build. */

export declare class TurboError extends Error {
  constructor(message: string, options?: { cause?: unknown });
  readonly cause?: unknown;
}
export declare class TurboConfigError extends TurboError {}
export declare class TurboKeyError extends TurboConfigError {}
export declare class TurboValidationError extends TurboError {}
export declare class TurboNetworkError extends TurboError {
  constructor(message: string, init?: { endpoint?: string; method?: string; cause?: unknown });
  readonly endpoint?: string;
  readonly method?: string;
}
export declare class TurboTimeoutError extends TurboError {
  constructor(message: string, init?: { endpoint?: string; method?: string; timeoutMs?: number; cause?: unknown });
  readonly endpoint?: string;
  readonly method?: string;
  readonly timeoutMs?: number;
}
export declare class TurboHTTPError extends TurboError {
  constructor(init: { status: number; statusText?: string; endpoint: string; method: string; body?: unknown; cause?: unknown });
  readonly status: number;
  readonly statusText?: string;
  readonly endpoint: string;
  readonly method: string;
  readonly body: unknown;
}
/** HTTP 402: the payer cannot pay. Retrying never helps. */
export declare class TurboPaymentError extends TurboHTTPError {}
export declare class TurboVerificationError extends TurboError {
  constructor(message: string, init?: { expectedId?: string; receivedId?: string; endpoint?: string });
  readonly expectedId?: string;
  readonly receivedId?: string;
  readonly endpoint?: string;
}
/** The wallet could not produce a usable signature. Nothing was uploaded. */
export declare class TurboSignerError extends TurboError {
  constructor(message: string, options?: { cause?: unknown });
}
