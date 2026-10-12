/**
 * 平衡性校准：批量跑完整生涯（含休赛期成长/老化/事件），统计成绩分布与破产率
 * 用法：node tools/calibrate.mjs [每队局数] [是否启用AI转会 auto|none]
 */
import { createGame, advanceOnce } from '../src/core/state.js';
import { currentStage, beginNextSeason, beginOffseason } from '../src/sim/season.js';
import { createRng } from '../src/core/rng.js';
import { TEAMS } from '../src/data/teams.js';
import { resolveEvent } from '../src/sim/events.js';

const RUNS = Number(process.argv[2] || 12);

/**
 * 模拟一个"普通玩家"的休赛期行为：
 *  - 事件全选第一个选项（大多数是花钱/加成）
 *  - 现金 < 600 时卖一名替补回血，否则看到明显更强的便宜球员就买一个
 *  - 每季投入最低档青训
 */
function autoOffseason(game, rng, mode) {
  const data = beginOffseason(game, rng);
  if (mode === 'none') return data;
  const pid = game.userTeamId;
  const { signPlayer, teamWageBill, wageCap } = transferCache;
  // 青训最低档
  if (game.cash > 900) transferCache.investYouth(game, rng, 0);
  // 缺钱先卖人
  if (game.cash < 600) {
    const offer = game.market.offers[0];
    if (offer) transferCache.acceptOffer(game, offer);
  }
  // 有闲钱补强最弱位置
  const need = transferCache.neediestRoles(game, pid);
  const bill = teamWageBill(game, pid);
  const cap = wageCap(game);
  for (const l of game.market.listings) {
    if (game.cash < 1400) break;
    if (!need.includes(l.role)) continue;
    const wage = Math.round(l.value * 0.62);
    if (bill + wage > cap) continue;
    const r = signPlayer(game, l);
    if (r.ok) break;
  }
  return data;
}

const transferCache = await import('../src/sim/transfer.js');

function runCareer(teamId, seed, mode) {
  const game = createGame({ userTeamId: teamId });
  game.seed = seed;
  game.__rng = createRng(seed);
  let guard = 0;
  let lastRank = null;
  let titles = 0;
  let titlesPerSeason = [];
  let eventsTaken = 0;
  let bankrupt = false;
  let fired = false;

  while (guard++ < 4000) {
    const stage = currentStage(game);
    const r = advanceOnce(game, {});
    if (r.eventCard) {
      // 普通玩家：选第一个选项
      resolveEvent(game, r.eventCard.id, 0);
      game.eventPending = null;
      eventsTaken += 1;
    }
    if (r.type === 'bracket' && r.finished && r.championId === teamId) titles += 1;
    if (r.type === 'seasonEnd') {
      lastRank = r.summary.rank;
      titlesPerSeason.push(r.summary.champion ? 1 : 0);
      if (game.season >= game.seasonLimit) {
        return { rank: lastRank, titles, gameOver: 'complete', cash: game.cash, events: eventsTaken, seasons: game.season };
      }
      autoOffseason(game, game.__rng, mode);
      const nx = beginNextSeason(game);
      if (nx.type === 'gameOver') {
        bankrupt = nx.gameOver.reason === 'bankrupt';
        fired = nx.gameOver.reason === 'fired';
        return {
          rank: lastRank, titles, gameOver: nx.gameOver.reason, cash: game.cash,
          events: eventsTaken, seasons: game.season, bankrupt, fired,
        };
      }
    }
    if (r.type === 'gameOver') {
      return { rank: lastRank, titles, gameOver: r.gameOver.reason, cash: game.cash, events: eventsTaken, seasons: game.season };
    }
  }
  return { rank: lastRank, titles, gameOver: 'timeout', cash: game.cash, events: eventsTaken, seasons: game.season };
}

const mode = process.argv[3] || 'auto';
console.log(`每队 ${RUNS} 次完整生涯（4 赛季，休赛期模式：${mode}）\n`);
console.log('队伍    档位  平均终局名次  总冠军  突发事件  破产  解雇  完成  期末现金');
const summary = {};
for (const t of TEAMS) {
  let rankSum = 0;
  let rankN = 0;
  let titles = 0;
  let events = 0;
  let bankrupt = 0;
  let fired = 0;
  let complete = 0;
  let cashSum = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const res = runCareer(t.id, 100000 + i * 7919 + t.id.length * 131, mode);
    if (res.rank) { rankSum += res.rank; rankN += 1; }
    titles += res.titles;
    events += res.events;
    cashSum += res.cash || 0;
    if (res.gameOver === 'bankrupt') bankrupt += 1;
    else if (res.gameOver === 'fired') fired += 1;
    else if (res.gameOver === 'complete') complete += 1;
  }
  const avgRank = rankN ? (rankSum / rankN).toFixed(1) : '-';
  const avgCash = Math.round(cashSum / RUNS);
  summary[t.id] = { avgRank: Number(avgRank), titles, bankrupt, fired, avgCash };
  console.log(
    `${t.short.padEnd(7)} ${t.tier}    ${String(avgRank).padStart(6)}      ${String(titles).padStart(4)}   ${String((events / RUNS).toFixed(1)).padStart(6)}   ${String(bankrupt).padStart(3)}   ${String(fired).padStart(3)}   ${String(complete).padStart(3)}   ${String(avgCash).padStart(7)}`,
  );
}

const totalRuns = TEAMS.length * RUNS;
const totalBankrupt = Object.values(summary).reduce((s, x) => s + x.bankrupt, 0);
const totalFired = Object.values(summary).reduce((s, x) => s + x.fired, 0);
console.log(`\n共 ${totalRuns} 次生涯：破产 ${totalBankrupt} 次 (${(totalBankrupt / totalRuns * 100).toFixed(1)}%)，解雇 ${totalFired} 次 (${(totalFired / totalRuns * 100).toFixed(1)}%)`);
const sTier = TEAMS.filter((t) => t.tier === 'S').map((t) => summary[t.id].avgRank);
const aTier = TEAMS.filter((t) => t.tier === 'A').map((t) => summary[t.id].avgRank);
const bTier = TEAMS.filter((t) => t.tier === 'B').map((t) => summary[t.id].avgRank);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`S 档平均终局名次 ${mean(sTier).toFixed(1)} | A 档 ${mean(aTier).toFixed(1)} | B 档 ${mean(bTier).toFixed(1)}`);
console.log(`S 档总冠军 ${sTier.reduce((s, _, i) => s + TEAMS.filter((t) => t.tier === 'S')[i] ? 0 : 0, 0) + TEAMS.filter((t) => t.tier === 'S').reduce((s, t) => s + summary[t.id].titles, 0)} 个 / B 档 ${TEAMS.filter((t) => t.tier === 'B').reduce((s, t) => s + summary[t.id].titles, 0)} 个`);
