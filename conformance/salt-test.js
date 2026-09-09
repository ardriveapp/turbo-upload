const S = require("./reference-signer.js");
const jwk = require("./test-key.json");
const data = Buffer.from(`salt-length conformance probe ${new Date().toISOString()}\n`);
const tags = [{ name: "App-Name", value: "pds-salt-probe" }, { name: "Content-Type", value: "text/plain" }];
(async () => {
  for (const [label, opts] of [["conformant (478, arbundles default)", {}],
                               ["digest-length (32), what a reimplementer picks", { saltLength: 32 }]]) {
    const item = S.signDataItem(jwk, { data: Buffer.concat([data, Buffer.from(label)]), tags, ...opts });
    const buf = Buffer.from(item.binary);
    const res = await fetch("https://upload.services.ar-io.dev/v1/tx", {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf });
    const txt = await res.text();
    let ok = "?"; try { ok = JSON.parse(txt).id ? "accepted" : txt.slice(0,120); } catch { ok = txt.slice(0,140); }
    console.log(`  ${label}`);
    console.log(`    local self-verify : ${S.verifyDataItem(buf)}`);
    console.log(`    strict-salt check : ${S.verifyDataItem(buf, { strictSaltLength: true })}`);
    console.log(`    upload service    : HTTP ${res.status}  ${ok}`);
  }
})();
