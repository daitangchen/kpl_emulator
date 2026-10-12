/**
 * 商务运营 —— 用竞技状态换现金
 *
 * 设计意图：
 *  - 游戏里"花钱"的地方很多（转会、青训、特训），但**赚钱**几乎只能靠打比赛。
 *    这里补上主动创收的途径：跑商务、直播带货、录综艺、发运营视频。
 *  - 每一项都按"声望"定价（声望越高，品牌方给的钱越多），
 *    所以「发放运营视频涨粉 → 之后接更贵的商务」是一条正向链路。
 *  - 代价是**疲劳**：疲劳会实打实降低战力（每点 -0.2），
 *    每赛季有次数上限、疲劳也有上限，逼你权衡"这周是赚钱还是保状态"。
 *  - AI 战队不会做商务，所以这套系统只影响玩家自己，不破坏平衡基线。
 */
import { FATIGUE } from '../core/constants.js';

export const ACTIVITIES = [
  {
    id: 'short', name: '运营短视频', icon: '📱',
    cash: 45, fame: 1.2, fatigue: 3, morale: -1, cap: 6,
    desc: '拍几条短视频维持热度。来钱少，但涨粉最快，是后续接商务的地基。',
  },
  {
    id: 'stream', name: '直播带货', icon: '🎥',
    cash: 130, fame: 0.4, fatigue: 7, morale: -4, cap: 4,
    desc: '一场直播进账可观，代价是训练时间被挤占。',
  },
  {
    id: 'endorse', name: '商业代言', icon: '💼',
    cash: 210, fame: 0.8, fatigue: 5, morale: -3, cap: 3,
    desc: '一次大额进账，需要成绩与声望背书。',
  },
  {
    id: 'show', name: '综艺录制', icon: '🎬',
    cash: 280, fame: 1.6, fatigue: 11, morale: -7, cap: 2,
    desc: '来钱最快、涨粉最多，但对竞技状态的伤害也最大。',
  },
];

export const ACTIVITY_BY_ID = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));

/** 声望越高，同样的活动报价越高（声望 50 → 报价 ×2） */
export const fameMul = (game) => 1 + Math.max(0, game.fame || 0) / 50;

/** 某活动的实际报价（万元） */
export function activityCash(game, act) {
  return Math.round(act.cash * fameMul(game));
}

/** 本赛季已经把某项活动做了几次 */
export const businessUsed = (game, id) => (game.business?.[id]) || 0;

/** 本赛季商务总收入 */
export const businessIncome = (game) => game.flags?.businessIncome || 0;

/** 当前疲劳导致的战力惩罚（负数），用于界面展示 */
export function fatiguePenalty(game, teamId = game.userTeamId) {
  return -Math.round((game.fatigue?.[teamId] || 0) * FATIGUE.perPower * 10) / 10;
}

/** 还能不能做某项活动 */
export function canDoBusiness(game, id) {
  const act = ACTIVITY_BY_ID[id];
  if (!act) return { ok: false, reason: '未知的商务活动' };
  const used = businessUsed(game, id);
  if (used >= act.cap) return { ok: false, reason: `${act.name} 本赛季已达 ${act.cap} 次上限` };
  const fat = game.fatigue?.[game.userTeamId] || 0;
  if (fat + act.fatigue > FATIGUE.cap) {
    return { ok: false, reason: `疲劳过高（${fat}/${FATIGUE.cap}），先让队伍歇一歇` };
  }
  return { ok: true };
}

/**
 * 接一项商务活动
 * @returns {{ok:boolean, cash?:number, reason?:string, activity?:object, fatigue?:number, fame?:number, morale?:number}}
 */
export function doBusiness(game, id) {
  const gate = canDoBusiness(game, id);
  if (!gate.ok) return gate;
  const act = ACTIVITY_BY_ID[id];
  const pid = game.userTeamId;
  const cash = activityCash(game, act);

  game.cash += cash;
  game.flags.businessIncome = (game.flags.businessIncome || 0) + cash;
  game.fame = Math.min(100, Math.round((game.fame + act.fame) * 10) / 10);
  game.morale[pid] = Math.max(10, (game.morale[pid] ?? 70) + act.morale);
  game.fatigue[pid] = Math.min(FATIGUE.cap, (game.fatigue?.[pid] || 0) + act.fatigue);
  game.business = game.business || {};
  game.business[id] = businessUsed(game, id) + 1;

  return {
    ok: true,
    activity: act,
    cash,
    fatigue: game.fatigue[pid],
    fame: game.fame,
    morale: game.morale[pid],
  };
}

/** 每个比赛日自然恢复一点疲劳（写回 game.fatigue） */
export function recoverFatigue(game) {
  if (!game.fatigue) return;
  for (const tid of Object.keys(game.fatigue)) {
    game.fatigue[tid] = Math.max(0, game.fatigue[tid] - FATIGUE.recoverPerDay);
  }
}

/** 本赛季还剩多少次商务机会 */
export function remainingBusiness(game) {
  return ACTIVITIES.reduce((s, a) => s + Math.max(0, a.cap - businessUsed(game, a.id)), 0);
}
