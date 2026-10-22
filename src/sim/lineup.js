/**
 * 巅峰对决 · 阵容博弈（真实英雄 BP 版）
 *
 * 真实的「巅峰对决」是双方**互不可见**地提交 5 个英雄（对抗路/打野/中路/发育路/游走各一），
 * 且不受全局 BP 限制。决胜局比的是：
 *   1. 版本强势（拿 T0/出场率高的英雄有硬收益）
 *   2. 打法克制（5 种阵容倾向构成克制环）
 *   3. 风格契合（这正好是自家最熟的打法）
 *
 * 克制环：强开团 → 四一分推 → 远程消耗 → 保核反手 → 抓单集火 →（回到）强开团
 *
 * AI 的选择**不是纯随机**：它会按自己的战术风格偏向某些打法倾向，再在倾向内偏好高出场率英雄。
 * 玩家能看到对手的风格标签与「版本强势阵容」参考，从而"读"出它大概率会拿什么。
 */
import { STYLES } from '../data/teams.js';
import { HEROES, HERO_BY_ID, POSITIONS, heroesByPos } from '../data/heroes.js';

export { HEROES, HERO_BY_ID, POSITIONS, heroesByPos };

/** 5 种打法倾向的克制环 */
export const LINEUPS = [
  { id: 'teamfight', name: '正面强开团', icon: '⚔️', beats: 'split', losesTo: 'collapse' },
  { id: 'split', name: '四一分推', icon: '🧭', beats: 'poke', losesTo: 'teamfight' },
  { id: 'poke', name: '远程消耗', icon: '🏹', beats: 'protect', losesTo: 'split' },
  { id: 'protect', name: '保核反手', icon: '🛡', beats: 'collapse', losesTo: 'poke' },
  { id: 'collapse', name: '抓单集火', icon: '🎯', beats: 'teamfight', losesTo: 'protect' },
];
export const LINEUP_BY_ID = Object.fromEntries(LINEUPS.map((l) => [l.id, l]));

/** 猜中克制的战力修正 */
export const COUNTER_BONUS = 3.5;
/** 阵容与自家风格契合的额外修正 */
export const AFFINITY_BONUS = 1;
/** 每个英雄的"版本强度分"（T0 强、T2 弱） */
export const TIER_SCORE = { 0: 1.0, 1: 0.4, 2: 0 };
/** 双方强度分差换算成战力的比例 */
export const POWER_SCALE = 1.2;

/** 战术风格 → 偏好的打法倾向（AI 会按这个概率表出招） */
const STYLE_PREFERENCE = {
  aggro: ['teamfight', 'collapse', 'teamfight'],
  macro: ['split', 'poke', 'split'],
  protect: ['protect', 'protect', 'poke'],
  flex: ['poke', 'split', 'protect'],
  late: ['protect', 'teamfight', 'protect'],
};

/**
 * 某支战队的 BP 习惯（供玩家在巅峰对决前"读"对手）
 * 由战术风格确定打法倾向，再取该倾向在各位置出场率最高的英雄作为"招牌"。
 */
export function teamBpHabit(game, teamId) {
  const style = game.teams[teamId]?.style || 'flex';
  const pref = STYLE_PREFERENCE[style] || [];
  const tendency = pref[0] || 'flex';
  const signatures = POSITIONS.map((p) => {
    const pool = heroesByPos(p.key);
    const favored = pool.filter((h) => pref.includes(h.style));
    return { pos: p.key, hero: (favored.length ? favored : pool)[0] };
  });
  return {
    styleName: STYLES[style]?.name || '—',
    tendency,
    tendencyName: LINEUP_BY_ID[tendency]?.name || '—',
    signatures,
  };
}

/** 打法倾向与风格是否契合 */
export function styleAffinity(style, tendencyId) {
  return (STYLE_PREFERENCE[style] || []).includes(tendencyId);
}

/** a 对 b 的克制关系：1 = 克制，-1 = 被克制，0 = 无关 */
export function counterOf(a, b) {
  const A = LINEUP_BY_ID[a];
  if (!A || a === b) return 0;
  if (A.beats === b) return 1;
  if (A.losesTo === b) return -1;
  return 0;
}

/** 当前版本强势阵容：每个位置取出场率最高的英雄（即版本答案） */
export function metaRecommendation() {
  return POSITIONS.map((p) => heroesByPos(p.key)[0]);
}

