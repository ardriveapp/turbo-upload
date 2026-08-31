const S = require("./reference-signer.js");
const jwk = require("./test-key.json");
const UPLOAD = "https://upload.services.ar-io.dev";
const GATEWAY = "https://ar-io.dev";
const stamp = new Date().toISOString();
const data = Buffer.from(`PDS zero-dep ANS-104 round trip ${stamp}\n`, "utf8");
const tags = [
  { name: "App-Name", value: "pds-ans104-conformance" },
  { name: "Content-Type", value: "text/plain" },
  { name: "Chain-Id", value: "11155111" },
  { name: "Match-Quality", value: "full" },
  { name: "Unicode-Check", value: "héllo ✅ 日本語" },
];
(async () => {
  const item = S.signDataItem(jwk, { data, tags });
  const buf = Buffer.from(item.binary);
  console.log("  signed locally");
  console.log("    bytes      :", buf.length);
  console.log("    our id     :", item.idB64Url);
  console.log("    salt length:", S.maxSaltLength(4096, 32), "bytes");
  console.log("    self-verify:", S.verifyDataItem(buf));

  const res = await fetch(`${UPLOAD}/v1/tx`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buf,
  });
  const body = await res.text();
  console.log("  POST /v1/tx ->", res.status);
  console.log("   ", body.slice(0, 400));
  if (!res.ok) process.exit(1);
  let id;
  try { id = JSON.parse(body).id; } catch { id = item.idB64Url; }
  console.log("    service id :", id, id === item.idB64Url ? "(MATCHES ours)" : "(DIFFERS from ours!)");

  for (let i = 1; i <= 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const g = await fetch(`${GATEWAY}/${id}`).catch(() => null);
    if (g && g.ok) {
      const got = Buffer.from(await g.arrayBuffer());
      console.log(`  GET ${GATEWAY}/${id} -> ${g.status} after ~${i * 5}s`);
      console.log("    bytes match:", got.equals(data));
      console.log("    content    :", JSON.stringify(got.toString("utf8").slice(0, 60)));
      console.log("    ct header  :", g.headers.get("content-type"));
      process.exit(0);
    }
    process.stdout.write(`    retrieval attempt ${i} -> ${g ? g.status : "err"}\n`);
  }
  console.log("  retrieval did not resolve within 60s (may still land later)");
})();
