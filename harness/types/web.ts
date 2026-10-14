// Type-checks web.d.ts as a browser app sees it: bundler resolution with the
// browser condition and NO Node types, so a stray Buffer in web.d.ts fails.
import {
  TurboUpload, TESTNET, verifyDataItem, getSignatureData, TurboSignerError, TurboPaymentError,
  type SolanaWalletSigner, type SignedDataItem, type UploadResult,
} from "@ardrive/turbo-upload";
import * as viaSubpath from "@ardrive/turbo-upload/web";

declare const wallet: { publicKey: { toBytes(): Uint8Array }; signMessage(m: Uint8Array): Promise<Uint8Array> };
const signer: SolanaWalletSigner = wallet;
const client = TurboUpload.testnet({ signer });
const same: viaSubpath.TurboUpload = client;

async function flow(): Promise<string> {
  const item: SignedDataItem = await client.signAsync({ data: new Uint8Array(3), tags: [{ name: "a", value: "b" }] });
  const bytes: Uint8Array = item.binary;
  const size: number = client.getDataItemSize({ dataSize: 10 });
  const ok: boolean = await verifyDataItem(bytes, { verify: (m, s, p) => m.length + s.length + p.length > 0 });
  const sd: Uint8Array = getSignatureData(bytes);
  const res: UploadResult = await client.upload({ data: "x", paidBy: TESTNET.uploadUrl });
  try { await client.uploadSigned(item, { paidBy: "addr" }); } catch (e) {
    if (e instanceof TurboSignerError || e instanceof TurboPaymentError) return e.message;
  }
  return `${size}${ok}${sd.length}${res.id}${same.address}`;
}
void flow;

async function payments(): Promise<string> {
  const w = await client.getWincForToken(1_000_000_000n);
  const f = await client.getFreeQuota();
  const r = await client.submitFundTransaction("tx");
  const a = await client.shareCredits({ approvedAddress: "x", approvedWincAmount: "5", expiresBySeconds: 60 });
  const s = await client.createCheckoutSession({ amount: 1000, currency: "usd" });
  const addr: string = await client.getFundingAddress();
  return `${w.winc}${f.bytesRemaining}${r.status}${a.approvalDataItemId}${s.url}${addr}`;
}
void payments;

async function chunkedTypes(blob: Blob): Promise<string> {
  const r = await client.uploadStream({ streamFactory: () => blob.stream(), size: blob.size, chunking: "auto", onProgress: (p) => void p.processedBytes });
  const s = await client.upload({ data: new Uint8Array(1), chunking: "force", chunkSize: 5 * 1024 * 1024, chunkConcurrency: 2 });
  return r.id + s.id;
}
void chunkedTypes;

// viem's LocalAccount is an x402 signer as is, and a WalletClient adapts the way the README shows.
// Checked here rather than in node.ts: viem's own types do not compile under node16 resolution.
import type { WalletClient, Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { uploadUnsignedX402, type X402Signer } from "@ardrive/turbo-upload";
const local: X402Signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
void local;
async function x402Types(walletClient: WalletClient, account: Account): Promise<string> {
  const signer: X402Signer = { address: account.address, signTypedData: (t) => walletClient.signTypedData({ account, ...t }) };
  const r = await uploadUnsignedX402({ data: new Uint8Array(1), tags: [{ name: "a", value: "b" }], signer, maxUsdc: "20000", uploadUrl: TESTNET.uploadUrl });
  return r.id + r.owner;
}
void x402Types;

// An EVM signer for type 3: a viem LocalAccount plus viem's recoverPublicKey,
// and a WalletClient through the adapter the README shows.
import { recoverPublicKey, type WalletClient as EvmWalletClient, type Account as EvmAccount } from "viem";
import { privateKeyToAccount as evmAccount } from "viem/accounts";
import { type EvmSigner, verifyDataItem as verifyAny, SIGNATURE_TYPE_ETHEREUM } from "@ardrive/turbo-upload";
const fromAccount: EvmSigner = { ...evmAccount(`0x${"11".repeat(32)}`), recoverPublicKey };
async function evmTypes(walletClient: EvmWalletClient, account: EvmAccount): Promise<string> {
  const adapted: EvmSigner = {
    address: account.address,
    signMessage: ({ message }) => walletClient.signMessage({ account, message }),
    recoverPublicKey,
  };
  const c = TurboUpload.testnet({ signer: adapted, token: "base-eth" });
  const item = await c.signAsync({ data: "x" });
  const ok: boolean = await verifyAny(item.binary, { recoverPublicKey, strictV: true });
  const strict: boolean = await c.verify(item.binary, { strictV: true });
  return `${fromAccount.address}${ok}${strict}${SIGNATURE_TYPE_ETHEREUM}${c.token}`;
}
void evmTypes;
