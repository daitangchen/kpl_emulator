/**
 * 抽卡建队
 *
 * 选定战队后，首发五人不再由固定名单决定，而是从全联盟球员卡池里抽出来。
 *  - 五个位置各抽一次（对抗路 / 打野 / 中路 / 发育路 / 游走）
 *  - 按稀有度分档：SSR 传说 / SR 史诗 / R 稀有 / N 普通
 *  - 每档有基础概率，带保底（连抽两次没出史诗及以上，下一次保底史诗）
 *  - 不满意可以重抽，前几次免费，之后消耗资金（这就是第一处资金决策）
 *
 * 抽卡发生在建档之前，所以这里用的是静态球员表（PLAYERS），不依赖存档。
 * 抽中的球员在 createGame 时会被移入玩家战队，原战队由开季的 repairSquad 自动补位。
 */
import { PLAYERS, ROLE_ORDER } from '../data/players.js';

/** 稀有度分档（相对水平：按该位置的球员池分位），顺序即从高到低 */
export const RARITIES = [
  { key: 'SSR', name: '传说', tone: 'gold', stars: 5, desc: '该位置前 8%' },
  { key: 'SR', name: '史诗', tone: 'purple', stars: 4, desc: '该位置前 8%~38%' },
  { key: 'R', name: '稀有', tone: 'blue', stars: 3, desc: '该位置前 38%~74%' },
  { key: 'N', name: '普通', tone: 'plain', stars: 2, desc: '其余' },
];

/** 各档出现概率（合计 1.0），顺序与 RARITIES 对齐；同时用作分档的人数比例 */
export const RARITY_RATES = [0.08, 0.30, 0.36, 0.26];

/**
 * 预计算：每个位置的球员按综合评分排序，再按 RARITY_RATES 切成 4 档。
 * 用「相对水平」而不是绝对分数线，保证每个位置都有 SSR 可抽
 * （例如对抗路最高只有 83，用绝对线就永远抽不到传说）。
 */
const ROLE_POOL = {};
const BAND_OF = {};
(function buildBands() {
  for (const role of ROLE_ORDER) {
    const list = PLAYERS.filter((p) => p.role === role).sort((a, b) => b.overall - a.overall);
    ROLE_POOL[role] = list;
    let i = 0;
    for (let band = 0; band < RARITIES.length && i < list.length; band += 1) {
      const remain = list.length - i;
      const want = band === RARITIES.length - 1 ? remain : Math.max(1, Math.round(list.length * RARITY_RATES[band]));
      const n = Math.min(remain, want);
      for (let k = 0; k < n; k += 1) { BAND_OF[list[i].id] = band; i += 1; }
    }
    while (i < list.length) { BAND_OF[list[i].id] = RARITIES.length - 1; i += 1; }
  }
}());

export const rarityIndex = (player) => BAND_OF[player?.id] ?? RARITIES.length - 1;
export const rarityOf = (player) => RARITIES[rarityIndex(player)];

/** 重抽：前 3 次免费，之后按 80 万起、每次 ×1.6 递增 */
export const FREE_REROLLS = 3;
export function rerollCost(draft) {
  const paid = Math.max(0, draft.rerollsUsed - FREE_REROLLS);
  if (paid <= 0) return 0;
  return Math.round(80 * Math.pow(1.6, paid - 1));
}

export function createDraft() {
  const slots = {};
  for (const role of ROLE_ORDER) slots[role] = null;
  return {
    slots,                 // role -> playerId
    taken: [],             // 当前已占用的球员 id（重抽时释放）
    pity: {},              // role -> 连续未出史诗及以上的次数
    rerollsUsed: 0,
    spent: 0,
    last: null,            // 最近一次抽卡结果，用于界面高亮
  };
}

/** 某位置当前还有哪些稀有度档可选 */
function availableBands(role, taken) {
  const takenSet = new Set(taken);
  const have = new Set();
  for (const p of PLAYERS) {
    if (p.role !== role || takenSet.has(p.id)) continue;
    have.add(rarityIndex(p));
  }
  return have;
}

/**
 * 抽一个档位：只在"该位置实际有人的档位"里按概率抽，并重新归一化。
 * 这样即使某个位置没有传说级球员（例如对抗路最高只有 84），概率也会自动分配，
 * 不会白白浪费 8% 的抽卡机会。
 */
