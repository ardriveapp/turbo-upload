const ref = require("./reference-signer.js");
const arb = require("./arbundles.js");
const jwk = require("./test-key.json");
(async () => {
  const owner = ref.ownerFromJwk(jwk);
  const b = ref.createDataItem({ data: Buffer.from("x"), owner, target: Buffer.from("target--------------------------") });
  const T = 1026;
  console.log("presence byte 0x01 (as built): ours tagsStart =", ref.parseDataItem(b).offsets.tags_start ?? ref.parseDataItem(b).offsets.tagsStart);
  for (const val of [0x00, 0x01, 0x02, 0xff]) {
    const c = Buffer.from(b); c[T] = val;
    const p = ref.parseDataItem(c);
    const item = new arb.DataItem(Buffer.from(c));
    let arbTargetLen, arbTagCount;
    try { arbTargetLen = item.rawTarget.length; arbTagCount = item.tags.length; }
    catch (e) { arbTargetLen = "throw"; arbTagCount = "throw: " + e.message.slice(0, 40); }
    console.log(`  presence=0x${val.toString(16).padStart(2,"0")}  ours: targetLen=${p.rawTarget.length} tagsStart=${p.offsets.tagsStart} tagCount=${p.tagCount}` +
                `   arbundles: targetLen=${arbTargetLen} tagCount=${arbTagCount}`);
  }
})();
