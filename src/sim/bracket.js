/**
 * 淘汰赛引擎
 *  - 8 强双败（季后赛 / 挑战者杯 8 强）：常规赛 BO5，淘汰赛 BO7，决赛 BO9
 *  - 5 队双败（年度总决赛淘汰赛）
 *  - 玩家所在队伍的比赛逐场模拟；玩家被淘汰或不参赛时，其余比赛按实力快速推演
 */
import { simulateSeries, simulateQuick, startSeries, playSeriesSegment } from './match.js';
import { teamPower, teamMentality } from './team.js';

/**
 * 8 强双败模板 —— 严格按 KPL 官方季后赛赛制（M1 ~ M10）
 *
 * 种子 1-4 进**胜者组**，种子 5-8 进**败者组**：
 *   M1  = 第 5 名 vs 第 8 名（败者组首轮）
 *   M2  = 第 6 名 vs 第 7 名（败者组首轮）
 *   M3  = 第 1 名 vs 第 4 名（胜者组首轮）
 *   M4  = 第 2 名 vs 第 3 名（胜者组首轮）
 *   M5  = M1 胜者 vs M4 败者（败者组第二轮）
 *   M6  = M2 胜者 vs M3 败者（败者组第二轮）
 *   M7  = M3 胜者 vs M4 胜者（胜者组决赛）
 *   M8  = M5 胜者 vs M6 胜者（败者组第三轮）
 *   M9  = M8 胜者 vs M7 败者（败者组决赛）
 *   F   = M7 胜者 vs M9 胜者（总决赛）
 *
 * 名次：总决赛胜者第 1、败者第 2；败者组决赛败者第 3；败者组第三轮败者第 4；
 *       M5 / M6 败者并列第 5；M1 / M2 败者并列第 7。
 *
 * 胜者组队伍输掉首轮会掉进败者组继续打（双败），败者组一旦落败直接淘汰。
 */
export function doubleElimTemplate8(seeds) {
  const [s1, s2, s3, s4, s5, s6, s7, s8] = seeds;
  const M = (id, matchday, bracket, round, label, a = null, b = null) => ({
    id, matchday, bracket, round, label, a, b, winnerId: null, loserId: null, result: null,
  });
  return [
    M('M1', 1, 'LB', 1, '败者组首轮', s5, s8),
    M('M2', 1, 'LB', 1, '败者组首轮', s6, s7),
    M('M3', 2, 'WB', 1, '胜者组首轮', s1, s4),
    M('M4', 2, 'WB', 1, '胜者组首轮', s2, s3),
    M('M5', 3, 'LB', 2, '败者组第二轮'),
    M('M6', 3, 'LB', 2, '败者组第二轮'),
    M('M7', 4, 'WB', 2, '胜者组决赛'),
    M('M8', 5, 'LB', 3, '败者组第三轮'),
    M('M9', 6, 'LB', 4, '败者组决赛'),
    M('F', 7, 'F', 1, '总决赛'),
  ];
}

/** 5 队双败模板（保留备用）：4 个比赛日 */
export function doubleElimTemplate5(seeds) {
  const [s1, s2, s3, s4, s5] = seeds;
  const M = (id, matchday, bracket, round, label) => ({ id, matchday, bracket, round, label, a: null, b: null, winnerId: null, loserId: null, result: null });
  return [
    Object.assign(M('L1', 1, 'LB', 1, '败者组首轮'), { a: s4, b: s5 }),
    Object.assign(M('W1', 1, 'WB', 1, '胜者组首轮'), { a: s1, b: s2 }),
    Object.assign(M('W2', 2, 'WB', 1, '胜者组首轮'), { a: s3, b: '__L1W__' }),
    M('L2', 3, 'LB', 2, '败者组第二轮'),
    M('W3', 3, 'WB', 2, '胜者组决赛'),
    M('L3', 4, 'LB', 3, '败者组决赛'),
    M('F', 5, 'F', 1, '年度总决赛'),
  ];
}

