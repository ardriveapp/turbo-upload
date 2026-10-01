// Deterministic test payloads, shared by the page and by Node.
//
// The page uploads bytes it generates from a seed; Node regenerates the same
// bytes from the same seed and compares them with what the gateway serves.
// That keeps a 200 MiB payload out of the bridge between the two.

/** FNV-1a over a string, as the PRNG seed. */
function seedFrom(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `length` bytes from mulberry32, seeded by `seedText`. Not cryptographic; it does not need to be. */
export function deterministicBytes(seedText, length) {
  const out = new Uint8Array(length);
  let a = seedFrom(seedText);
  let i = 0;
  for (; i + 4 <= length; i += 4) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    t = (t ^ (t >>> 14)) >>> 0;
    out[i] = t;
    out[i + 1] = t >>> 8;
    out[i + 2] = t >>> 16;
    out[i + 3] = t >>> 24;
  }
  for (; i < length; i++) out[i] = (a = (Math.imul(a, 1103515245) + 12345) >>> 0) >>> 24;
  return out;
}

/** The hosts any test here may reach. Production hosts and mainnet RPC are absent on purpose. */
export const DEVNET_HOSTS = Object.freeze([
  "upload.services.ar-io.dev",
  "payment.services.ar-io.dev",
  "ar-io.dev",
  "api.devnet.solana.com",
]);

/** A fetch that refuses every host not in DEVNET_HOSTS, before any request leaves. */
export function guardedFetch(innerFetch) {
  return (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const host = new URL(url).hostname;
    if (!DEVNET_HOSTS.includes(host)) {
      return Promise.reject(new Error(`REFUSED: ${host} is not a devnet host`));
    }
    return innerFetch(input, init);
  };
}
