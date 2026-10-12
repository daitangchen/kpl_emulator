/**
 * 赛季主状态机
 * 全年赛事：春季赛 → 挑战者杯（直接 8 强双败）→ 夏季赛 → 年度总决赛
 * 推进单位：一个比赛日（玩家点一次 = 推进一步）
 */
import { CALENDAR, REGULAR_ROUNDS, FINANCE, ANNUAL_POINTS, FAILURE_RULES, FINALS_RULES, leagueShareForRank } from '../core/constants.js';
import {
  DIVISIONS, buildStandings, rankTeams, regularMatchdays, playMatchday, playCardMatches,
  regroupByRank, applyRegroup,
} from './groups.js';
import { doubleElimTemplate8, doubleElimTemplate5, playBracketDay, placementFromBracket, placementMap, autoResolveRemaining, commonFor, applyMatchResult } from './bracket.js';
import { teamPower, teamMentality, META_VERSIONS } from './team.js';
import { simulateQuick, simulateSeries, startSeries, playSeriesSegment, finishSeries } from './match.js';
import { createRng } from '../core/rng.js';
import { developAll, marketValue, generateProspect } from './develop.js';
import { refreshMarket, repairSquad, setStarter } from './transfer.js';
import { arcOf, pickQuote, bestOf } from './story.js';
import { SERIES_ADJUST } from './training.js';
import { LINEUP_BY_ID, aiLineup, resolveLineup } from './lineup.js';

const snakeOrder = (ranked, divisions = DIVISIONS) => {
  const assign = { S: [], A: [], B: [] };
  const pattern = ['S', 'A', 'B', 'B', 'A', 'S'];
  ranked.forEach((id, i) => assign[pattern[i % 6]].push(id));
  // 每组内再按蛇形交替，避免强弱固定配对
  return assign;
};

/**
 * 第一赛季：玩家固定 B 组出发，其余按实力分为 S/A/B 各 6 支
 * 玩家与 B 组原有的最弱一支互换，这样豪门选队不会因为"落位 B 组"而被同组弱队围殴到降级线以下，
 * 同时 B 组整体强度仍然明显低于 A/S 组。
 */
export function initialGroupsForSeason(game) {
  const ranked = Object.keys(game.teams).sort((a, b) => teamPower(game, b) - teamPower(game, a));
  const pid = game.userTeamId;
  const groups = { S: ranked.slice(0, 6), A: ranked.slice(6, 12), B: ranked.slice(12, 18) };
  if (!groups.B.includes(pid)) {
    const swapOut = groups.B[groups.B.length - 1];
    for (const d of DIVISIONS) {
      groups[d] = groups[d].map((id) => (id === pid ? swapOut : id));
    }
    groups.B[groups.B.length - 1] = pid;
  }
  return groups;
}

/** 每轮开打前打乱组内顺序，避免对手顺序固定 */
function rotateGroups(game, groups, salt = 0) {
  const out = {};
  for (const d of DIVISIONS) {
    const ids = groups[d].slice();
    if (ids.length !== 6) { out[d] = ids; continue; }
    const shift = (game.season * 2 + salt) % 6;
    out[d] = ids.slice(shift).concat(ids.slice(0, shift));
  }
  return out;
}

/** 生成一个赛季的赛程骨架 */
export function stageListForSeason(season) {
  const stages = [];
  const reg = (ev, roundIndex, note) => ([1, 2, 3].forEach(() => {}), {
    kind: 'group',
    eventId: ev,
    eventName: ev === 'spring' ? 'KPL 春季赛' : 'KPL 夏季赛',
    roundIndex,
    roundName: REGULAR_ROUNDS[roundIndex - 1].name,
    note,
    days: 5,
    cursor: 0,
    done: false,
    results: [],
  });
  stages.push(reg('spring', 1, '抽签分组，组内单循环'));
  stages.push({ kind: 'regroup', eventId: 'spring', eventName: 'KPL 春季赛', label: '第一轮结束 · S/A/B 重组', done: false });
  stages.push(reg('spring', 2, '组内单循环，胜者争取冲组'));
  stages.push({ kind: 'card', eventId: 'spring', eventName: 'KPL 春季赛', label: 'S/A · A/B 卡位赛', done: false, results: [] });
  stages.push(reg('spring', 3, 'S 组争季后赛席位，B 组后四名提前结束'));
  stages.push({ kind: 'bracket', eventId: 'spring', eventName: 'KPL 春季赛', label: '季后赛', day: 1, done: false, bracket: null });

  stages.push({ kind: 'bracket', eventId: 'challenger', eventName: '挑战者杯', label: '挑杯 8 强双败', day: 1, done: false, bracket: null, finalBestOf: 9 });

  stages.push(reg('summer', 1, '重新抽签分组'));
  stages.push({ kind: 'regroup', eventId: 'summer', eventName: 'KPL 夏季赛', label: '第一轮结束 · S/A/B 重组', done: false });
  stages.push(reg('summer', 2, '组内单循环'));
  stages.push({ kind: 'card', eventId: 'summer', eventName: 'KPL 夏季赛', label: 'S/A · A/B 卡位赛', done: false, results: [] });
  stages.push(reg('summer', 3, 'S 组争季后赛席位'));
  stages.push({ kind: 'bracket', eventId: 'summer', eventName: 'KPL 夏季赛', label: '季后赛', day: 1, done: false, bracket: null });

  stages.push({ kind: 'finals', eventId: 'finals', eventName: 'KPL 年度总决赛', label: '年度总决赛', phase: 'arena', day: 1, done: false, bracket: null });
  return stages;
}