/** 每场比赛结束后，把胜/负者填进后续场次（KPL 双败签表） */
const SLOT_MAP = {
  // 目标场次: { 槽位: 'W' 取胜者 | 'L' 取负者 }
  M1: { M5: { a: 'W' } },
  M2: { M6: { a: 'W' } },
  M3: { M7: { a: 'W' }, M6: { b: 'L' } },
  M4: { M7: { b: 'W' }, M5: { b: 'L' } },
  M5: { M8: { a: 'W' } },
  M6: { M8: { b: 'W' } },
  M7: { F: { a: 'W' }, M9: { b: 'L' } },
  M8: { M9: { a: 'W' } },
  M9: { F: { b: 'W' } },
  // 备用（5 队模板）
  W1: { W2: { a: 'W' }, L2: { a: 'L' } },
  W2: { W3: { a: 'W' }, L3: { a: 'L' } },
  W3: { F: { a: 'W' } },
  L1: { L2: { b: 'W' } },
  L2: { L3: { b: 'W' } },
  L3: { F: { b: 'W' } },
};

function propagate(bracket, match) {
  const targets = SLOT_MAP[match.id];
  if (!targets) return;
  for (const [mid, slots] of Object.entries(targets)) {
    const t = bracket.find((x) => x.id === mid);
    if (!t) continue;
    for (const [slot, kind] of Object.entries(slots)) {
      t[slot] = kind === 'W' ? match.winnerId : match.loserId;
    }
  }
}

function resolvePlaceholders(bracket) {
  const l1 = bracket.find((m) => m.id === 'L1');
  const w2 = bracket.find((m) => m.id === 'W2');
  if (w2 && w2.b === '__L1W__' && l1 && l1.winnerId) w2.b = l1.winnerId;
}

/** 让剩余比赛按实力自动推演（玩家已淘汰 / 不参赛时用） */
export function autoResolveRemaining(game, rng, bracket, opts = {}) {
  const finalsByRound = { F: 9 };
  let guard = 0;
  while (bracket.some((m) => !m.winnerId) && guard < 40) {
    guard += 1;
    resolvePlaceholders(bracket);
    const pending = bracket
      .filter((m) => !m.winnerId && m.a && m.b)
      .sort((x, y) => x.matchday - y.matchday);
    if (!pending.length) break;
    for (const m of pending) {
      m.result = playBracketMatch(game, rng, m, opts, true);
      m.winnerId = m.result.winnerId;
      m.loserId = m.result.loserId;
      propagate(bracket, m);
    }
  }
  return bracket;
}

/** 构造一场淘汰赛的模拟入参（供一次性模拟与分段模拟共用） */
export function commonFor(game, m, opts = {}) {
  const bestOf = m.bracket === 'F' ? (opts.finalBestOf ?? 9) : (opts.bestOf ?? 7);
  const a = m.a;
  const b = m.b;
  return {
    teamA: { id: a, name: game.teams[a].name, power: teamPower(game, a), mentality: teamMentality(game, a) },
    teamB: { id: b, name: game.teams[b].name, power: teamPower(game, b), mentality: teamMentality(game, b) },
    bestOf,
    homeTeamId: a,
    stage: m.label,
    // 决胜局权重更高的心态微调；总决赛取消主场加成
    homeBonus: m.bracket === 'F' ? 0 : 2.2,
  };
}

/** 把一场比赛的结果写回签表并向后传播 */
export function applyMatchResult(bracket, m, result) {
  m.result = result;
  m.winnerId = result.winnerId;
  m.loserId = result.loserId;
  propagate(bracket, m);
  return m;
}

/** 模拟一场淘汰赛；quick=true 时只出比分 */
export function playBracketMatch(game, rng, m, opts = {}, quick = false) {
  const common = commonFor(game, m, opts);
  const r = quick ? simulateQuick(common, rng) : simulateSeries(common, rng);
  return { ...r, matchId: m.id, label: m.label, bestOf: common.bestOf };
}

