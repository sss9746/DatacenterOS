import type { Rng } from './types.js';

/** mulberry32: a deterministic PRNG returning uniform numbers in [0, 1). For eval/tests and B's tick. */
export function makeRng(seed: number): Rng {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
