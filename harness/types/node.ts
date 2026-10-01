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