/**
 * 推进一个比赛日：只打 matchday === day 的场次
 *
 * 当 opts.pausePlayerSeries 为真时，玩家自己那场**不一次性打完**：
 * 先模拟上半场并挂起（返回 paused），等界面给出调整窗口后再继续。
 * @returns {{day, matches, playerMatch, paused, finished, championId, runnerUpId}}
 */
export function playBracketDay(game, rng, bracket, day, playerTeamId, opts = {}) {
  resolvePlaceholders(bracket);
  const dayMatches = bracket.filter((m) => m.matchday === day && !m.winnerId);
  const results = [];
  let playerMatch = null;
  let paused = null;
  for (const m of dayMatches) {
    if (!m.a || !m.b) continue;
    const involvesPlayer = m.a === playerTeamId || m.b === playerTeamId;
    if (involvesPlayer && opts.pausePlayerSeries) {
      const common = commonFor(game, m, opts);
      const series = startSeries(common);
      const first = playSeriesSegment(series, rng);       // 只打上半场
      paused = { match: m, series, first, common };
      continue;                                           // 该场不结算、不传播
    }
    const result = playBracketMatch(game, rng, m, opts, !involvesPlayer);
    applyMatchResult(bracket, m, result);
    results.push({ match: m, result });
    if (involvesPlayer) playerMatch = { match: m, result };
  }
  const final = bracket.find((m) => m.id === 'F');
  const finished = paused ? false : (bracket.every((m) => m.winnerId) || !!final?.winnerId);
  return {
    day,
    matches: results,
    playerMatch,
    paused,
    finished,
    championId: final?.winnerId || null,
    runnerUpId: final?.loserId || null,
  };
}

/** 玩家是否还在本次淘汰赛中 */
export function playerAlive(bracket, playerTeamId) {
  const final = bracket.find((m) => m.id === 'F');
  if (final?.winnerId) return false;
  return bracket.some((m) => !m.winnerId && (m.a === playerTeamId || m.b === playerTeamId));
}

/** 玩家是否已被淘汰 */
export function playerEliminated(bracket, playerTeamId) {
  const lost = bracket.find((m) => m.loserId === playerTeamId);
  if (!lost) return false;
  const final = bracket.find((m) => m.id === 'F');
  if (final?.winnerId) return final.winnerId !== playerTeamId;
  // 双败：输两场才淘汰（决赛除外）
  const losses = bracket.filter((m) => m.loserId === playerTeamId).length;
  return losses >= 2 || lost.bracket === 'F';
}

/** 名次判定（用于奖金与年度积分） */
export function placementFromBracket(bracket, playerTeamId, totalTeams = 8) {
  const map = placementMap(bracket);
  return map[playerTeamId] ?? totalTeams;
}

/**
 * 整张签表的名次表：冠军 1、亚军 2，其余按被淘汰的轮次深度
 * 用于给 18 支队伍全部结算年度积分与奖金
 */
export function placementMap(bracket) {
  const out = {};
  const final = bracket.find((m) => m.id === 'F');
  if (final?.winnerId) {
    out[final.winnerId] = 1;
    out[final.loserId] = 2;
  }
  /**
   * KPL 官方名次口径：只有"输掉就淘汰"的场次才决定名次。
   * 败者组决赛败者第 3、败者组第三轮败者第 4、
   * 败者组第二轮（M5/M6）败者并列第 5、败者组首轮（M1/M2）败者并列第 7。
   *
   * ⚠️ 注意 M7（胜者组决赛）**不在此表**：它的败者掉进败者组决赛（M9）继续打，
   * 不是被淘汰 —— 曾经因为按赛程顺序扫全表，把 M7 的败者错记为第 6 名。
   */
  const ELIMINATING = { M9: 3, M8: 4, M5: 5, M6: 5, M1: 7, M2: 7 };
  for (const m of bracket) {
    if (!m.loserId) continue;
    if (!(m.id in ELIMINATING)) continue;
    if (out[m.loserId]) continue;
    out[m.loserId] = ELIMINATING[m.id];
  }
  return out;
}