/** 开季 */
export function startSeason(game) {
  // 转会窗 / 抽卡可能拿走首发：开季前必须补齐五个位置，否则赛季会以残阵开打。
  // 注意：建档时 game.__rng 还不存在（要等第一次推进才创建），这里必须给一个兜底随机源，
  // 否则新建档会跳过补位——历史上就是这样让"被抽走球员的原队"以 4 人残阵开季的。
  const rng = game.__rng || createRng(game.seed || 20261005);
  for (const teamId of Object.keys(game.teams)) {
    repairSquad(game, rng, teamId);
  }
  game.stageIndex = 0;
  game.stages = stageListForSeason(game.season);
  game.groupsByRound = {};
  game.tablesByRound = {};
  game.divisionOf = {};
  game.seasonMatches = { spring: [], summer: [] };
  // 疲劳不随开季清零：休赛期接的商务要带着状态代价进入新赛季，否则"放假狂接商务"就是白拿钱。
  // 它只靠每个比赛日自然恢复（见 business.recoverFatigue）。
  if (!game.fatigue) game.fatigue = {};
  for (const id of Object.keys(game.teams)) {
    if (typeof game.fatigue[id] !== 'number') game.fatigue[id] = 0;
  }
  // 新赛季重置特训次数（赛季上限按赛季计）
  game.training = {};
  game.trainingTeam = { morale: 0, chem: 0 };
  game.flags.trainingSpend = 0;
  // 商务运营次数与疲劳也按赛季重置
  game.business = {};
  game.flags.businessIncome = 0;
  game.flags.matchIncome = 0;
  if (game.season === 1) {
    game.groupsByRound[1] = initialGroupsForSeason(game);
    game.startDivision = 'B';
  } else {
    game.groupsByRound[1] = snakeOrder(
      Object.keys(game.teams).sort((a, b) => teamPower(game, b) - teamPower(game, a)),
    );
    // 保留上季末分组：直接使用上季结果
    if (game.lastDivisionGroups) game.groupsByRound[1] = game.lastDivisionGroups;
    game.startDivision = DIVISIONS.find((d) => (game.groupsByRound[1][d] || []).includes(game.userTeamId)) || 'B';
  }
  return game;
}

export function currentStage(game) {
  const st = game.stages[game.stageIndex] || null;
  if (!st) return null;
  // 年总是"一个阶段多个子阶段"：擂台赛→突围赛→淘汰赛，全部走完才算真正结束
  if (st.kind === 'finals') {
    return st.done && st.phase === 'playoff' && st.bracket?.find((m) => m.id === 'F')?.winnerId ? null : st;
  }
  return st.done ? null : st;
}

function ensureGroupDay(game, stage) {
  if (!stage._days) {
    // 直接用该轮的正式分组，保证界面显示与模拟口径一致
    const groups = game.groupsByRound[stage.roundIndex];
    stage._groups = groups;
    stage._days = regularMatchdays(groups);
  }
  return stage._days;
}

/** 汇总某轮所有比赛结果，生成三张积分榜 */
function tablesForRound(game, stage) {
  const groups = stage._groups || game.groupsByRound[stage.roundIndex];
  const matches = stage.results || [];
  const tables = {};
  for (const d of DIVISIONS) {
    tables[d] = buildStandings(groups[d] || [], matches.filter((m) => m.division === d));
  }
  return tables;
}

/**
 * 全联盟排名
 *  strict=true（默认）：先按 S/A/B 组别，再按组内名次 —— 用于展示与组别升降
 *  strict=false：只看战绩（胜场→净胜局）—— 用于赛季末的董事会考核与年度积分
 */
export function overallRanking(game, { strict = true } = {}) {
  const lastRound = Math.max(...Object.keys(game.tablesByRound).map(Number).filter((n) => !Number.isNaN(n)), 0);
  const tables = game.tablesByRound[lastRound] || {};
  const groups = game.groupsByRound[lastRound] || game.groupsByRound[3] || game.groupsByRound[1] || { S: [], A: [], B: [] };
  const scored = [];
  for (const d of DIVISIONS) {
    const t = tables[d];
    const ranked = t ? rankTeams(groups[d] || [], t) : (groups[d] || []);
    ranked.forEach((id, i) => {
      scored.push({ id, div: d, divRank: i + 1, wins: t?.[id]?.wins ?? 0, net: t?.[id]?.netGames ?? 0 });
    });
  }
  if (strict) {
    scored.sort((a, b) => {
      const da = DIVISIONS.indexOf(a.div);
      const db = DIVISIONS.indexOf(b.div);
      if (da !== db) return da - db;
      return a.divRank - b.divRank;
    });
  } else {
    scored.sort((a, b) => (b.wins - a.wins) || (b.net - a.net));
  }
  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}

function divisionGroupsFromRanking(game) {
  const groups = { S: [], A: [], B: [] };
  const lastRound = Math.max(...Object.keys(game.groupsByRound).map(Number), 1);
  const src = game.groupsByRound[lastRound] || game.groupsByRound[1];
  for (const d of DIVISIONS) groups[d] = (src[d] || []).slice();
  return groups;
}

/** 卡位赛对阵（S/A 与 A/B） */
function cardPairs(groups) {
  return {
    upper: { high: groups.S, low: groups.A },
    lower: { high: groups.A, low: groups.B },
  };
}

/**
 * 卡位赛对阵列表：高组第 5/6 名 vs 低组第 2/1 名（BO7）
 * 注意传入的必须是"按战绩排好序"的组内数组。
 */
function cardPairList(ranked) {
  const pairUp = (hi, lo) => [[hi[4], lo[1]], [hi[5], lo[0]]];
  return [...pairUp(ranked.S || [], ranked.A || []), ...pairUp(ranked.A || [], ranked.B || [])];
}

/** 打完玩家自己的卡位赛（BO7 两段式 + 巅峰对决阵容博弈）并结算第三轮分组 */
function resumeCardSeries(game, rng, action, stage, groups) {
  const pend = game.__pendingSeries;
  const s = pend.series;

  if (pend.phase === 'lineup') {
    const lineup = playLineupPhase(game, s, action, rng);
    const seg = playSeriesSegment(s, rng, seriesPower(game, s, lineup.boostA, lineup.boostB));
    return finalizeCardSeries(game, stage, groups, s, [seg], { lineup, adjustment: pend.adjustment || null });
  }

  const adjust = applySeriesAdjustment(game, action, s);
  const power = seriesPower(game, s, adjust.isA ? adjust.boost : 0, adjust.isA ? 0 : adjust.boost);
  const { chunks, deciderPending } = advanceSeriesToStop(s, rng, power);
  if (deciderPending) {
    game.__pendingSeries = { ...pend, phase: 'lineup', adjustment: adjust };
    return {
      type: 'seriesPause',
      phase: 'lineup',
      card: true,
      stage,
      day: 0,
      match: pend.match,
      series: s,
      chunks,
      adjustment: adjust,
    };
  }
  return finalizeCardSeries(game, stage, groups, s, chunks, { adjustment: adjust });
}

