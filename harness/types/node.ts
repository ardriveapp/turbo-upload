// Type-checks index.d.ts as a Node app sees it (node16 resolution, Node types).
import {
  TurboUpload, createSolanaSigner, TurboSignerError, TurboVerificationError, TurboNetworkError,
  TurboTimeoutError, type SignedDataItem,
} from "@ardrive/turbo-upload";
import * as viaSubpath from "@ardrive/turbo-upload/node";

const signer = createSolanaSigner(new Uint8Array(32));
const fromSigner = new TurboUpload({ signer });
const fromKey: viaSubpath.TurboUpload = TurboUpload.testnet({ jwk: "[1,2,3]", token: "solana" });

async function flow(): Promise<number> {
  const a: SignedDataItem = fromKey.sign({ data: Buffer.from("x") });
  const b: SignedDataItem = await fromSigner.signAsync({ data: "y" });
  const buf: Buffer = b.binary;
  await fromSigner.upload({ data: "z", paidBy: fromKey.address });
  await fromKey.uploadSigned(a, { paidBy: "addr", timeoutMs: 1 });
  // The three error constructors index.d.ts used to declare without a message.
  const errors = [
    new TurboVerificationError("m", { expectedId: "a", receivedId: "b" }),
    new TurboNetworkError("m", { endpoint: "e", method: "GET" }),
    new TurboTimeoutError("m", { endpoint: "e", method: "GET", timeoutMs: 1 }),
    new TurboSignerError("m", { cause: new Error("x") }),
  ];
  return buf.length + errors.length + fromKey.getDataItemSize({ data: "abc" });
}
void flow;

async function payments(): Promise<string> {
  const s = await fromSigner.createCheckoutSession({ amount: 1000 });
  const r = await fromKey.submitFundTransaction("tx", { timeoutMs: 1 });
  const q: number | null = (await fromKey.getFreeQuota({ address: "a" })).bytesRemaining;
  return `${s.id}${r.status}${q}`;
}
void payments;

import { createReadStream } from "node:fs";
import { TurboChunkedUploadError } from "@ardrive/turbo-upload";
async function streamTypes(): Promise<string> {
  try {
    const r = await fromKey.uploadStream({ streamFactory: () => createReadStream("/dev/null"), size: 0, paidBy: "p" });
    return r.id;
  } catch (e) {
    if (e instanceof TurboChunkedUploadError) return `${e.uploadId}${e.uploadStatus}`;
    throw e;
  }
}
void streamTypes;

import { uploadUnsignedX402, getUnsignedX402Price, TurboPaymentError as X402Refused, type X402Signer } from "@ardrive/turbo-upload";
async function x402Types(signer: X402Signer): Promise<string> {
  const price = await getUnsignedX402Price({ byteCount: 100, uploadUrl: "https://upload.services.ar-io.dev" });
  try {
    const r = await uploadUnsignedX402({ data: Buffer.from("x"), signer, maxUsdc: 20_000n, uploadUrl: "https://upload.services.ar-io.dev" });
    return `${r.id}${r.payer}${r.x402Payment?.transactionHash}${price.usdcAmount}`;
  } catch (e) {
    if (e instanceof X402Refused) return e.message;
    throw e;
  }
}
void x402Types;

// An EVM signer in the shape viem's names give it, and the type 3 verify overload.
import { type EvmSigner, type RecoverPublicKey, verifyDataItem } from "@ardrive/turbo-upload";
async function evmTypes(recover: RecoverPublicKey, signMessage: EvmSigner["signMessage"]): Promise<string> {
  const evm = TurboUpload.testnet({ signer: { address: "0x0000000000000000000000000000000000000001", signMessage, recoverPublicKey: recover }, token: "base-usdc" });
  const item = await evm.signAsync({ data: "x" });
  const ok: boolean = await verifyDataItem(item.binary, { recoverPublicKey: recover, strictV: true });
  const sync: boolean = verifyDataItem(item.binary);
  const viaClient: boolean = await evm.verify(item.binary, { recoverPublicKey: recover });
  // With no options, a plain boolean on an EVM client too: a promise here would be truthy.
  const plain: boolean = evm.verify(item.binary);
  // @ts-expect-error the no-options call is not a promise
  void evm.verify(item.binary).then;
  return `${ok}${sync}${viaClient}${plain}${evm.address}`;
}
void evmTypes;
