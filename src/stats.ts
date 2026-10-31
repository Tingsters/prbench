// Small, dependency-free statistics for paired comparisons.

/** Two-sided exact sign test: probability of a split at least this uneven if both systems were equally good. Ties are dropped. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Deterministic PRNG so reports are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for the mean of `values`. */
export function bootstrapMeanCI(values: number[], opts: { resamples?: number; level?: number; seed?: number } = {}): [number, number] {
  if (values.length === 0) return [NaN, NaN];
  const resamples = opts.resamples ?? 5000;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 1);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rand() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * resamples)]!;
  const hi = means[Math.min(resamples - 1, Math.ceil((1 - (1 - level) / 2) * resamples) - 1)]!;
  return [lo, hi];
}

/** Cohen's kappa for two raters labelling the same items. */
export function cohenKappa(a: string[], b: string[]): number {
  if (a.length !== b.length) throw new Error('raters labelled different numbers of items');
  const n = a.length;
  if (n === 0) return NaN;
  const cats = [...new Set([...a, ...b])];
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n;
  let pe = 0;
  for (const c of cats) pe += (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