/** 卡位赛收尾：写回结果并重算第三轮分组 */
function finalizeCardSeries(game, stage, groups, s, chunks, extra = {}) {
  const result = finishSeries(s);
  const playerCard = { a: s.p.teamA.id, b: s.p.teamB.id, ...result, isPlayer: true };
  const pend = game.__pendingSeries || {};
  const cards = [...(pend.otherCards || []), playerCard];

  const next = divisionsAfterCards(game, groups, cards);
  game.groupsByRound[3] = next;
  game.tablesByRound[3] = Object.fromEntries(DIVISIONS.map((d) => [d, buildStandings(next[d] || [], [])]));
  game.divisionOf = next;
  stage.results = cards;
  stage.done = true;
  game.__pendingSeries = null;

  return {
    type: 'card',
    cards,
    groups: next,
    ranked: stage.ranked,
    playerCard,
    chunks,
    adjustment: extra.adjustment || null,
    lineup: extra.lineup || null,
  };
}

function divisionsAfterCards(game, groups, cardResults) {
  const next = { S: groups.S.slice(), A: groups.A.slice(), B: groups.B.slice() };
  for (const m of cardResults) {
    const isUpper = next.S.includes(m.a);
    const highDiv = isUpper ? 'S' : 'A';
    const lowDiv = isUpper ? 'A' : 'B';
    if (m.winnerId === m.b) {
      next[highDiv] = next[highDiv].filter((x) => x !== m.a).concat(m.b);
      next[lowDiv] = next[lowDiv].filter((x) => x !== m.b).concat(m.a);
    }
  }
  return next;
}

/** 挑战者杯：跳过 32 进 8，直接按上季/本季实力取 8 队（含 2 支次级联赛黑马） */
function buildChallengerSeeds(game) {
  const ranked = Object.keys(game.teams).sort((a, b) => teamPower(game, b) - teamPower(game, a));
  const seeds = ranked.slice(0, 6);
  const wildcards = [ranked[10], ranked[14]].filter(Boolean);
  const pool = [...seeds, ...wildcards, ranked[6], ranked[7]];
  return pool.slice(0, 8);
}

/** 年度积分 → 年总 12 队与分组 */
export function annualStandings(game) {
  const pts = game.annualPoints || {};
  const rows = Object.keys(game.teams).map((id) => ({ id, points: pts[id] || 0 }));
  rows.sort((a, b) => b.points - a.points || teamPower(game, b.id) - teamPower(game, a.id));
  return rows.map((r, i) => ({ ...r, rank: i + 1, group: i < FINALS_RULES.masters ? 'masters' : 'elite' }));
}

/** 擂台赛：大师组 × 精英组 组外单循环，6 个比赛日 */
function buildArenaSchedule(masters, elite) {
  const days = [];
  for (let d = 0; d < 6; d += 1) {
    const fixtures = [];
    for (let i = 0; i < 6; i += 1) {
      const m = masters[i];
      const e = elite[(i + d) % 6];
      if (m && e) fixtures.push({ a: m, b: e });
    }
    days.push({ round: d + 1, fixtures });
  }
  return days;
}

