/**
 * 可复现的伪随机数（mulberry32）
 * 存档里保存 seed 与调用次数，读档后能接着推演，保证同一存档结果一致。
 */
export function createRng(seed = 20261005) {
  let s = seed >>> 0;
  let calls = 0;
  const next = () => {
    calls += 1;
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** [min, max) 浮点 */
    range: (min, max) => min + next() * (max - min),
    /** [min, max] 整数 */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** 概率命中 */
    chance: (p) => next() < p,
    /** 数组随机取一个 */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** 原地洗牌（Fisher-Yates） */
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** 按权重取索引 */
    weighted(weights) {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < weights.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return i;
      }
      return weights.length - 1;
    },
    get seed() { return seed; },
    get calls() { return calls; },
    toJSON: () => ({ seed, calls }),
    restore: (snap) => { seed = snap.seed; s = seed >>> 0; calls = 0; for (let i = 0; i < snap.calls; i += 1) next(); },
  };
}

/** 逻辑斯蒂：把战力差映射成胜率，斜率越大越"实力说话" */
export function winProbability(diff, k = 0.085) {
  const p = 1 / (1 + Math.exp(-diff * k));
  return Math.min(0.94, Math.max(0.06, p));
}
