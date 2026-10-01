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
