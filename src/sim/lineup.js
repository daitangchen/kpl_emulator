/**
 * 巅峰对决 · 阵容博弈
 *
 * 真实的「巅峰对决」是双方**互不可见**地提交 5 个英雄 + 召唤师技能，且不受全局 BP 限制。
 * 所以决胜局比的不是"谁的人更强"，而是**赌阵容**：猜到对面想打什么，然后拿克制它的一套。
 *
 * 这里把这种博弈抽象成 5 种"阵容倾向"构成的克制环：
 *
 *     强开团 → 四一分推 → 远程消耗 → 保核反手 → 抓单集火 → （回到）强开团
 *
 *  - 猜中克制对手：决胜局战力 +3.5
 *  - 被对手克制：决胜局战力 -3.5
 *  - 双方一致 / 无克制关系：不加不减
 *  - 额外：所选阵容与自家战术风格契合，再 +1（"这就是我们最熟的那套"）
 *
 * AI 的选择**不是纯随机**：它会按自己的战术风格偏向某几套阵容。
 * 玩家可以看到对手的风格标签，从而"读"出它大概率会选什么 —— 这才是博弈。
 */
import { STYLES } from '../data/teams.js';

export const LINEUPS = [
  {
    id: 'teamfight', name: '正面强开团', icon: '⚔️',
    desc: '五虎齐冲，一波正面团定胜负。',
    beats: 'split', losesTo: 'collapse',
  },
  {
    id: 'split', name: '四一分推', icon: '🧭',
    desc: '一路带线牵制，靠运营把对面耗死。',
    beats: 'poke', losesTo: 'teamfight',
  },
  {
    id: 'poke', name: '远程消耗', icon: '🏹',
    desc: '风筝流，逼对面接不住团。',
    beats: 'protect', losesTo: 'split',
  },
  {
    id: 'protect', name: '保核反手', icon: '🛡',
    desc: '围绕核心打反手，拖到后期一波带走。',
    beats: 'collapse', losesTo: 'poke',
  },
  {
    id: 'collapse', name: '抓单集火', icon: '🎯',
    desc: '放弃正面，专抓对面核心落点。',
    beats: 'teamfight', losesTo: 'protect',
  },
];

export const LINEUP_BY_ID = Object.fromEntries(LINEUPS.map((l) => [l.id, l]));

/** 猜中克制的战力修正 */
export const COUNTER_BONUS = 3.5;
/** 阵容与自家风格契合的额外修正 */
export const AFFINITY_BONUS = 1;

/** 战术风格 → 偏好的阵容（AI 会按这个概率表出招） */
const STYLE_PREFERENCE = {
  aggro: ['teamfight', 'collapse', 'teamfight'],
  macro: ['split', 'poke', 'split'],
  protect: ['protect', 'protect', 'poke'],
  flex: ['poke', 'split', 'protect'],
  late: ['protect', 'teamfight', 'protect'],
};

/** 阵容与风格是否契合 */
export function styleAffinity(style, lineupId) {
  return (STYLE_PREFERENCE[style] || []).includes(lineupId);
}

/**
 * AI 的阵容选择
 * 70% 按自家风格偏好出招，30% 随机 —— 所以"读风格"是有价值的，但不是必胜
 */
export function aiLineup(game, teamId, rng) {
  const style = game.teams[teamId]?.style || 'flex';
  const pref = STYLE_PREFERENCE[style] || null;
  if (pref && rng.chance(0.7)) return rng.pick(pref);
  return rng.pick(LINEUPS).id;
}

/** a 对 b 的克制关系：1 = 克制，-1 = 被克制，0 = 无关 */
export function counterOf(a, b) {
  const A = LINEUP_BY_ID[a];
  if (!A || a === b) return 0;
  if (A.beats === b) return 1;
  if (A.losesTo === b) return -1;
  return 0;
}

/**
 * 结算一次博弈
 * @returns {{mine:string, theirs:string, counter:number, affinity:boolean, bonus:number, text:string}}
 */
export function resolveLineup(game, myTeamId, oppTeamId, myId, theirId, rng) {
  const counter = counterOf(myId, theirId);
  const affinity = styleAffinity(game.teams[myTeamId]?.style || 'flex', myId);
  let bonus = counter * COUNTER_BONUS;
  if (affinity) bonus += AFFINITY_BONUS;

  const mine = LINEUP_BY_ID[myId];
  const theirs = LINEUP_BY_ID[theirId];
  const myStyle = STYLES[game.teams[myTeamId]?.style]?.name || '—';
  let text;
  if (counter > 0) text = `你拿「${mine.name}」正好克住对面的「${theirs.name}」，决胜局气势在你这边。`;
  else if (counter < 0) text = `对面的「${theirs.name}」反过来克住了你的「${mine.name}」，决胜局要打逆风。`;
  else text = `双方都是「${mine.name}」方向，谁发挥好谁赢。`;
  if (affinity) text += `（这套「${mine.name}」也正是 ${myStyle} 风格最熟的打法）`;

  return { mine: myId, theirs: theirId, counter, affinity, bonus: Math.round(bonus * 10) / 10, text };
}