/** ────────────────────────── 推进主函数 ────────────────────────── */
export function advance(game, rng, action = {}) {
  const stage = currentStage(game);
  if (!stage) return endOfSeason(game);
  const pid = game.userTeamId;

  if (stage.kind === 'group') {
    const days = ensureGroupDay(game, stage);
    let day = days[stage.cursor];
    // B 组后四名提前结束赛季：从第三轮起，被淘汰的队伍不再出战
    const excluded = stage.eliminated || [];
    const trimFixtures = (d) => {
      if (!excluded.length) return d;
      const fixtures = d.fixtures.filter((f) => !excluded.includes(f.a) && !excluded.includes(f.b));
      return { ...d, fixtures };
    };
    day = trimFixtures(day);
    const playerEliminated = excluded.includes(pid);
    if (playerEliminated && !stage.earlyExitNoted) {
      stage.earlyExitNoted = true;
      stage.cursor = days.length;
      stage.done = true;
      return {
        type: 'eliminatedEarly',
        stage,
        message: 'B 组后四名确定，你的战队本赛季提前结束。剩余赛程空转，没有比赛、没有奖金、没有曝光。',
        eliminated: excluded,
      };
    }
    const results = day.fixtures.length
      ? playMatchday(game, rng, day, pid, {
        bestOf: 5,
        homeTeamId: pid,
        roundName: `${stage.eventName} ${stage.roundName}`,
        stage: '常规赛',
      })
      : [];
    stage.results.push(...results);
    stage.cursor += 1;
    const tables = tablesForRound(game, stage);
    const groups = stage._groups;
    game.tablesByRound[stage.roundIndex] = tables;
    game.groupsByRound[stage.roundIndex] = groups;
    for (const d of DIVISIONS) game.divisionOf[d] = groups[d];
    const finished = stage.cursor >= days.length;
    if (finished) {
      stage.done = true;
      // B 组后四名提前结束赛季（第三轮）
      if (stage.roundIndex === 3) {
        const rankedB = rankTeams(groups.B, tables.B);
        stage.eliminated = rankedB.slice(4);
      }
    }
    return {
      type: 'matchday',
      stage,
      day: day.round,
      totalDays: days.length,
      results,
      playerResult: results.find((r) => r.isPlayer) || null,
      tables,
      groups,
      finished,
      eliminated: stage.eliminated || [],
      standings: finished ? overallRanking(game) : null,
    };
  }

  if (stage.kind === 'regroup') {
    const r1 = game.stages.find((s) => s.kind === 'group' && s.eventId === stage.eventId && s.roundIndex === 1);
    const groups = r1._groups || game.groupsByRound[1];
    // 必须用第一轮的正式积分榜（tablesByRound[1]）。
    // 历史 bug：这里曾读 r1._tables（被初始化为 {S:null,A:null,B:null} 的真值对象），
    // 于是 rankTeams 拿到空表、全部并列，重组退化成"按初始分组顺序"，完全无视战绩。
    const tables = game.tablesByRound[1] || tablesForRound(game, r1);
    r1._tables = tables;
    const next = regroupByRank(groups, tables);
    game.groupsByRound[2] = next;
    // 第二轮的分组积分榜从零开始
    game.tablesByRound[2] = Object.fromEntries(DIVISIONS.map((d) => [d, buildStandings(next[d] || [], [])]));
    game.divisionOf = next;
    stage.done = true;
    const flat = Object.fromEntries(DIVISIONS.map((d) => [d, next[d].slice()]));
    return { type: 'regroup', groups: flat, tables, ranking: overallRanking(game) };
  }

  if (stage.kind === 'card') {
    const groups = game.groupsByRound[2] || divisionGroupsFromRanking(game);
    const tables = game.tablesByRound[2] || {};
    /**
     * 卡位赛必须按「第二轮的战绩名次」配对，而不是分组数组的下标。
     * 历史 bug：groupsByRound[2] 是重组时按 [S5-6, A5-6, B5-6] 拼出来的数组，
     * 下标 4/5 与"组内第 5/6 名"毫无关系，于是高组第 5/6、低组第 1/2 全部取错人，
     * 出现过"小组第 4 被拉去打卡位赛，赢了反而掉组"的荒唐结果。
     */
    const ranked = {
      S: rankTeams(groups.S || [], tables.S),
      A: rankTeams(groups.A || [], tables.A),
      B: rankTeams(groups.B || [], tables.B),
    };
    stage.ranked = ranked;
    const pairs = cardPairList(ranked);

    // 玩家自己的卡位赛同样是 BO7 生死局 → 走两段式（先上半场，再调整）
    if (game.__pendingSeries && game.__pendingSeries.kind === 'card') {
      return resumeCardSeries(game, rng, action, stage, groups);
    }

    const cards = [];
    let paused = null;
    for (const [a, b] of pairs) {
      if (!a || !b) continue;
      const common = {
        teamA: { id: a, name: game.teams[a].name, power: teamPower(game, a), mentality: teamMentality(game, a) },
        teamB: { id: b, name: game.teams[b].name, power: teamPower(game, b), mentality: teamMentality(game, b) },
        bestOf: 7,
        homeTeamId: a,
        stage: '卡位赛',
      };
      if (a === pid || b === pid) {
        const series = startSeries(common);
        const first = playSeriesSegment(series, rng);
        paused = { match: { id: `card_${a}_${b}`, a, b }, series, first };
        continue;
      }
      const r = simulateQuick(common, rng);
      cards.push({ a, b, ...r, isPlayer: false });
    }
    if (paused) {
      game.__pendingSeries = { kind: 'card', phase: 'half', match: paused.match, series: paused.series, otherCards: cards, groups };
      return {
        type: 'seriesPause',
        card: true,
        stage,
        day: 0,
        match: paused.match,
        series: paused.series,
        first: paused.first,
      };
    }

    const next = divisionsAfterCards(game, groups, cards);
    game.groupsByRound[3] = next;
    game.tablesByRound[3] = Object.fromEntries(DIVISIONS.map((d) => [d, buildStandings(next[d] || [], [])]));
    game.divisionOf = next;
    stage.results = cards;
    stage.done = true;
    return { type: 'card', cards, groups: next, ranked, playerCard: cards.find((c) => c.isPlayer) || null };
  }

  if (stage.kind === 'bracket') {
    if (!stage.bracket) {
      const seeds = stage.eventId === 'challenger'
        ? buildChallengerSeeds(game)
        : playoffSeeds(game);
      stage.bracket = doubleElimTemplate8(seeds);
      stage.seeds = seeds;
    }
    const opts = { finalBestOf: stage.eventId === 'challenger' ? 9 : 7, bestOf: 7 };

    // 玩家自己的 BO7/BO9 分两段推进：上半场打完先挂起，等界面给出调整窗口
    if (game.__pendingSeries) {
      return resumePlayerSeries(game, rng, action, stage, opts);
    }

    const res = playBracketDay(game, rng, stage.bracket, stage.day, pid, { ...opts, pausePlayerSeries: true });
    if (res.paused) {
      game.__pendingSeries = { kind: 'bracket', phase: 'half', matchId: res.paused.match.id, series: res.paused.series, opts };
      return {
        type: 'seriesPause',
        stage,
        day: res.day,
        match: res.paused.match,
        series: res.paused.series,
        first: res.paused.first,
        otherMatches: res.matches,
      };
    }
    stage.day += 1;
    if (res.finished) {
      stage.done = true;
      const pm = placementMap(stage.bracket);
      stage.placementMap = pm;
      for (const [tid, pl] of Object.entries(pm)) {
        game.placements[tid] = game.placements[tid] || {};
        game.placements[tid][stage.eventId] = pl;
      }
      stage.championId = res.championId;
      stage.playerPlacement = pm[pid] ?? null;
    }
    return {
      type: 'bracket',
      stage,
      bracket: stage.bracket,
      day: res.day,
      matches: res.matches,
      playerMatch: res.playerMatch,
      finished: res.finished,
      championId: res.championId,
      playerPlacement: stage.playerPlacement ?? null,
    };
  }

  if (stage.kind === 'finals') {
    return advanceFinals(game, rng, stage);
  }

  return { type: 'unknown' };
}

/** ────────────────────── 玩家系列赛的两段式推进 ────────────────────── */

/**
 * 中场调整：换人 / 临场布置（花钱换本场战力）/ 不做调整
 * @returns {{type:string, boost:number, text:string, isA:boolean}}
 */
function applySeriesAdjustment(game, action, series) {
  const pid = game.userTeamId;
  const isA = series.p.teamA.id === pid;
  const out = { type: 'none', boost: 0, text: '不做调整，直接进入下半场。', isA };
  const req = action && action.series;
  if (!req) return out;

  if (req.type === 'swap' && req.inId && req.outId) {
    const r = setStarter(game, req.inId, req.outId);
    if (r.ok) {
      out.type = 'swap';
      out.text = `换人：${game.players[req.inId].name} 替下 ${game.players[req.outId].name}`;
    } else {
      out.text = `换人未生效：${r.reason}`;
    }
  } else if (req.type === 'boost') {
    const { boostCost, boostGain } = SERIES_ADJUST;
    if (game.cash >= boostCost) {
      game.cash -= boostCost;
      game.flags.trainingSpend = (game.flags.trainingSpend || 0) + boostCost;
      out.type = 'boost';
      out.boost = boostGain;
      out.cost = boostCost;
      out.text = `临场布置：花费 ${boostCost} 万，本场剩余局战力 +${boostGain}`;
    } else {
      out.text = `现金不足，临场布置未生效（需要 ${boostCost} 万）。`;
    }
  }
  return out;
}

