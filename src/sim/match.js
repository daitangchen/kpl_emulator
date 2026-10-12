/**
 * 比赛模拟引擎
 *
 * 用户的硬性规则：
 *   BO5 → 一次模拟直接出最终比分（3-0 / 3-1 / 3-2）
 *   BO7 → 第 1 步模拟前三局，出一段结果；若已 3-0 结束
 *         第 2 步模拟第 4-6 局；若已 4 胜结束
 *         3-3 → 触发【巅峰对决】，单独模拟第 7 局
 *   决赛（BO9）→ 同样分段：前 4 局 → 中 3 局 → 第 8 局 → 巅峰对决第 9 局
 */
import { winProbability } from '../core/rng.js';

/** 单局胜率：战力差 + 分段微调（追分、赛点压力、主场） */
function gameWinProb(ctx, gameNo, scoreA, scoreB) {
  let diff = ctx.powerA - ctx.powerB;
  // 落后方背水一战，略微提升
  if (scoreA < scoreB) diff += 1.6;
  else if (scoreB < scoreA) diff -= 1.6;
  // 决胜局更看心态：心态属性（teamfight 近似）占更大权重
  if (gameNo >= ctx.deciderFrom) diff = diff * 0.78 + ctx.mentalityDiff * 0.5;
  // 主场
  diff += ctx.homeAdvantage;
  // 长系列赛的体力衰减
  diff -= ctx.fatigueA - ctx.fatigueB;
  return winProbability(diff, ctx.slope);
}

/**
 * 分段切分
 *   BO5：[5]                    —— 一次打完（打到一方 3 胜为止，最多 5 局）
 *   BO7：[3, 6, 7]              —— 上半场(1-3) / 下半场(4-6) / 巅峰对决(7)
 *   BO9：[4, 7, 8, 9]           —— 前 4 局 / 中 3 局 / 第 8 局 / 巅峰对决
 *
 * ⚠️ 历史 bug：BO5 曾经写成 [3]，而 simulateSeries 的循环在"段用完了"时就退出，
 * 于是 BO5 会在第 3 局结束（出现 2-1 这种比分）——相当于把 BO5 打成了 BO3。
 * 这里必须保证"段边界 ≥ 决出胜负所需的最大局数"。
 */
export function segmentPlan(bestOf) {
  if (bestOf === 5) return [5];
  if (bestOf === 7) return [3, 6, 7];
  return [4, 7, 8, 9];
}

/** 构造单局模拟上下文（战力、心态、主场、疲劳、决胜局门槛） */
export function buildCtx(p) {
  const { teamA, teamB } = p;
  const bestOf = p.bestOf ?? 5;
  const homeA = p.homeTeamId === teamA.id ? 1 : 0;
  return {
    powerA: teamA.power,
    powerB: teamB.power,
    mentalityDiff: (teamA.mentality ?? 60) - (teamB.mentality ?? 60),
    homeAdvantage: homeA ? (p.homeBonus ?? 2.2) : -(p.homeBonus ?? 2.2),
    fatigueA: p.fatigueA ?? 0,
    fatigueB: p.fatigueB ?? 0,
    slope: p.slope ?? 0.085,
    deciderFrom: bestOf === 5 ? 5 : bestOf === 7 ? 7 : 9,
  };
}

/**
 * 开启一个"可分段推进"的系列赛。
 * 玩家自己的 BO7/BO9 走这条路径：先打上半场 → 界面给出调整窗口 → 再打下半场。
 */
export function startSeries(p) {
  const bestOf = p.bestOf ?? 5;
  return {
    p,
    bestOf,
    ctx: buildCtx(p),
    targetWins: Math.ceil(bestOf / 2),
    segments: segmentPlan(bestOf),
    segIndex: 0,
    games: [],
    a: 0,
    b: 0,
  };
}

/**
 * 推进到下一个段边界。
 * @param {object|null} powerOverride 中场调整后可重设战力/心态差
 * @returns {{chunk:Array, from:number, to:number, done:boolean, decider:boolean, scoreA:number, scoreB:number}}
 */
export function playSeriesSegment(s, rng, powerOverride = null) {
  if (powerOverride) {
    if (typeof powerOverride.powerA === 'number') s.ctx.powerA = powerOverride.powerA;
    if (typeof powerOverride.powerB === 'number') s.ctx.powerB = powerOverride.powerB;
    if (typeof powerOverride.mentalityDiff === 'number') s.ctx.mentalityDiff = powerOverride.mentalityDiff;
  }
  const boundary = s.segments[s.segIndex] ?? (s.targetWins * 2 - 1);
  const from = s.games.length + 1;
  while (s.games.length < boundary && s.a < s.targetWins && s.b < s.targetWins) {
    const g = s.games.length + 1;
    const prob = gameWinProb(s.ctx, g, s.a, s.b);
    const aWin = rng.chance(prob);
    if (aWin) s.a += 1; else s.b += 1;
    s.games.push({ no: g, winner: aWin ? 'A' : 'B', winProbA: Number(prob.toFixed(4)), scoreAfter: `${s.a}-${s.b}` });
  }
  const chunk = s.games.slice(from - 1);
  const done = s.a === s.targetWins || s.b === s.targetWins;
  if (chunk.length && !done) chunk[chunk.length - 1].segmentEnd = true;
  s.segIndex += 1;
  return {
    chunk, from, to: s.games.length, done,
    decider: done && s.a === s.targetWins && s.b === s.targetWins - 1,
    scoreA: s.a, scoreB: s.b,
  };
}

