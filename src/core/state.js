/**
 * 存档与全局状态
 * 一个存档 = 一个 game 对象，纯 JSON，可直接进 localStorage
 */
import { createRng } from './rng.js';
import { FINANCE, WAGE_SCALE, tierWageMul, contractWage } from './constants.js';
import { buildInitialWorld, META_VERSIONS } from '../sim/team.js';
import { ensureTraits } from '../sim/story.js';
import { startSeason, nextStage, advance, overallRanking } from '../sim/season.js';
import { wageCap } from '../sim/transfer.js';
import { recoverFatigue } from '../sim/business.js';
import { rollEvent } from '../sim/events.js';
import { TEAMS } from '../data/teams.js';
import { ROLE_ORDER } from '../data/players.js';

export const SAVE_KEY = 'kpl_gm_save_v1';

/**
 * 薪资缩放：把数据表里的"选手市场价"折算成俱乐部实际支付的成本。
 * 缩放只在建新档时做一次，之后由合同与转会决定，不再每年重算。
 */
export function applyWageScale(game) {
  for (const p of Object.values(game.players)) {
    const tier = TEAMS.find((t) => t.id === p.teamId)?.tier || 'A';
    p.wage = Math.max(50, Math.round(p.wage * WAGE_SCALE * tierWageMul(tier)));
  }
  return game;
}

