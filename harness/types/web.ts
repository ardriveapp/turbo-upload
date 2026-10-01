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