/** 打完玩家自己那场的剩余部分，并把结果写回签表 */
/** 双方当前战力（含中场调整与阵容博弈的修正） */
function seriesPower(game, s, boostA = 0, boostB = 0) {
  return {
    powerA: teamPower(game, s.p.teamA.id) + boostA,
    powerB: teamPower(game, s.p.teamB.id) + boostB,
    mentalityDiff: teamMentality(game, s.p.teamA.id) - teamMentality(game, s.p.teamB.id),
  };
}

/** 巅峰对决前的阵容博弈：玩家选阵容，AI 按自己的风格出招 */
function playLineupPhase(game, s, action, rng) {
  const myId = s.p.teamA.id === game.userTeamId ? s.p.teamA.id : s.p.teamB.id;
  const oppId = myId === s.p.teamA.id ? s.p.teamB.id : s.p.teamA.id;
  const mine = (action && action.lineup && LINEUP_BY_ID[action.lineup]) ? action.lineup : 'teamfight';
  const theirs = aiLineup(game, oppId, rng);
  const r = resolveLineup(game, myId, oppId, mine, theirs, rng);
  const boost = myId === s.p.teamA.id ? [r.bonus, 0] : [0, r.bonus];
  return { ...r, boostA: boost[0], boostB: boost[1] };
}

/**
 * 把系列赛推进到下一个停顿点
 *  - 分出胜负 → done
 *  - 下一段正好是第 2N-1 局（巅峰对决）→ 停下来做阵容博弈
 */
function advanceSeriesToStop(s, rng, power) {
  const chunks = [];
  let guard = 0;
  while (guard++ < 8) {
    const segIndexBefore = s.segIndex;
    const seg = playSeriesSegment(s, rng, power);
    chunks.push(seg);
    if (seg.done) return { chunks, done: true, deciderPending: false };
    if (s.segments[s.segIndex] === s.targetWins * 2 - 1) return { chunks, done: false, deciderPending: true };
    if (s.segIndex === segIndexBefore) break;
  }
  return { chunks, done: s.a === s.targetWins || s.b === s.targetWins, deciderPending: false };
}

/** 系列赛收尾：写回签表、推进比赛日、结算名次 */
function finalizeBracketSeries(game, stage, m, result, chunks, extra = {}) {
  applyMatchResult(stage.bracket, m, result);
  game.__pendingSeries = null;
  stage.day += 1;

  const final = stage.bracket.find((x) => x.id === 'F');
  const finished = stage.bracket.every((x) => x.winnerId) || !!final?.winnerId;
  if (finished) {
    stage.done = true;
    const pm = placementMap(stage.bracket);
    stage.placementMap = pm;
    for (const [tid, pl] of Object.entries(pm)) {
      game.placements[tid] = game.placements[tid] || {};
      game.placements[tid][stage.eventId] = pl;
    }
    stage.championId = final?.winnerId || null;
    stage.playerPlacement = pm[game.userTeamId] ?? null;
  }

  return {
    type: 'bracket',
    stage,
    bracket: stage.bracket,
    chunks,
    adjustment: extra.adjustment || null,
    lineup: extra.lineup || null,
    day: stage.day - 1,
    matches: [{ match: m, result }],
    playerMatch: { match: m, result },
    finished,
    championId: final?.winnerId || null,
    playerPlacement: stage.playerPlacement ?? null,
  };
}

function resumePlayerSeries(game, rng, action, stage, opts) {
  const pend = game.__pendingSeries;
  const s = pend.series;
  const m = stage.bracket.find((x) => x.id === pend.matchId);
  if (!m) { game.__pendingSeries = null; return { type: 'unknown' }; }

  // 阶段二：巅峰对决前的阵容博弈 —— 结算完就直接打最后一局
  if (pend.phase === 'lineup') {
    const lineup = playLineupPhase(game, s, action, rng);
    const seg = playSeriesSegment(s, rng, seriesPower(game, s, lineup.boostA, lineup.boostB));
    const result = { ...finishSeries(s), matchId: m.id, label: m.label, bestOf: s.bestOf };
    return finalizeBracketSeries(game, stage, m, result, [seg], { lineup, adjustment: pend.adjustment || null });
  }

  // 阶段一：中场调整 → 打下半场（若打到 3-3 则停在巅峰对决前）
  const adjust = applySeriesAdjustment(game, action, s);
  const power = seriesPower(game, s, adjust.isA ? adjust.boost : 0, adjust.isA ? 0 : adjust.boost);
  const { chunks, done, deciderPending } = advanceSeriesToStop(s, rng, power);

  if (deciderPending) {
    game.__pendingSeries = { ...pend, phase: 'lineup', adjustment: adjust };
    return {
      type: 'seriesPause',
      phase: 'lineup',
      stage,
      day: stage.day,
      match: m,
      series: s,
      chunks,
      adjustment: adjust,
    };
  }

  const result = { ...finishSeries(s), matchId: m.id, label: m.label, bestOf: s.bestOf };
  return finalizeBracketSeries(game, stage, m, result, chunks, { adjustment: adjust });
}

/** 季后赛种子：S 组前 4（胜者组）+ A 组前 2、S 组 5-6（败者组） */
export function playoffSeeds(game) {
  const groups = game.groupsByRound[3] || game.groupsByRound[2];
  const tables = game.tablesByRound[3] || game.tablesByRound[2];
  const S = rankTeams(groups.S, tables.S);
  const A = rankTeams(groups.A, tables.A);
  return [S[0], S[1], S[2], S[3], S[4], S[5], A[0], A[1]].filter(Boolean);
}

/** 名次 → 奖金 + 年度积分 + 声望 */
export function awardPlacement(game, eventId, placement) {
  const ev = CALENDAR.find((e) => e.id === eventId);
  if (!ev) return { prize: 0, points: 0 };
  const table = ev.prize;
  let prize = 0;
  if (placement === 1) prize = table.champion;
  else if (placement === 2) prize = table.runnerUp;
  else if (placement <= 4) prize = table.semi;
  else if (placement <= 8) prize = table.quarter;
  else prize = Math.round(table.quarter * 0.4);

  const pointsTable = ANNUAL_POINTS[eventId] || {};
  const keys = Object.keys(pointsTable).map(Number).sort((a, b) => a - b);
  let points = 0;
  for (const k of keys) if (placement <= k) { points = pointsTable[k]; break; }

  const isPlayer = false; // 由调用方决定是否给玩家
  game.lastAward = { eventId, placement, prize, points };
  return { prize, points };
}

