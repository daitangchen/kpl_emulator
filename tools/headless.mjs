/**
 * 无头验证：不依赖浏览器，跑完整个生涯（默认 4 个赛季）
 * 用法：node tools/headless.mjs [teamId] [seasons]
 */
import { createGame, advanceOnce } from '../src/core/state.js';
import { currentStage, beginNextSeason } from '../src/sim/season.js';
import { createRng } from '../src/core/rng.js';
import { simulateSeries } from '../src/sim/match.js';

const teamId = process.argv[2] || 'rngm';
const maxSeasons = Number(process.argv[3] || 4);

const game = createGame({ userTeamId: teamId });
game.seed = 20261005;
game.__rng = createRng(game.seed);

const short = (id) => game.teams[id]?.short || id;

console.log('═══ 建队 ═══');
console.log('战队:', game.teams[teamId].name, '| 现金:', game.cash, '万 | 声望:', game.fame, '| 教练:', game.coachLevel);
console.log('首发:', game.squads[teamId].starters.map((id) => game.players[id].name).join(' '));
console.log('替补:', (game.squads[teamId].bench || []).map((id) => game.players[id].name).join(' '));

// ── 赛制规则自检 ──
console.log('\n═══ BO5 / BO7 / BO9 规则自检 ═══');
const A = { id: 'a', name: 'A队', power: 80, mentality: 70 };
const B = { id: 'b', name: 'B队', power: 78, mentality: 70 };
for (const bo of [5, 7, 9]) {
  const samples = [];
  for (let i = 0; i < 4; i += 1) {
    const r = simulateSeries({ teamA: A, teamB: B, bestOf: bo, homeTeamId: 'a' }, game.__rng);
    const segs = r.games.filter((g) => g.segmentEnd).length;
    samples.push(`${r.finalScore}(${r.games.length}局,${segs}段,巅峰=${r.hadPeakShowdown ? 'Y' : 'N'})`);
  }
  console.log(`BO${bo}: ${samples.join('  ')}`);
}

// ── 完整生涯推进 ──
let steps = 0;
let seasonNo = 1;
let carries = true;
console.log('\n═══ 生涯推进 ═══');
while (carries && steps < 3000) {
  const st = currentStage(game);
  const r = advanceOnce(game, {});
  steps += 1;

  if (r.type === 'matchday' && r.playerResult) {
    const pr = r.playerResult;
    const mine = pr.a === teamId ? pr.scoreA : pr.scoreB;
    const theirs = pr.a === teamId ? pr.scoreB : pr.scoreA;
    const opp = short(pr.a === teamId ? pr.b : pr.a);
    const ev = r.stage.eventId === 'spring' ? '春' : '夏';
    console.log(`  [${ev}${r.stage.roundIndex}轮 D${r.day}] vs ${opp}  ${mine}-${theirs} ${pr.winnerId === teamId ? '胜' : '负'}`);
  } else if (r.type === 'eliminatedEarly') {
    console.log(`  ⚠ ${r.message}`);
  } else if (r.type === 'card' && r.playerCard) {
    const c = r.playerCard;
    console.log(`  [卡位赛] vs ${short(c.a === teamId ? c.b : c.a)}  ${c.finalScore} ${c.winnerId === teamId ? '保组/升级成功' : '降组'}`);
  } else if (r.type === 'bracket') {
    if (r.playerMatch) {
      const pm = r.playerMatch;
      console.log(`  [${r.stage.eventName} ${pm.match.label} BO${pm.result.bestOf}] ${pm.result.finalScore} ${pm.result.winnerId === teamId ? '晋级' : '被淘汰'}${pm.result.hadPeakShowdown ? ' ★巅峰对决' : ''}`);
    }
    if (r.finished) {
      console.log(`  ▶ ${r.stage.eventName} 冠军: ${short(r.championId)} | 我方名次: ${r.playerPlacement ?? '未参赛'}`);
    }
  } else if (r.type === 'regroup') {
    const d = Object.entries(r.groups).find(([, ids]) => ids.includes(teamId));
    console.log(`  [重组] 我方进入 ${d ? d[0] : '?'} 组  (S:${r.groups.S.map(short).join('/')} | A:${r.groups.A.map(short).join('/')} | B:${r.groups.B.map(short).join('/')})`);
  } else if (r.type === 'arena' && r.playerResult) {
    console.log(`  [年总擂台赛 D${r.day}] ${r.playerResult.finalScore} ${r.playerResult.winnerId === teamId ? '胜' : '负'}`);
  } else if (r.type === 'seasonEnd') {
    const s = r.summary;
    console.log(`\n── 第 ${s.season} 赛季结算 ──`);
    console.log(`  最终排名: 第 ${s.rank} 名 (${s.div} 组第 ${s.divRank})  ${s.champion ? '★ 夺冠' : ''}`);
    console.log(`  赛事名次: ${s.awards.map((a) => `${a.eventId}:${a.placement ? '第' + a.placement : '未参赛'}`).join('  ')}`);
    console.log(`  收入: ${JSON.stringify(s.income)}`);
    console.log(`  支出: ${JSON.stringify(s.expense)}`);
    console.log(`  净收支: ${s.net} 万  →  现金: ${s.cashAfter} 万  |  声望: ${s.fameAfter}`);
    const nx = beginNextSeason(game);
    if (nx.type === 'gameOver') {
      console.log(`\n═══ 生涯结束：${nx.gameOver.title} ═══\n${nx.gameOver.detail}`);
      carries = false;
    } else {
      seasonNo = nx.season;
      console.log(`\n═══ 进入第 ${seasonNo} 赛季（版本 ${game.stages ? '' : ''}）═══`);
    }
  } else if (r.type === 'gameOver') {
    console.log(`\n═══ 生涯结束：${r.gameOver.title} ═══\n${r.gameOver.detail}`);
    carries = false;
  }
}

console.log(`\n总推进步数: ${steps}`);
