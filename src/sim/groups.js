/**
 * 常规赛：抽签分组 → S/A/B 重组 → 三轮组内单循环 → 卡位赛 → B 组提前淘汰
 *
 * 第一赛季：玩家固定从 B 组出发（已是 B 组 → 不再重分）
 * 第二赛季起：按上赛季结束时的组别开局
 */
import { simulateSeries, simulateQuick } from './match.js';
import { teamPower, teamMentality } from './team.js';

/** 6 队单循环赛程（5 个比赛日，每队每日一场） */
export const RR6 = [
  [[0, 5], [1, 4], [2, 3]],
  [[0, 4], [5, 3], [1, 2]],
  [[0, 3], [4, 2], [5, 1]],
  [[0, 2], [3, 1], [4, 5]],
  [[0, 1], [2, 5], [3, 4]],
];

export const DIVISIONS = ['S', 'A', 'B'];

/**
 * 第一轮抽签分组：自上而下蛇形分配，让每组强度接近
 * 玩家所在队固定落位 B 组（第一赛季硬性设定）
 */
export function seedFirstRoundGroups(game, seedOrder) {
  const g = { S: [], A: [], B: [] };
  // seedOrder: 从强到弱的 id 数组；蛇形：1→S,2→A,3→B,4→B,5→A,6→S …
  const pattern = ['S', 'A', 'B', 'B', 'A', 'S'];
  let i = 0;
  for (const id of seedOrder) {
    const div = pattern[i % 6];
    g[div].push(id);
    i += 1;
  }
  return g;
}

/** 第三轮：S 组争季后赛席位，B 组后四名提前结束赛季 */
export function bottomFourOf(groupB) {
  return groupB.slice(4);
}

/** 由比赛结果生成积分榜 */
export function buildStandings(teamIds, matches) {
  const table = {};
  for (const id of teamIds) {
    table[id] = { id, wins: 0, losses: 0, gameWins: 0, gameLosses: 0, netGames: 0, played: 0, points: 0, headToHead: {} };
  }
  for (const m of matches) {
    const a = table[m.a];
    const b = table[m.b];
    if (!a || !b) continue;
    a.played += 1;
    b.played += 1;
    a.gameWins += m.scoreA;
    a.gameLosses += m.scoreB;
    b.gameWins += m.scoreB;
    b.gameLosses += m.scoreA;
    const aWon = m.scoreA > m.scoreB;
    if (aWon) { a.wins += 1; b.losses += 1; } else { b.wins += 1; a.losses += 1; }
    a.headToHead[b.id] = aWon ? 1 : 0;
    b.headToHead[a.id] = aWon ? 0 : 1;
  }
  for (const id of Object.keys(table)) {
    const r = table[id];
    r.netGames = r.gameWins - r.gameLosses;
    r.points = r.wins * 3; // 展示用
  }
  return table;
}

/** 排序：胜场 → 净胜局 → 相互战绩 → 总胜局（缺失数据视为全败） */
const EMPTY_ROW = { id: '', wins: 0, losses: 0, gameWins: 0, gameLosses: 0, netGames: 0, played: 0, points: 0, headToHead: {} };

export function rankTeams(teamIds, table) {
  const t = table || {};
  return teamIds.slice().sort((x, y) => {
    const a = t[x] || EMPTY_ROW;
    const b = t[y] || EMPTY_ROW;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.netGames !== a.netGames) return b.netGames - a.netGames;
    const h = a.headToHead[b.id];
    if (h !== undefined && h !== null) return h === 1 ? -1 : 1;
    return b.gameWins - a.gameWins;
  });
}

/** 生成某一轮的比赛日列表（仅分组内对阵，共 5 个比赛日） */
export function regularMatchdays(groups) {
  const days = [];
  for (let d = 0; d < 5; d += 1) {
    const fixtures = [];
    for (const div of DIVISIONS) {
      const ids = groups[div] || [];
      if (ids.length !== 6) continue;
      for (const [i, j] of RR6[d]) {
        fixtures.push({ division: div, a: ids[i], b: ids[j] });
      }
    }
    days.push({ round: d + 1, fixtures });
  }
  return days;
}