/** 建新档 */
export function createGame({ userTeamId, starterIds, coachLevel = 70, managerName = '你', seasonLimit = 4, rankMode = 'record', draftSpend = 0 }) {
  const world = buildInitialWorld();
  if (!world.teams[userTeamId]) {
    throw new Error(`createGame: 无效的战队 id "${userTeamId}"（必须是 18 支战队之一的 id 字符串）`);
  }
  const game = {
    version: 1,
    createdAt: Date.now(),
    managerName,
    userTeamId,
    season: 1,
    seasonLimit,
    rankMode,
    stageIndex: 0,
    stages: [],
    week: 1,
    cash: Math.round(world.teams[userTeamId].budget - (draftSpend || 0)),
    fame: 30,
    coachLevel,
    chemistry: {},
    morale: {},
    fatigue: {},
    teams: world.teams,
    squads: world.squads,
    players: world.players,
    groupsByRound: {},
    tablesByRound: {},
    divisionOf: {},
    annualPoints: {},
    placements: {},
    seasonMatches: { spring: [], summer: [] },
    lastRank: 12,
    lastDiv: 'B',
    history: [],
    h2h: {},               // oppTeamId -> { wins, losses, last } 跨赛季交战记录
    recentResults: [],     // 最近 5 场战绩（左下角显示）
    log: [],
    flags: {},
    training: {},          // playerId -> { laning, macro, teamfight, champPool, total } 本赛季特训次数
    trainingTeam: {},      // morale / chem 本赛季团队投入次数
    business: {},          // activityId -> 本赛季已做次数（跑商务/直播/综艺…）
    bankruptSeasons: 0,
    bottomSeasons: 0,
    gameOver: null,
    lastDivisionGroups: null,
  };

  for (const t of TEAMS) {
    game.chemistry[t.id] = t.tier === 'S' ? 78 : t.tier === 'A' ? 72 : 66;
    game.morale[t.id] = 70;
    game.fatigue[t.id] = 0;
    game.annualPoints[t.id] = 0;
  }
  // 薪资分层：数据表存的是选手市场价，先做全局缩放，再按球队档位分层
  // （S 档开高薪、B 档自然压价，对应真实 KPL 的薪资差距）
  applyWageScale(game);
  // 为全体球员补齐性格与成长历史（球员个人剧情线的基础数据）
  ensureTraits(game);

  if (starterIds && starterIds.length === 5) {
    const picked = starterIds.filter((id) => game.players[id]);
    const rest = (game.squads[userTeamId].starters || []).concat(game.squads[userTeamId].bench || [])
      .filter((id) => !picked.includes(id));
    const byRole = {};
    for (const id of picked) {
      const p = game.players[id];
      if (p) byRole[p.role] = id;
    }
    // 未指定位置时，用原队球员补齐
    const starters = ROLE_ORDER.map((r) => byRole[r] || rest.find((id) => game.players[id]?.role === r)).filter(Boolean);
    const bench = (game.squads[userTeamId].bench || []).concat(game.squads[userTeamId].starters || [])
      .filter((id) => !starters.includes(id));
    game.squads[userTeamId] = {
      starters,
      bench,
      youth: game.squads[userTeamId].youth || [],
    };
  }

  // 玩家自选首发时同步把球员划入该队
  for (const id of game.squads[userTeamId].starters) {
    if (game.players[id]) game.players[id].teamId = userTeamId;
  }

  // 抽卡可能抽到别队球员：从原队名册里摘掉，避免同一球员同时属于两支队伍。
  // 原队的空缺会在 startSeason 的 repairSquad 里自动补位（替补 → 青训 → 临时自由人）。
  const mineIds = new Set(
    (game.squads[userTeamId].starters || [])
      .concat(game.squads[userTeamId].bench || [], game.squads[userTeamId].youth || []),
  );
  for (const tid of Object.keys(game.squads)) {
    if (tid === userTeamId) continue;
    const s = game.squads[tid];
    for (const k of ['starters', 'bench', 'youth']) {
      s[k] = (s[k] || []).filter((id) => !mineIds.has(id));
    }
  }
  // 抽到的首发按玩家战队档位重算年薪，与转会签约口径保持一致
  const userTier = TEAMS.find((t) => t.id === userTeamId)?.tier || 'A';
  for (const id of game.squads[userTeamId].starters) {
    const p = game.players[id];
    if (p) p.wage = contractWage(p.value, userTier);
  }

  startSeason(game);

  // 抽卡可能凑出一套"贵过预算"的阵容：若全队年薪超过工资帽，就按比例压缩首发年薪
  // （下限 60 万）。否则玩家开局就顶在工资帽之上，整季一个人都签不了。
  // 注意：必须放在 startSeason 之后 —— 补位可能临时签入自由人，会继续抬高工资总额。
  const squad = game.squads[userTeamId];
  const cap = wageCap(game);
  for (let pass = 0; pass < 3; pass += 1) {
    const starterPlayers = (squad.starters || []).map((id) => game.players[id]).filter(Boolean);
    const starterBill = starterPlayers.reduce((s, p) => s + p.wage, 0);
    const totalBill = (squad.starters || []).concat(squad.bench || [], squad.youth || [])
      .reduce((s, id) => s + (game.players[id]?.wage || 0), 0);
    if (totalBill <= cap || starterBill <= 0) break;
    const room = Math.max(0, cap - (totalBill - starterBill));
    const mul = Math.max(0.3, room / starterBill);
    for (const p of starterPlayers) p.wage = Math.max(60, Math.round(p.wage * mul));
    game.flags.draftWageSqueeze = Math.round((1 - mul) * 100);
  }
  // 收尾：等比压缩会因四舍五入略微超出，这里做一次逐万微调，确保不超过工资帽
  const billNow = () => (squad.starters || []).concat(squad.bench || [], squad.youth || [])
    .reduce((s, id) => s + (game.players[id]?.wage || 0), 0);
  let guard = 0;
  while (billNow() > cap && guard++ < 400) {
    const priciest = (squad.starters || []).map((id) => game.players[id])
      .filter((p) => p && p.wage > 60)
      .sort((a, b) => b.wage - a.wage)[0];
    if (!priciest) break;
    priciest.wage -= 1;
  }

  nextStage(game);
  game.metaVersion = META_VERSIONS[0].id;
  return game;
}

/** 玩家推进一次 */
export function advanceOnce(game, action = {}) {
  if (game.gameOver) return { type: 'gameOver', gameOver: game.gameOver };
  const rng = game.__rng || (game.__rng = createRng(game.seed || 20261005));
  const result = advance(game, rng, action);
  applyFinanceTick(game, result);
  if (result.finished || result.type === 'regroup' || result.type === 'card') {
    nextStage(game);
  }
  // 赛程节点触发突发事件（每个阶段只触发一次，避免逐日重复）
  const stage = result.stage;
  if (stage && !game.gameOver && !stage._counted && !game.eventPending) {
    stage._counted = true;
    const cardPerStage = stage.kind === 'group' ? 0.22 : 0.45;
    if (rng.chance(cardPerStage)) {
      const card = rollEvent(game, rng);
      if (card) {
        game.eventPending = card.id;
        result.eventCard = card;
      }
    }
  }
  // 注意：破产与解雇只在赛季结算时判定，避免逐日累计误杀
  return result;
}