/** 年总：擂台赛 → 突围赛 → 淘汰赛 */
function advanceFinals(game, rng, stage) {
  const pid = game.userTeamId;
  if (stage.phase === 'arena') {
    if (!stage.arena) {
      const rows = annualStandings(game);
      stage.qualified = rows.slice(0, FINALS_RULES.qualified);
      stage.masters = stage.qualified.filter((r) => r.group === 'masters').map((r) => r.id);
      stage.elite = stage.qualified.filter((r) => r.group === 'elite').map((r) => r.id);
      if (!stage.qualified.some((r) => r.id === pid)) {
        // 玩家没进年总：直接自动推演全部
        stage.arenaDays = buildArenaSchedule(stage.masters, stage.elite);
        stage.autoAll = true;
      } else {
        stage.arenaDays = buildArenaSchedule(stage.masters, stage.elite);
      }
      stage.results = [];
    }
    const day = stage.arenaDays[stage.day - 1];
    if (day) {
      const results = playMatchday(game, rng, day, pid, { bestOf: 5, homeTeamId: pid, stage: '擂台赛' });
      stage.results.push(...results);
      stage.day += 1;
      if (stage.day > stage.arenaDays.length) {
        stage.arenaTables = {
          masters: buildStandings(stage.masters, stage.results.filter((m) => stage.masters.includes(m.a) || stage.masters.includes(m.b))),
          elite: buildStandings(stage.elite, stage.results.filter((m) => stage.elite.includes(m.a) || stage.elite.includes(m.b))),
        };
        stage.phase = 'survival';
        // 擂台赛结束：切到突围赛。年总整体仍未结束，done 必须保持 false，
        // 否则 currentStage 会把整季判定为结束，突围赛与淘汰赛都会被跳过。
        stage.done = false;
        nextStage(game);
      }
      return { type: 'arena', stage, day: day.round, results, playerResult: results.find((r) => r.isPlayer) || null, finished: stage.day > stage.arenaDays.length };
    }
    stage.phase = 'survival';
    stage.done = false;
    nextStage(game);
    return { type: 'arena', stage, day: 0, results: [], finished: true };
  }

  if (stage.phase === 'survival') {
    if (!stage.survival) {
      const t = stage.arenaTables;
      const mRanked = rankTeams(stage.masters, t.masters);
      const eRanked = rankTeams(stage.elite, t.elite);
      stage.directToPlayoff = [...mRanked.slice(0, FINALS_RULES.advanceToPlayoff.mastersTop), eRanked[0]];
      const pool = [...mRanked.slice(4), ...eRanked.slice(1, 5)];
      stage.survival = {
        pool,
        pairs: [[pool[0], pool[5]], [pool[1], pool[4]], [pool[2], pool[3]]].filter((p) => p[0] && p[1]),
        winners: [],
      };
    }
    const results = [];
    for (const [a, b] of stage.survival.pairs) {
      if (stage.survival.winners.includes(a) || stage.survival.winners.includes(b)) continue;
      const common = {
        teamA: { id: a, name: game.teams[a].name, power: teamPower(game, a) },
        teamB: { id: b, name: game.teams[b].name, power: teamPower(game, b), mentality: 60 },
        bestOf: 7,
        homeTeamId: a,
        stage: '突围赛',
      };
      const involves = a === pid || b === pid;
      const r = involves ? simulateSeries(common, rng) : simulateQuick(common, rng);
      stage.survival.winners.push(r.winnerId);
      results.push({ a, b, ...r, isPlayer: involves });
    }
    stage.phase = 'playoff';
    stage.done = false;
    stage.day = 1;   // 淘汰赛是新的比赛日序列，擂台赛的 day 计数不能带过来
    nextStage(game);
    return { type: 'survival', stage, results, playerResult: results.find((r) => r.isPlayer) || null, finished: true };
  }

  if (stage.phase === 'playoff') {
    if (!stage.bracket) {
      const field = [...stage.directToPlayoff, ...stage.survival.winners];
      const ranked = field
        .map((id) => ({ id, p: teamPower(game, id) }))
        .sort((x, y) => y.p - x.p)
        .map((x) => x.id);
      stage.bracket = doubleElimTemplate8(ranked);
      stage.day = 1;
    }
    const res = playBracketDay(game, rng, stage.bracket, stage.day, pid, { bestOf: 7, finalBestOf: 7 });
    stage.day += 1;
    if (res.finished) {
      stage.done = true;
      const pm = placementMap(stage.bracket);
      stage.placementMap = pm;
      for (const [tid, pl] of Object.entries(pm)) {
        game.placements[tid] = game.placements[tid] || {};
        game.placements[tid].finals = pl;
      }
      stage.championId = res.championId;
      stage.playerPlacement = pm[pid] ?? null;
      nextStage(game);
    }
    return {
      type: 'bracket', stage, bracket: stage.bracket, day: res.day,
      matches: res.matches, playerMatch: res.playerMatch,
      finished: res.finished, championId: res.championId,
      playerPlacement: stage.playerPlacement ?? null,
    };
  }
  return { type: 'finalsDone', stage };
}

/** 找下一个未完成的阶段（到达最后一个阶段后停住，由 currentStage 判定整季是否结束） */
export function nextStage(game) {
  while (game.stageIndex < game.stages.length && game.stages[game.stageIndex].done) {
    if (game.stageIndex >= game.stages.length - 1) break;
    game.stageIndex += 1;
  }
  return currentStage(game);
}

/**
 * 某支队伍当前所处组别
 * 优先第三轮分组，其次第二轮；轮次编号与 game.groupsByRound 的键一致
 */
export function divisionOfTeam(game, teamId) {
  const keys = Object.keys(game.groupsByRound).map(Number).sort((a, b) => b - a);
  for (const k of keys) {
    const groups = game.groupsByRound[k];
    for (const d of DIVISIONS) {
      if ((groups[d] || []).includes(teamId)) return d;
    }
  }
  return game.startDivision || 'B';
}

/** 某个组别当前的 6 支队伍 */
export function groupMembers(game, division) {
  const keys = Object.keys(game.groupsByRound).map(Number).sort((a, b) => b - a);
  for (const k of keys) {
    const ids = game.groupsByRound[k]?.[division];
    if (ids && ids.length) return ids;
  }
  return [];
}

/**
 * 赛季最终名次表（1-18），用于年度积分与奖金
 *  1-8：季后赛名次（冠军→1，亚军→2，四强→3/4，六强→5/6，八强→7/8）
 *  9-18：未进季后赛的队伍，按常规赛最后一轮所属组别与组内名次
 */
