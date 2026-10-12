/**
 * 界面事件层：把引擎返回值翻译成界面要展示的"事件"
 * 关键规则（用户要求）：
 *   BO5 → 一次出最终比分
 *   BO7 → 第 1 段先出前三局；无巅峰对决直接出最终比分；3-3 则进入 BO7 巅峰对决
 *   BO9 决赛 → 分段推进，第 9 局为巅峰对决
 */
import { FINANCE, ANNUAL_POINTS, FAILURE_RULES } from '../core/constants.js';

/** 把引擎结果 → 展示事件 */
export function eventsFromResult(game, r, stage) {
  const pid = game.userTeamId;
  const out = [];

  if (r.type === 'matchday') {
    out.push({
      kind: 'matchday',
      stageName: stage.eventName,
      roundName: stage.roundName,
      roundIndex: stage.roundIndex,
      day: r.day,
      totalDays: r.totalDays,
      results: r.results,
      groups: r.groups,
      tables: r.tables,
      eliminated: r.eliminated,
      playerResult: r.playerResult,
      finished: r.finished,
    });
  } else if (r.type === 'eliminatedEarly') {
    out.push({ kind: 'info', tone: 'danger', title: '赛季提前结束', text: r.message, eliminated: r.eliminated });
  } else if (r.type === 'regroup') {
    out.push({ kind: 'regroup', groups: r.groups, tables: r.tables });
  } else if (r.type === 'card') {
    const mine = r.playerCard;
    out.push({
      kind: 'card',
      cards: r.cards,
      groups: r.groups,
      playerCard: mine,
      ranked: r.ranked || null,
      chunks: r.chunks || null,
      adjustment: r.adjustment || null,
      lineup: r.lineup || null,
      tone: mine ? (mine.winnerId === pid ? 'good' : 'bad') : 'neutral',
    });
  } else if (r.type === 'bracket') {
    out.push({
      kind: 'bracket',
      stageName: stage.eventName,
      label: stage.label,
      bracket: r.bracket,
      day: r.day,
      matches: r.matches,
      playerMatch: r.playerMatch,
      finished: r.finished,
      championId: r.championId,
      playerPlacement: r.playerPlacement,
      chunks: r.chunks || null,          // 分段推进的每段结果（下半场 / 巅峰对决）
      adjustment: r.adjustment || null,  // 中场调整摘要
      lineup: r.lineup || null,          // 巅峰对决的阵容博弈结果
    });
  } else if (r.type === 'seriesPause') {
    out.push({
      kind: 'seriesPause',
      phase: r.phase || 'half',        // half = 中场调整；lineup = 巅峰对决前的阵容博弈
      stageName: stage.eventName,
      label: stage.label,
      day: r.day,
      match: r.match,
      series: r.series,
      first: r.first,
      chunks: r.chunks || null,
      adjustment: r.adjustment || null,
      otherMatches: r.otherMatches || [],
    });
  } else if (r.type === 'arena') {
    out.push({
      kind: 'arena',
      day: r.day,
      results: r.results || [],
      playerResult: r.playerResult,
      finished: r.finished,
      stage,
    });
  } else if (r.type === 'survival') {
    out.push({ kind: 'survival', results: r.results, playerResult: r.playerResult });
  } else if (r.type === 'seasonEnd') {
    out.push({ kind: 'seasonEnd', summary: r.summary });
  } else if (r.type === 'gameOver') {
    out.push({ kind: 'gameOver', gameOver: r.gameOver });
  }
  // 突发事件卡片挂在任何结果之后
  if (r.eventCard) out.push({ kind: 'eventCard', card: r.eventCard });
  return out;
}

/** 新赛季 / 下一年 */
export function newSeasonEvent(season) {
  return { kind: 'newSeason', season };
}

/** 财务红字警告 */
export function cashWarning(game) {
  if (game.cash < 0) {
    return {
      kind: 'info',
      tone: 'danger',
      title: '资金危机',
      text: `俱乐部现金已为负（${Math.round(game.cash)} 万）。连续两个赛季为负将被联盟接管，强制结束生涯。`,
    };
  }
  if (game.cash < 300) {
    return {
      kind: 'info',
      tone: 'warn',
      title: '资金吃紧',
      text: `现金仅剩 ${Math.round(game.cash)} 万，距离"欠薪"只差一步。考虑卖人、砍青训预算或压低工资。`,
    };
  }
  return null;
}

/** 董事会通牒：排名靠后时提示 */
export function boardWarning(game, rank) {
  if (rank >= FAILURE_RULES.bottomThreshold) {
    return {
      kind: 'info',
      tone: 'warn',
      title: '董事会警告',
      text: `目前联赛排名第 ${rank}，处于倒数三。连续两个赛季如此，你将被解雇。`,
    };
  }
  return null;
}

export const fmtMoney = (n) => `${Math.round(n)} 万`;
export const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