/** 每个比赛日结算：赢球奖金 + 声望 */
function applyFinanceTick(game, result) {
  const pid = game.userTeamId;
  const playerWin = result.playerResult && result.playerResult.winnerId === pid;
  const played = !!result.playerResult;
  if (played) {
    if (playerWin) {
      game.cash += FINANCE.winBonus;
      game.fame = Math.min(100, game.fame + FINANCE.fame.win);
      game.morale[pid] = Math.min(100, (game.morale[pid] ?? 70) + 2);
    } else {
      game.fame = Math.max(0, game.fame + FINANCE.fame.lose);
      game.morale[pid] = Math.max(20, (game.morale[pid] ?? 70) - 2);
    }
  }
  // 每个比赛日给所有队伍恢复一点疲劳（跑商务留下的状态损耗会慢慢养回来）
  const isMatchDay = ['matchday', 'bracket', 'arena', 'survival', 'card'].includes(result.type);
  if (isMatchDay) recoverFatigue(game);
  // 常规营收：打完一轮就有进账（门票 / 转播 / 主场），与胜负无关，随声望浮动
  if (isMatchDay) {
    const income = matchdayIncome(game);
    game.cash += income;
    game.flags.matchIncome = (game.flags.matchIncome || 0) + income;
  }
  // 累积与各队的跨赛季交战记录（历史战绩左下角用）
  recordH2H(game, result);
}

/** 从一次推进结果里提取玩家那场比赛，累积与对手的跨赛季交战记录 */
function recordH2H(game, result) {
  const pid = game.userTeamId;
  // 找到玩家参与的那场（不同赛事结构不同）
  let m = result.playerResult;
  if (!m && result.playerCard) m = result.playerCard;
  if (!m && result.playerMatch?.result) {
    const r = result.playerMatch.result;
    // bracket 用 teamA/teamB 对象，转成 a/b 形式
    m = { a: r.teamA?.id ?? r.a, b: r.teamB?.id ?? r.b, winnerId: r.winnerId, scoreA: r.scoreA, scoreB: r.scoreB };
  }
  if (!m || !m.a || !m.b || !m.winnerId) return;
  const opp = m.a === pid ? m.b : m.a;
  if (opp === pid) return;

  game.h2h = game.h2h || {};
  const rec = game.h2h[opp] || (game.h2h[opp] = { wins: 0, losses: 0, last: null });
  if (m.winnerId === pid) rec.wins += 1; else rec.losses += 1;
  const myScore = m.a === pid ? m.scoreA : m.scoreB;
  const oppScore = m.a === pid ? m.scoreB : m.scoreA;
  rec.last = { season: game.season, my: myScore, opp: oppScore };

  // 近五场战绩（左下角常驻显示）
  game.recentResults = game.recentResults || [];
  game.recentResults.unshift({
    season: game.season,
    opp,
    win: m.winnerId === pid,
    my: myScore,
    opp: oppScore,
  });
  game.recentResults = game.recentResults.slice(0, 5);
}

/** 一轮比赛的常规营收（万元）—— 打完比赛就有进账 */
export function matchdayIncome(game) {
  const m = FINANCE.matchIncome;
  return Math.max(1, Math.round(m.base + (game.fame || 0) * m.perFame));
}

/** 强制结束判定（只在赛季结算时调用） */
export function checkFailure(game) {
  const pid = game.userTeamId;
  if (game.cash < 0) game.bankruptSeasons = (game.bankruptSeasons || 0) + 1;
  else game.bankruptSeasons = 0;

  const ranking = overallRanking(game, { strict: false });
  const me = ranking.find((r) => r.id === pid);
  if (me && me.rank >= 15) game.bottomSeasons = (game.bottomSeasons || 0) + 1;
  else game.bottomSeasons = 0;

  if (game.bankruptSeasons >= 2) {
    game.gameOver = { reason: 'bankrupt', title: '资金断裂', detail: '连续两个赛季现金为负，俱乐部被联盟接管，你的总经理生涯到此为止。' };
  } else if (game.bottomSeasons >= 2) {
    game.gameOver = { reason: 'fired', title: '战绩崩盘', detail: '连续两个赛季排名倒数三，董事会失去耐心，你被解雇。' };
  } else if (game.season >= game.seasonLimit) {
    game.gameOver = { reason: 'complete', title: '四个赛季结束', detail: '硬上限到期，进入生涯回顾。' };
  }
  return game.gameOver;
}

export function saveGame(game) {
  const clone = JSON.parse(JSON.stringify(game, (k, v) => (k === '__rng' ? undefined : v)));
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(clone));
    return true;
  } catch (e) {
    console.error('存档失败', e);
    return false;
  }
}

