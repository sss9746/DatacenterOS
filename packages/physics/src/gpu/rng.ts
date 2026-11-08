// Seeded mulberry32 with a serializable state (PhysicsWorld.rng_state = "mulberry32:0x%08x").
// Same generator as the v0 makeRng and the P1-1 fixture script, so seed 1 reproduces the fixture offsets.

export interface SeededRng {
  next(): number; // uniform [0, 1)
  state(): string;
}

const PREFIX = 'mulberry32:0x';

function fromRaw(raw: number): SeededRng {
  let a = raw >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => `${PREFIX}${a.toString(16).padStart(8, '0')}`,
  };
}

export function rngFromSeed(seed: number): SeededRng {
  return fromRaw(Number.isFinite(seed) ? Math.trunc(seed) : 0);
}

/** Resume from a serialized rng_state. Throws on a malformed state (trusted simulation input only). */
export function rngFromState(state: string): SeededRng {
  if (!state.startsWith(PREFIX)) throw new Error(`physics: bad rng_state ${state}`);
  const raw = Number.parseInt(state.slice(PREFIX.length), 16);
  if (!Number.isFinite(raw)) throw new Error(`physics: bad rng_state ${state}`);
  return fromRaw(raw);
}