function rollBand(rng, pity, avail) {
  let idxs = RARITIES.map((_, i) => i).filter((i) => avail.has(i));
  if (!idxs.length) return -1;
  if (pity >= 2) {                       // 保底：至少史诗
    const strong = idxs.filter((i) => i <= 1);
    if (strong.length) idxs = strong;
  }
  const weights = idxs.map((i) => RARITY_RATES[i]);
  return idxs[rng.weighted(weights)];
}

/** 在指定位置、指定档位附近找候选球员：该档空了就往弱档找，再往强档找 */
function pickRandomCandidate(rng, role, taken, band) {
  const takenSet = new Set(taken);
  const inRole = PLAYERS.filter((p) => p.role === role && !takenSet.has(p.id));
  if (!inRole.length) return null;
  if (band < 0) return rng.pick(inRole);
  const order = [];
  for (let d = 0; band + d < RARITIES.length; d += 1) order.push(band + d);
  for (let d = 1; band - d >= 0; d += 1) order.push(band - d);
  for (const b of order) {
    const list = inRole.filter((p) => rarityIndex(p) === b);
    if (list.length) return rng.pick(list);
  }
  return rng.pick(inRole);
}

function commit(draft, role, player) {
  const old = draft.slots[role];
  if (old && old !== player.id) draft.taken = draft.taken.filter((id) => id !== old);
  draft.slots[role] = player.id;
  if (!draft.taken.includes(player.id)) draft.taken.push(player.id);
  draft.last = { role, playerId: player.id, rarity: rarityOf(player).key };
}

/** 给某个位置抽一张（首次） */
export function drawRole(rng, draft, role) {
  if (draft.slots[role]) return null;
  const avail = availableBands(role, draft.taken);
  const band = rollBand(rng, draft.pity[role] || 0, avail);
  const p = pickRandomCandidate(rng, role, draft.taken, band);
  if (!p) return null;
  commit(draft, role, p);
  draft.pity[role] = rarityIndex(p) <= 1 ? 0 : (draft.pity[role] || 0) + 1;
  return p;
}

/** 把没抽满的位置一次补齐（省点击） */
export function drawAll(rng, draft) {
  const out = [];
  for (const role of ROLE_ORDER) {
    if (!draft.slots[role]) { const p = drawRole(rng, draft, role); if (p) out.push(p); }
  }
  return out;
}

/**
 * 重抽某个位置
 * @param {number} budget 可用现金（万元）
 */
export function reroll(rng, draft, role, budget) {
  if (!draft.slots[role]) return { ok: false, reason: '该位置还没有抽卡' };
  const cost = rerollCost(draft);
  if (cost > 0 && budget < cost) return { ok: false, reason: `现金不足：重抽需要 ${cost} 万` };
  const old = draft.slots[role];
  const avail = availableBands(role, draft.taken.filter((id) => id !== old));
  const band = rollBand(rng, Math.min(2, draft.pity[role] || 0), avail);   // 重抽同样吃保底
  const p = pickRandomCandidate(rng, role, draft.taken.filter((id) => id !== old), band);
  if (!p) return { ok: false, reason: '没有可抽的球员了' };
  commit(draft, role, p);
  draft.rerollsUsed += 1;
  draft.spent += cost;
  draft.pity[role] = rarityIndex(p) <= 1 ? 0 : (draft.pity[role] || 0) + 1;
  return { ok: true, player: p, cost, rarity: rarityOf(p) };
}

export const draftReady = (draft) => ROLE_ORDER.every((r) => !!draft.slots[r]);

/** 按位置顺序给出抽卡结果（供 createGame 使用） */
export function draftStarters(draft) {
  return ROLE_ORDER.map((r) => draft.slots[r]).filter(Boolean);
}

/** 抽到的这套阵容的汇总信息 */
export function draftSummary(draft) {
  const ids = draftStarters(draft);
  const players = ids.map((id) => PLAYERS.find((p) => p.id === id)).filter(Boolean);
  const avg = players.length ? players.reduce((s, p) => s + p.overall, 0) / players.length : 0;
  const wage = players.reduce((s, p) => s + (p.wage || 0), 0);
  const counts = {};
  for (const p of players) {
    const k = rarityOf(p).key;
    counts[k] = (counts[k] || 0) + 1;
  }
  return { players, avg: Number(avg.toFixed(1)), wage, counts };
}