export function finalLeaguePlacements(game) {
  const out = {};
  // 赛季最后一次季后赛（夏季赛）决定联赛最终排名
  const bracketStage = ['summer', 'spring']
    .map((ev) => game.stages.find((s) => s.kind === 'bracket' && s.eventId === ev && s.bracket))
    .find(Boolean);
  if (bracketStage) {
    const bracket = bracketStage.bracket;
    const final = bracket.find((m) => m.id === 'F');
    if (final?.winnerId) {
      out[final.winnerId] = 1;
      out[final.loserId] = 2;
    }
    // 按淘汰轮次深度定名次（L6 败者组决赛负者 = 3，W7 胜者组决赛负者 = 3）
    const depth = { W7: 3, L6: 3, W5: 4, W6: 4, L5: 4, L4: 5, L3: 5, L2: 6, W3: 6, W4: 6, L1: 7, W1: 7, W2: 7 };
    for (const m of bracket) {
      if (!m.loserId || out[m.loserId]) continue;
      if (m.bracket === 'F') continue;
      out[m.loserId] = depth[m.id] ?? 8;
    }
    for (const seed of bracketStage.seeds || []) if (!out[seed]) out[seed] = 5;
  }
  // 其余队伍按最后一轮的分组与组内名次排 9-18
  const lastRound = Math.max(...Object.keys(game.groupsByRound).map(Number).filter((n) => !Number.isNaN(n)), 0);
  const groups = game.groupsByRound[lastRound] || game.groupsByRound[1];
  const tables = game.tablesByRound[lastRound] || {};
  let next = 9;
  for (const d of DIVISIONS) {
    const ids = (groups?.[d] || []).filter((id) => !out[id]);
    const ranked = rankTeams(ids, tables[d]);
    for (const id of ranked) {
      if (out[id]) continue;
      out[id] = next;
      next += 1;
    }
  }
  for (const id of Object.keys(game.teams)) if (!out[id]) { out[id] = next; next += 1; }
  return out;
}

/** ────────────────────────── 赛季结算 ────────────────────────── */
export function endOfSeason(game) {
  const pid = game.userTeamId;
  const leaguePlacement = finalLeaguePlacements(game);
  const rankMode = game.rankMode || 'record';
  const ranking = overallRanking(game, { strict: rankMode === 'division' });
  const me = ranking.find((r) => r.id === pid) || { rank: 18, div: 'B', divRank: 6 };

  /**
   * 终结名次口径
   *  - 打进季后赛的 8 队：一律以「季后赛战斗名次」为准（冠军就是第 1）。
   *    历史 bug：这里曾经对所有球队都用"跨组胜场"排序，导致拿了冠军的强队
   *    因为身处 S 组、常规赛胜场不占优，反而被排到第 15 名。
   *  - 未进季后赛的 9-18 名：按 rankMode 区分
   *      record  ：只看战绩（胜场 → 净胜局），B 组打得好也能排进中游
   *      division：严格按 S/A/B 组别与组内名次
   */
  const playoffRank = leaguePlacement[pid];
  let finalRank;
  if (playoffRank && playoffRank <= 8) {
    finalRank = playoffRank;
  } else if (rankMode === 'division') {
    finalRank = playoffRank || me.rank;
  } else {
    const outsides = ranking.filter((r) => (leaguePlacement[r.id] || 18) > 8);
    const idx = outsides.findIndex((r) => r.id === pid);
    finalRank = idx >= 0 ? 9 + idx : (playoffRank || me.rank);
  }

  // ── 奖金与年度积分 ──
  let prizeTotal = 0;
  const awards = [];
  for (const evId of ['spring', 'challenger', 'summer', 'finals']) {
    const st = game.stages.find((s) => s.eventId === evId && s.kind === 'bracket')
      || game.stages.find((s) => s.eventId === evId);
    const placement = st?.playerPlacement ?? null;
    const a = awardPlacement(game, evId, placement || 18);
    const champion = st?.championId === pid;
    const bonusPts = champion ? 8 : 0;
    game.annualPoints[pid] = (game.annualPoints[pid] || 0) + a.points + bonusPts;
    prizeTotal += a.prize;
    awards.push({ eventId: evId, placement: placement ?? null, prize: a.prize, points: a.points + bonusPts });
  }

  // 其他战队的年度积分：按各队在这三站的实际名次累加（与玩家同口径）
  const pointsFor = (evId, place) => {
    const tbl = ANNUAL_POINTS[evId];
    if (!tbl || !place) return 0;
    const keys = Object.keys(tbl).map(Number).sort((a, b) => a - b);
    for (const k of keys) if (place <= k) return tbl[k];
    return 0;
  };
  for (const id of Object.keys(game.teams)) {
    if (id === pid) continue;
    const pl = game.placements[id] || {};
    let pts = 0;
    for (const evId of ['spring', 'challenger', 'summer']) {
      pts += pointsFor(evId, pl[evId] || leaguePlacement[id] || 18);
    }
    game.annualPoints[id] = (game.annualPoints[id] || 0) + pts;
  }

  // ── 收支 ──
  const income = {
    leagueShare: leagueShareForRank(finalRank),
    sponsor: Math.round(FINANCE.sponsorBase + game.fame * FINANCE.sponsorPerFame),
    prize: prizeTotal,
    ticket: Math.round(FINANCE.ticketBase * (1 + game.fame / 100) * (me.div === 'S' ? 1.6 : me.div === 'A' ? 1.2 : 0.9)),
    merch: Math.round(FINANCE.merchBase * (1 + game.fame / 60)),
    transferIn: game.flags?.pendingTransferIncome || 0,
  };
  const wageBill = (game.squads[pid].starters || [])
    .concat(game.squads[pid].bench || [])
    .concat(game.squads[pid].youth || [])
    .reduce((s, id) => s + (game.players[id]?.wage || 0), 0);
  const expense = {
    wages: wageBill,
    base: FINANCE.baseCost,
    transfer: game.flags?.pendingTransferCost || 0,
    youth: game.flags?.youthInvest || 0,
  };
  const net = Object.values(income).reduce((a, b) => a + b, 0) - Object.values(expense).reduce((a, b) => a + b, 0);
  game.cash += net;

  // 季后赛奖金承诺（事件里答应的四强奖金）
  let bonusPaid = 0;
  const madeSemis = awards.some((a) => a.placement && a.placement <= 4);
  if (game.flags.bonusPromise && madeSemis) {
    bonusPaid = game.flags.bonusPromise;
    game.cash -= bonusPaid;
    expense.bonus = bonusPaid;
  }
  game.flags.bonusPromise = 0;

  // 声望：冠军加成
  const anyTitle = awards.some((a) => a.placement === 1);
  if (anyTitle) game.fame = Math.min(100, game.fame + FINANCE.fame.champion);
  else if (awards.some((a) => a.placement === 2)) game.fame = Math.min(100, game.fame + FINANCE.fame.runnerUp);

  const finalDiv = divisionOfTeam(game, pid);

  const summary = {
    season: game.season,
    rank: finalRank,
    div: finalDiv,
    divRank: me.divRank,
    awards,
    leaguePlacement,
    income,
    expense,
    net,
    bonusPaid,
    trainingSpend: game.flags.trainingSpend || 0,
    businessIncome: game.flags.businessIncome || 0,
    matchIncome: game.flags.matchIncome || 0,
    cashAfter: Math.round(game.cash),
    fameAfter: Math.round(game.fame * 10) / 10,
    champion: awards.some((a) => a.placement === 1),
  };
  game.history.push(summary);
  game.lastDivisionGroups = game.groupsByRound[3] || game.groupsByRound[2] || game.groupsByRound[1];
  game.lastRank = summary.rank;
  game.lastDiv = summary.div;

  // 财务与战绩考核
  if (game.cash < 0) game.bankruptSeasons = (game.bankruptSeasons || 0) + 1;
  else game.bankruptSeasons = 0;
  if (summary.rank >= 15) game.bottomSeasons = (game.bottomSeasons || 0) + 1;
  else game.bottomSeasons = 0;

  game.flags.pendingTransferIncome = 0;
  game.flags.pendingTransferCost = 0;
  game.flags.youthInvest = 0;
  game.flags.trainingSpend = 0;
  game.eventPending = null;

  return { type: 'seasonEnd', summary, ranking };
}

