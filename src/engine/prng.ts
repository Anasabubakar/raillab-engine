/** Deterministic pseudo-random numbers (mulberry32). The same seed always yields the same sequence on every platform. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("seed must be an integer from 0 to 4294967295");
    this.state = seed >>> 0;
  }
  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError("invalid integer range");
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** A lowercase hex string of the given length. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += Math.floor(this.next() * 0x10000).toString(16).padStart(4, "0");
    return out.slice(0, length);
  }
}

/** Derive an independent stream for a named purpose so adding a fault never reshuffles unrelated randomness. */
export function rngFor(seed: number, purpose: string): Rng {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < purpose.length; i++) {
    h ^= purpose.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return new Rng(h >>> 0);
}
