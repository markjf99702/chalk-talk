// A small seeded random source (mulberry32), so a snap can be replayed exactly from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.normal = () => {
    const u = Math.max(r(), 1e-9), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  r.pick = list => list[Math.floor(r() * list.length)];
  r.chance = p => r() < p;
  return r;
}

export const newSeed = () => (Math.random() * 0xFFFFFFFF) >>> 0;
