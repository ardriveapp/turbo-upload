// Get the id BEFORE uploading: to record it, price the real item, or hand the
// bytes to your own transport.
//
//   ARWEAVE_JWK="$(cat wallet.json)" node examples/sign-then-upload.js
//
// Use uploadSigned(). Calling upload() after sign() signs a SECOND time, and
// RSA-PSS draws a fresh random salt per signature, so you get a different id
// and a second paid item. The id you recorded would not be the one that landed.
const { TurboUpload } = require("@ardrive/turbo-upload");

// TurboUpload.testnet() rather than spreading TESTNET: that record carries
// `name` and `gatewayUrl`, which are not constructor options.
const client = TurboUpload.testnet({ jwk: process.env.ARWEAVE_JWK });

(async () => {
  const item = client.sign({
    data: Buffer.from("recorded before it was sent"),
    tags: [{ name: "Content-Type", value: "text/plain" }],
  });

  console.log("id known up front:", item.idB64Url);
  console.log("price for", item.binary.length, "bytes:",
    (await client.getUploadCost(item.binary.length)).winc, "winc");

  const res = await client.uploadSigned(item);      // NOT client.upload(item)
  console.log("landed as:", res.id, res.id === item.idB64Url ? "(same id)" : "(MISMATCH)");
})();
