import {
    developmentTurboConfiguration,
    TurboFactory,
} from "@ardrive/turbo-sdk/node";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const walletJSON = JSON.parse(process.env.WALLET);
const turboAuthClient = TurboFactory.authenticated({
    privateKey: walletJSON,
    ...developmentTurboConfiguration,
});

console.log("Uploading to Turbo...");
const filePath = new URL("../files/TOOMANY.txt", import.meta.url).pathname;
const fileSize = fs.statSync(filePath).size;
console.log("fileSize", fileSize);
const uploadResult = await turboAuthClient.uploadFile({
    fileStreamFactory: () => fs.createReadStream(filePath),
    fileSizeFactory: () => fileSize,
    // Optional abort signal
    // signal: AbortSignal.timeout(10_000)
});
console.log(JSON.stringify(uploadResult, null, 2));
