export interface SeededRng {
  next(): number;
  nextInt(maxExclusive: number): number;
  pick<T>(items: T[]): T | undefined;
  state(): number;
}

export const createRng = (seed: number): SeededRng => {
  let state = seed >>> 0;

  const next = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    nextInt(maxExclusive) {
      if (maxExclusive <= 0) {
        return 0;
      }

      return Math.floor(next() * maxExclusive);
    },
    pick(items) {
      if (items.length === 0) {
        return undefined;
      }

      return items[this.nextInt(items.length)];
    },
    state() {
      return state >>> 0;
    }
  };
};
