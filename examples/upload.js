// Upload bytes with tags. The common case.
//
//   ARWEAVE_JWK="$(cat wallet.json)" node examples/upload.js
//
// The free tier is a LIFETIME allowance, not a per-upload one: roughly 10 MiB
// per wallet and per IP on production, with a per-item ceiling. Read the real
// numbers from the service rather than trusting this comment:
//   const { freeTier } = await client.getInfo();
// A small upload like this one is free until that allowance is used up.
const { TurboUpload, TESTNET } = require("@ardrive/turbo-upload");

// TurboUpload.testnet() rather than spreading TESTNET: the endpoint record
// also carries `name` and `gatewayUrl`, which are not constructor options and
// are rejected. Use TurboUpload.production() for the real thing, where uploads
// are permanent and paid for.
const client = TurboUpload.testnet({
  jwk: process.env.ARWEAVE_JWK,   // an object or a JSON string
});

(async () => {
  const { id, winc } = await client.upload({
    data: Buffer.from("hello permanence"),
    tags: [
      { name: "Content-Type", value: "text/plain" },
      { name: "App-Name", value: "my-app" },
    ],
  });

  console.log("id:  ", id);
  console.log("cost:", winc, "winc");            // "0" under the free limit
  console.log("url: ", `${TESTNET.gatewayUrl}/${id}`);
})();