/**
 * 批量模拟一个比赛日：
 *  - 玩家所在的那一场走完整模拟（逐局、含巅峰对决）
 *  - 其余比赛只出最终比分
 */
export function playMatchday(game, rng, day, playerTeamId, opts = {}) {
  const results = [];
  for (const f of day.fixtures) {
    const isPlayer = f.a === playerTeamId || f.b === playerTeamId;
    const powerA = teamPower(game, f.a);
    const powerB = teamPower(game, f.b);
    const common = {
      teamA: { id: f.a, name: game.teams[f.a].name, power: powerA, mentality: teamMentality(game, f.a) },
      teamB: { id: f.b, name: game.teams[f.b].name, power: powerB, mentality: teamMentality(game, f.b) },
      bestOf: opts.bestOf ?? 5,
      homeTeamId: opts.homeTeamId ?? f.a,
      stage: opts.stage || `${opts.roundName || ''}`.trim(),
    };
    if (isPlayer && !opts.quickAll) {
      const full = simulateSeries(common, rng);
      results.push({ ...f, ...full, isPlayer });
    } else {
      const quick = simulateQuick(common, rng);
      results.push({ ...f, ...quick, isPlayer });
    }
  }
  return results;
}

/** 卡位赛：S/A 与 A/B，各两场，BO7 */
export function playCardMatches(game, rng, { upper, lower }, playerTeamId) {
  const out = [];
  const pairUp = (higherDivIds, lowerDivIds) => {
    // 高组第 5 对低组第 2、高组第 6 对低组第 1
    return [
      [higherDivIds[4], lowerDivIds[1]],
      [higherDivIds[5], lowerDivIds[0]],
    ];
  };
  for (const pair of [...pairUp(upper.high, upper.low), ...pairUp(lower.high, lower.low)]) {
    const [a, b] = pair;
    if (!a || !b) continue;
    const common = {
      teamA: { id: a, name: game.teams[a].name, power: teamPower(game, a), mentality: teamMentality(game, a) },
      teamB: { id: b, name: game.teams[b].name, power: teamPower(game, b), mentality: teamMentality(game, b) },
      bestOf: 7,
      homeTeamId: a,
      stage: '卡位赛',
    };
    const isPlayer = a === playerTeamId || b === playerTeamId;
    const r = isPlayer ? simulateSeries(common, rng) : simulateQuick(common, rng);
    out.push({ a, b, ...r, isPlayer });
  }
  return out;
}

/** 卡位赛结果 → 第三轮分组 */
export function applyRegroup(baseGroups, cardResults) {
  const next = { S: baseGroups.S.slice(), A: baseGroups.A.slice(), B: baseGroups.B.slice() };
  for (const m of cardResults) {
    // 高组队伍若输球，则与低组队伍互换组别
    const highTeam = m.a;
    const lowTeam = m.b;
    const highDiv = next.S.includes(highTeam) ? 'S' : 'A';
    const lowDiv = highDiv === 'S' ? 'A' : 'B';
    if (m.winnerId === lowTeam) {
      next[highDiv] = next[highDiv].filter((x) => x !== highTeam).concat(lowTeam);
      next[lowDiv] = next[lowDiv].filter((x) => x !== lowTeam).concat(highTeam);
    }
  }
  return next;
}

/** 第二轮结束后的重分组：各组前 2 → S、3-4 → A、5-6 → B（第一赛季用） */
export function regroupByRank(groups, tables) {
  const next = { S: [], A: [], B: [] };
  for (const div of DIVISIONS) {
    const ids = groups[div] || [];
    const ranked = rankTeams(ids, tables[div]);
    next.S.push(...ranked.slice(0, 2));
    next.A.push(...ranked.slice(2, 4));
    next.B.push(...ranked.slice(4, 6));
  }
  return next;
}
