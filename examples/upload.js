// Upload bytes with tags. The common case.
//
//   ARWEAVE_JWK="$(cat wallet.json)" node examples/upload.js
//
// Uploads under 107,520 bytes are free, so this costs nothing.
const { TurboUpload, TESTNET } = require("@ardrive/turbo-upload");

const client = new TurboUpload({
  jwk: process.env.ARWEAVE_JWK,   // an object or a JSON string
  ...TESTNET,                     // drop this line to use production
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