/** 一组 5 英雄的打法倾向（取出现最多的倾向，平局取第一个） */
export function lineupTendency(pickIds) {
  const cnt = {};
  for (const id of pickIds) {
    const h = HERO_BY_ID[id];
    if (h) cnt[h.style] = (cnt[h.style] || 0) + 1;
  }
  let best = null;
  for (const [k, v] of Object.entries(cnt)) if (!best || v > best[1]) best = [k, v];
  return best ? best[0] : 'flex';
}

/** 一组 5 英雄的版本强度总分（T0 加分多） */
export function lineupPower(pickIds) {
  return pickIds.reduce((s, id) => s + (TIER_SCORE[HERO_BY_ID[id]?.tier] ?? 0), 0);
}

/** 按出场率加权随机选一个英雄（强势英雄更容易被选） */
function pickWeighted(pool, rng) {
  const idx = rng.weighted(pool.map((h) => h.rate + 5));
  return pool[idx];
}

/**
 * AI 的巅峰对决选人：每个位置选一个英雄。
 * 70% 往自家风格偏好的打法倾向里选，30% 随机；倾向内偏好高出场率英雄。
 */
export function aiPeakPicks(game, teamId, rng) {
  const style = game.teams[teamId]?.style || 'flex';
  const pref = STYLE_PREFERENCE[style] || null;
  const picks = [];
  for (const p of POSITIONS) {
    const pool = heroesByPos(p.key);
    let chosen;
    if (pref && rng.chance(0.7)) {
      const favored = pool.filter((h) => pref.includes(h.style));
      chosen = pickWeighted(favored.length ? favored : pool, rng);
    } else {
      chosen = pickWeighted(pool, rng);
    }
    picks.push(chosen.id);
  }
  return picks;
}

/** 把玩家的选人规整成"5 个位置各一个"（缺失的位置用版本强势补上） */
export function normalizePicks(picks) {
  const rec = { my: [], theirs: null };
  const used = new Set();
  const raw = Array.isArray(picks) ? picks : [];
  for (const id of raw) {
    const h = HERO_BY_ID[id];
    if (h && !used.has(h.pos)) { rec.my.push(id); used.add(h.pos); }
  }
  // 缺的位置按版本强势补齐
  for (const p of POSITIONS) {
    if (!used.has(p.key)) {
      const hero = heroesByPos(p.key)[0];
      rec.my.push(hero.id);
      used.add(p.key);
    }
  }
  // 按标准位置顺序排好
  const order = POSITIONS.map((p) => p.key);
  rec.my.sort((a, b) => order.indexOf(HERO_BY_ID[a].pos) - order.indexOf(HERO_BY_ID[b].pos));
  return rec.my;
}

/**
 * 结算一次巅峰对决 BP
 * @returns {{mine:string[], theirs:string[], myPower:number, theirPower:number, counter:number, affinity:boolean, bonus:number, text:string}}
 */
export function resolvePeak(game, myTeamId, oppTeamId, myPicks, theirPicks) {
  const mine = normalizePicks(myPicks);
  const theirs = normalizePicks(theirPicks);

  const myTendency = lineupTendency(mine);
  const theirTendency = lineupTendency(theirs);
  const counter = counterOf(myTendency, theirTendency);
  const affinity = styleAffinity(game.teams[myTeamId]?.style || 'flex', myTendency);

  const myPower = lineupPower(mine);
  const theirPower = lineupPower(theirs);
  const powerDiff = Math.round((myPower - theirPower) * 10) / 10;

  let bonus = counter * COUNTER_BONUS + powerDiff * POWER_SCALE;
  if (affinity) bonus += AFFINITY_BONUS;

  const myLineup = LINEUP_BY_ID[myTendency];
  const theirLineup = LINEUP_BY_ID[theirTendency];
  const myStyle = STYLES[game.teams[myTeamId]?.style]?.name || '—';
  const parts = [];
  if (powerDiff > 0) parts.push(`你的阵容版本强度领先（+${powerDiff.toFixed(1)}）`);
  else if (powerDiff < 0) parts.push(`对手的阵容版本强度更高（${powerDiff.toFixed(1)}）`);
  else parts.push('双方阵容版本强度相当');
  if (counter > 0) parts.push(`你的「${myLineup.name}」克制对面的「${theirLineup.name}」`);
  else if (counter < 0) parts.push(`对面的「${theirLineup.name}」克制你的「${myLineup.name}」`);
  else parts.push(`双方都是「${myLineup.name}」思路`);
  if (affinity) parts.push(`这也是 ${myStyle} 风格最熟的打法`);
  const text = parts.join('；') + '。';

  return {
    mine, theirs,
    myPower, theirPower, powerDiff,
    myTendency, theirTendency,
    counter, affinity,
    bonus: Math.round(bonus * 10) / 10,
    text,
  };
}
