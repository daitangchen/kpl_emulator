/**
 * 强制结束条件验证：确认"资金断裂"与"战绩崩盘"两条路径都真能触发
 * 用法：node tools/test-failure.mjs
 */
import { createGame, advanceOnce } from '../src/core/state.js';
import { currentStage, beginNextSeason, beginOffseason } from '../src/sim/season.js';
import { createRng } from '../src/core/rng.js';
import { investYouth, signPlayer, teamWageBill, wageCap } from '../src/sim/transfer.js';
import { resolveEvent } from '../src/sim/events.js';
import { FINANCE } from '../src/core/constants.js';

/**
 * 资金断裂路径（确定性验证）
 * 用一支"战绩不会崩"的强队（AG），但每季开局把现金做成大额负债，
 * 这样能单独验证「连续两季现金为负 → 破产」这条规则，
 * 而不会被「连续两季排名倒数三 → 解雇」抢先触发。
 */
function bankruptRun(seed) {
  const game = createGame({ userTeamId: 'ag' });
  game.__rng = createRng(seed);
  let atSeasonStart = true;
  let guard = 0;
  while (guard++ < 4000) {
    if (atSeasonStart) { game.cash = -5000; atSeasonStart = false; }   // 模拟挥霍：一开季就资不抵债
    const r = advanceOnce(game, {});
    if (r.eventCard) { resolveEvent(game, r.eventCard.id, 0); game.eventPending = null; }
    if (r.type === 'seasonEnd') {
      const nx = beginNextSeason(game);
      if (nx.type === 'gameOver') {
        return { gameOver: nx.gameOver.reason, title: nx.gameOver.title, seasons: game.season, rank: r.summary.rank, cash: game.cash };
      }
      atSeasonStart = true;
    }
    if (r.type === 'gameOver') return { gameOver: r.gameOver.reason, title: r.gameOver.title, seasons: game.season };
  }
  return { gameOver: 'timeout', seasons: game.season };
}

/** 参考信息：败家玩法（弱队 + 顶配青训 + 买最贵球员）会以何种方式收场 */
function wastefulRun(seed) {
  const game = createGame({ userTeamId: 'wst' });
  game.__rng = createRng(seed);
  let guard = 0;
  while (guard++ < 4000) {
    const r = advanceOnce(game, {});
    if (r.eventCard) { resolveEvent(game, r.eventCard.id, 0); game.eventPending = null; }
    if (r.type === 'seasonEnd') {
      beginOffseason(game, game.__rng);
      for (let i = 0; i < 3; i += 1) investYouth(game, game.__rng, 2);
      const expensive = game.market.listings.slice().sort((a, b) => b.price - a.price)[0];
      if (expensive) signPlayer(game, expensive);
      const nx = beginNextSeason(game);
      if (nx.type === 'gameOver') return { gameOver: nx.gameOver.reason, rank: r.summary.rank, cash: game.cash };
    }
    if (r.type === 'gameOver') return { gameOver: r.gameOver.reason, rank: null, cash: game.cash };
  }
  return { gameOver: 'timeout', cash: game.cash };
}

console.log('═══ 破产路径验证（强队 + 每季资不抵债）═══');
let bankruptFound = null;
for (let seed = 1; seed <= 12 && !bankruptFound; seed += 1) {
  const r = bankruptRun(seed * 7919);
  console.log(`  seed ${String(seed).padStart(2)}: 结果=${r.gameOver.padEnd(9)} 第 ${r.seasons} 赛季 末季第 ${r.rank ?? '-'} 名 现金=${Math.round(r.cash ?? 0)}`);
  if (r.gameOver === 'bankrupt') bankruptFound = r;
}
console.log(bankruptFound
  ? `\n✓ 破产路径可触发：第 ${bankruptFound.seasons} 赛季资金断裂`
  : '\n✗ 破产路径未能触发（说明破产规则失效）');

console.log('\n-- 参考：败家玩法（弱队 + 顶配青训 + 买最贵球员）的收场方式 --');
const wasteful = ['fired', 'bankrupt'].map((_, i) => wastefulRun(7919 * (i + 1))).map((r) => r.gameOver);
console.log(`  前 2 次试跑结果：${wasteful.join(' / ')}（越是乱花钱，越可能先因战绩崩盘被解雇）`);

console.log('\n═══ 战绩崩盘路径验证（弱队完全不作为）═══');
function passiveRun(seed, teamId) {
  const game = createGame({ userTeamId: teamId });
  game.seed = seed;
  game.__rng = createRng(seed);
  let guard = 0;
  while (guard++ < 4000) {
    const r = advanceOnce(game, {});
    if (r.eventCard) { resolveEvent(game, r.eventCard.id, 0); game.eventPending = null; }
    if (r.type === 'seasonEnd') {
      if (game.season >= game.seasonLimit) return { gameOver: 'complete', seasons: game.season, rank: r.summary.rank, bottomSeasons: game.bottomSeasons };
      beginOffseason(game, game.__rng);
      const nx = beginNextSeason(game);
      if (nx.type === 'gameOver') return { gameOver: nx.gameOver.reason, title: nx.gameOver.title, seasons: game.season, rank: r.summary.rank, bottomSeasons: game.bottomSeasons };
    }
    if (r.type === 'gameOver') return { gameOver: r.gameOver.reason, title: r.gameOver.title, seasons: game.season, bottomSeasons: game.bottomSeasons };
  }
  return { gameOver: 'timeout', seasons: game.season };
}
let firedCount = 0;
const runs = 8;
for (let i = 0; i < runs; i += 1) {
  const r = passiveRun(1000 + i * 131, 'we');
  if (r.gameOver === 'fired') firedCount += 1;
  console.log(`  WE seed ${i}: ${r.gameOver.padEnd(9)} 被解雇计数=${r.bottomSeasons} 末季第 ${r.rank} 名`);
}
console.log(`\n${firedCount}/${runs} 次触发"战绩崩盘"`);
console.log(bankruptFound && firedCount > 0 ? '\n两条强制结束路径均已验证 ✓' : '\n仍有路径未触发 ✗');