/** 收尾：把分段结果整理成与 simulateSeries 一致的完整结果 */
export function finishSeries(s) {
  const t = s.targetWins;
  const wentDecider = (s.a === t && s.b === t - 1) || (s.b === t && s.a === t - 1);
  const winnerIsA = s.a > s.b;
  const clean = s.games.map((g, i) => ({
    no: g.no,
    winner: g.winner,
    winProbA: g.winProbA,
    scoreAfter: g.scoreAfter,
    segmentEnd: g.segmentEnd === true || i === s.games.length - 1,
  }));
  return {
    bestOf: s.bestOf,
    stage: s.p.stage || '',
    teamA: { id: s.p.teamA.id, name: s.p.teamA.name },
    teamB: { id: s.p.teamB.id, name: s.p.teamB.name },
    games: clean,
    finalScore: `${Math.max(s.a, s.b)}-${Math.min(s.a, s.b)}`,
    scoreA: s.a,
    scoreB: s.b,
    winnerId: winnerIsA ? s.p.teamA.id : s.p.teamB.id,
    loserId: winnerIsA ? s.p.teamB.id : s.p.teamA.id,
    wentDecider,
    hadPeakShowdown: wentDecider,
    narrative: buildNarrative(s.p, s.a, s.b, wentDecider),
  };
}

/**
 * 主入口（一次性出完整结果）
 * @param {object} p
 *  teamA/teamB  {id,name,power,mentality}
 *  bestOf       5 | 7 | 9
 *  homeTeamId   主场队伍 id（决定 homeAdvantage 归属）
 *  stage        '常规赛' | '卡位赛' | '季后赛' | '总决赛' …（仅用于展示）
 */
export function simulateSeries(p, rng) {
  const s = startSeries(p);
  let guard = 0;
  while (guard++ < 12) {
    const seg = playSeriesSegment(s, rng);
    if (seg.done) break;
  }
  return finishSeries(s);
}

function buildNarrative(p, a, b, wentDecider) {
  const wn = a > b ? p.teamA.name : p.teamB.name;
  const ln = a > b ? p.teamB.name : p.teamA.name;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (lo === 0) return `${wn} 干净利落 ${hi}-0 零封 ${ln}`;
  if (wentDecider) return `${wn} 在巅峰对决中顶住压力，${hi}-${lo} 险胜 ${ln}`;
  if (hi - lo === 1) return `${wn} 与 ${ln} 鏖战至最后一局，${hi}-${lo} 拿下`;
  return `${wn} ${hi}-${lo} 战胜 ${ln}`;
}

/**
 * 快速模拟：只出最终比分，不保留逐局细节（用于其他战队的比赛、常规赛批量推演、签表推演）
 *
 * ⚠️ 历史 bug：这里曾经读 `p.powerA / p.powerB`，但所有调用方传进来的都是
 * `{ teamA: { id, name, power }, teamB: {...} }`，于是战力差恒为 `NaN`，
 * `winProbability(NaN)` 也是 NaN，`rng.chance(NaN)` 恒为 false ——
 * 结果就是**所有非玩家比赛都由 b 方 3-0 获胜**（界面上只看到清一色 3-0）。
 * 现在改为同时兼容 `teamA/teamB` 对象与 `powerA/powerB` 两种写法。
 */
export function simulateQuick(p, rng) {
  const aId = p.teamA?.id ?? p.teamAId;
  const bId = p.teamB?.id ?? p.teamBId;
  const powerA = num(p.teamA?.power ?? p.powerA);
  const powerB = num(p.teamB?.power ?? p.powerB);
  const homeBonus = p.homeBonus ?? 2.2;
  const homeEdge = p.homeTeamId === aId ? homeBonus : p.homeTeamId === bId ? -homeBonus : 0;
  const diff = (powerA - powerB) + homeEdge;

  // 决胜局更看心态：与 simulateSeries 口径保持一致
  const bestOf = p.bestOf ?? 5;
  const deciderFrom = bestOf === 5 ? 5 : bestOf === 7 ? 7 : 9;
  const mentalityDiff = (p.teamA?.mentality ?? 60) - (p.teamB?.mentality ?? 60);
  const slope = p.slope ?? 0.085;

  const pSingle = winProbability(diff, slope);
  const pDecider = winProbability(diff * 0.78 + mentalityDiff * 0.5, slope);
  const targetWins = Math.ceil(bestOf / 2);

  let a = 0;
  let b = 0;
  while (a < targetWins && b < targetWins) {
    const gameNo = a + b + 1;
    const prob = gameNo >= deciderFrom ? pDecider : pSingle;
    if (rng.chance(prob)) a += 1; else b += 1;
  }
  const winnerIsA = a > b;
  return {
    bestOf,
    scoreA: a,
    scoreB: b,
    finalScore: `${Math.max(a, b)}-${Math.min(a, b)}`,
    winnerId: winnerIsA ? aId : bId,
    loserId: winnerIsA ? bId : aId,
    winnerName: winnerIsA ? p.teamA?.name : p.teamB?.name,
    loserName: winnerIsA ? p.teamB?.name : p.teamA?.name,
    wentDecider: a === targetWins && b === targetWins - 1,
  };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