/**
 * 读档自检与修复
 * 历史 bug 会把 userTeamId 存成 undefined，导致所有界面读 teams[undefined].name 直接崩溃。
 * 这里把坏档修回可玩状态，而不是让玩家看到一片空白。
 */
export function validateAndRepairGame(game) {
  const repair = { fixed: [], fatal: false };
  if (!game || typeof game !== 'object') return { game: null, repair: { fatal: true, fixed: ['存档内容不是对象'] } };

  // 1. 战队 id 必须指向真实存在的战队
  if (!game.teams || !game.teams[game.userTeamId]) {
    const fallback = (game.teams && Object.keys(game.teams)[0]) || TEAMS[0].id;
    repair.fixed.push(`战队 id 无效（原值 ${JSON.stringify(game.userTeamId)}），已回退为 ${TEAMS.find((t) => t.id === fallback)?.name || fallback}`);
    game.userTeamId = fallback;
  }

  // 2. 基础字段
  const defaults = {
    season: 1, seasonLimit: 4, stageIndex: 0, cash: 2000, fame: 30,
    chemistry: {}, morale: {}, fatigue: {}, annualPoints: {}, placements: {},
    squads: {}, players: {}, teams: {}, history: [], log: [], flags: {},
    training: {}, trainingTeam: {}, business: {},
    bankruptSeasons: 0, bottomSeasons: 0, lastRank: 12,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (game[k] === undefined || game[k] === null) {
      game[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
      repair.fixed.push(`补齐缺失字段 ${k}`);
    }
  }

  // 3. 名册与球员表必须完好；否则用静态数据重建
  const pid = game.userTeamId;
  const sq = game.squads[pid];
  const squadBroken = !sq || !Array.isArray(sq.starters)
    || sq.starters.length !== 5
    || sq.starters.some((id) => !game.players?.[id]);
  if (squadBroken) {
    const world = buildInitialWorld();
    game.players = { ...world.players, ...(game.players || {}) };
    game.squads = game.squads || {};
    game.squads[pid] = world.squads[pid];
    repair.fixed.push('名册缺失或首发不完整，已按 2026 赛季真实名单重建该队阵容');
  } else {
    for (const k of ['bench', 'youth']) {
      if (!Array.isArray(sq[k])) { sq[k] = []; repair.fixed.push(`补齐 ${k} 列表`); }
    }
    sq.bench = sq.bench.filter((id) => game.players[id]);
    sq.youth = sq.youth.filter((id) => game.players[id]);
  }
  // 其他战队名册缺失也补上，否则赛程推不动
  if (!game.squads) game.squads = {};
  for (const t of TEAMS) {
    const s = game.squads[t.id];
    if (!s || !Array.isArray(s.starters) || s.starters.length !== 5) {
      const world = buildInitialWorld();
      game.squads[t.id] = world.squads[t.id];
      Object.assign(game.players, world.players);
      repair.fixed.push(`重建 ${t.short} 阵容`);
    }
  }

  // 4. 赛季赛程：丢了就重建，避免卡在空阶段
  if (!Array.isArray(game.stages) || !game.stages.length) {
    startSeason(game);
    nextStage(game);
    repair.fixed.push('赛程丢失，已重置本赛季赛程');
  }

  // 4b. 球员剧情数据：老存档没有性格/成长历史，补齐后才能渲染球员档案
  const missingTraits = Object.values(game.players || {}).filter((p) => !p.trait).length;
  if (missingTraits) {
    ensureTraits(game);
    for (const p of Object.values(game.players || {})) {
      if (!Array.isArray(p.history) || !p.history.length) p.history = [{ s: 0, o: p.overall }];
    }
    repair.fixed.push(`补齐 ${missingTraits} 名球员的性格与成长弧数据`);
  }

  // 5. 阶段索引越界
  if (game.stageIndex >= game.stages.length) game.stageIndex = Math.max(0, game.stages.length - 1);

  return { game, repair };
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const { game, repair } = validateAndRepairGame(parsed);
    if (!game) return null;
    game.__rng = createRng(game.seed || 20261005);
    game.__repair = repair;
    if (repair.fixed.length) {
      console.warn('[存档修复]', repair.fixed);
      saveGame(game);   // 立即写回，避免每次读档都修一遍
    }
    return game;
  } catch (e) {
    console.error('读档失败', e);
    return null;
  }
}

export function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
