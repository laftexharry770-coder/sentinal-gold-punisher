/** Web Crypto is global in Node 18+ and in every supported browser. */
function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID().replace(/-/g, '');
  if (webCrypto?.getRandomValues) {
    const bytes = webCrypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2).padEnd(12, '0');
}

export function uid(prefix = ''): string {
  const id = randomId().slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}

/** Mulberry32 — small deterministic PRNG so runs can be reproduced from a seed. */
export function createRng(seed: number | null): () => number {
  if (seed === null) return Math.random;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform for normally distributed noise. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