/** 进入下一个赛季（或判定结束） */
export function beginNextSeason(game) {
  if (game.gameOver) return { type: 'gameOver', gameOver: game.gameOver };
  // 强制结束优先于赛季数量上限：破产/解雇发生在先，就不该以"四个赛季结束"收场
  if (game.bankruptSeasons >= 2) {
    game.gameOver = { reason: 'bankrupt', title: '资金断裂', detail: '连续两个赛季现金为负，俱乐部被联盟接管，你的总经理生涯到此为止。' };
    return { type: 'gameOver', gameOver: game.gameOver };
  }
  if (game.bottomSeasons >= 2) {
    game.gameOver = { reason: 'fired', title: '战绩崩盘', detail: '连续两个赛季排名倒数三，董事会失去耐心，你被解雇。' };
    return { type: 'gameOver', gameOver: game.gameOver };
  }
  if (game.season >= game.seasonLimit) {
    game.gameOver = { reason: 'complete', title: '四个赛季结束', detail: '硬上限到期，进入生涯回顾。' };
    return { type: 'gameOver', gameOver: game.gameOver };
  }
  game.season += 1;
  startSeason(game);
  nextStage(game);
  return { type: 'newSeason', season: game.season };
}

/**
 * 休赛期：球员成长与老化 → 每年新秀 → 转会市场刷新
 * 在第 N 赛季结算之后、第 N+1 赛季开始之前调用。
 */
export function beginOffseason(game, rng) {
  const r = rng || game.__rng || createRng(game.seed || 20261005);
  game.__rng = r;
  const pid = game.userTeamId;
  const nextMeta = META_VERSIONS[Math.min(game.season, META_VERSIONS.length - 1)];

  // 1. 成长与老化
  const development = developAll(game, r);
  const myIds = new Set((game.squads[pid].starters || []).concat(game.squads[pid].bench || [], game.squads[pid].youth || []));
  const mine = development.filter((d) => myIds.has(d.id));
  const risers = development.slice(0, 3);
  const fallers = development.slice(-3).reverse();

  // 2. 每年新秀补充（每队一名，进青训）
  const rookies = [];
  for (const teamId of Object.keys(game.teams)) {
    const quality = r.chance(0.18) ? 'elite' : r.chance(0.5) ? 'good' : 'normal';
    const p = generateProspect(r, teamId, quality);
    game.players[p.id] = p;
    game.squads[teamId].youth = game.squads[teamId].youth || [];
    game.squads[teamId].youth.push(p.id);
    if (teamId === pid) rookies.push(p);
  }

  // 3. 触发离队条款：上季闹过加薪的核心，身价上浮并要求挂牌
  const forced = [];
  if (game.flags.angryStar) {
    game.flags.angryStar = false;
    const list = (game.squads[pid].starters || []).map((id) => game.players[id]).filter(Boolean)
      .sort((a, b) => b.overall - a.overall);
    const star = list[0];
    if (star && star.overall >= 78) {
      star.value = marketValue(star);
      forced.push({ playerId: star.id, name: star.name, overall: star.overall, role: star.role });
    }
  }

  // 4. 转会市场
  const market = refreshMarket(game, r);
  // 5. 新赛季球员价值重估
  for (const p of Object.values(game.players)) p.value = marketValue(p);

  // 6. 个人剧情：焦点球员（有明确成长弧的自家球员）+ 采访发言
  const focus = mine.filter((d) => d.arc && ['breakout', 'rising', 'slump', 'bust'].includes(d.arc.key));
  const quotes = [];
  const starPlayers = (game.squads[pid].starters || []).map((id) => game.players[id]).filter(Boolean);
  const star = bestOf(starPlayers);
  if (star) {
    quotes.push({
      playerId: star.id, playerName: star.name, trait: star.trait,
      text: pickQuote(star, 'season', `s${game.season}`),
    });
  }
  for (const f of focus.slice(0, 2)) {
    const p = game.players[f.id];
    if (!p) continue;
    const sit = (f.arc.key === 'slump' || f.arc.key === 'bust') ? 'slump' : 'mvp';
    quotes.push({ playerId: p.id, playerName: p.name, trait: p.trait, text: pickQuote(p, sit, `s${game.season}`) });
  }

  return {
    development,
    mine,
    focus,
    quotes,
    risers,
    fallers,
    rookies,
    forced,
    market,
    nextMeta,
  };
}
