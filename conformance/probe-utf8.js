// AVSCTap.writeString has TWO encoders: a hand-rolled loop for len<=64, Buffer.write for len>64.
// Do they agree on a lone surrogate?
const ARB = "/tmp/claude-1000/-mnt-c-source-sanning-io-aom/53472aba-ef33-4ece-94cd-bbb80849d7f8/scratchpad/minimal/node_modules/@dha-team/arbundles/build/node/cjs/src/";
const { serializeTags, deserializeTags } = require(ARB + "tags.js");

const lone = "\ud800";                       // unpaired high surrogate
const short = { name: "s", value: lone };
const padTo = (s, n) => s + "x".repeat(n - Buffer.byteLength(s));
const long  = { name: "s", value: padTo(lone, 70) };  // pushes len past 64

for (const [label, tag] of [["len<=64 (hand-rolled loop)", short], ["len>64 (Buffer.write)", long]]) {
  const b = serializeTags([tag]);
  console.log(label, "->", b.toString("hex"));
  console.log("   node Buffer.from(value,'utf8') =", Buffer.from(tag.value, "utf8").subarray(0, 6).toString("hex"));
}

// also: does a normal astral char round-trip identically in both paths?
const emoji = "\u{1f600}";
console.log("\nastral short:", serializeTags([{ name: "e", value: emoji }]).toString("hex"));
console.log("astral node :", Buffer.from(emoji, "utf8").toString("hex"));
const bigEmoji = emoji.repeat(20); // 80 bytes
const a = serializeTags([{ name: "e", value: bigEmoji }]).toString("hex");
const bExp = Buffer.from(bigEmoji, "utf8").toString("hex");
console.log("astral long path matches node utf8?", a.includes(bExp));

// empty name / empty value permitted?
for (const t of [{ name: "", value: "v" }, { name: "n", value: "" }, { name: "", value: "" }]) {
  try { console.log("tag", JSON.stringify(t), "->", serializeTags([t]).toString("hex"),
    "roundtrip:", JSON.stringify(deserializeTags(serializeTags([t])))); }
  catch (e) { console.log("tag", JSON.stringify(t), "THROWS", e.message); }
}
