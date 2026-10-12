/**
 * 资金决策：球员特训与团队投入
 *
 * 设计意图 —— 让"钱"变成每一轮都要面对的选择，而不是赛季末才看一次的数字。
 *  - 玩家可以花钱给首发球员的四项属性（操作 / 意识 / 团战 / 英雄池）各 +1
 *  - 也可以投入团队项：士气 / 默契
 *  - 成本随「该属性已投入次数」「该球员本赛季总投入」「球员水平」递增
 *  - 有赛季上限，避免一个赛季把钱砸成碾压
 *
 * 平衡说明：训练只影响"玩家自己掏钱的球员"，AI 不会用，
 * 因此批量校准（calibrate.mjs）的基线不受影响；人类玩家用钱换战力，是刻意的取舍。
 */
import { recomputeOverall, marketValue } from './develop.js';
import { FATIGUE } from '../core/constants.js';

export const ATTRS = [
  { key: 'laning', name: '操作', desc: '对线压制与个人能力' },
  { key: 'macro', name: '意识', desc: '运营、节奏与决策' },
  { key: 'teamfight', name: '团战', desc: '团战定位与走位输出' },
  { key: 'champPool', name: '英雄池', desc: '英雄熟练度与 BP 价值' },
];

export const ATTR_BY_KEY = Object.fromEntries(ATTRS.map((a) => [a.key, a]));

/** 每名球员、每项属性、每赛季最多 +6；每名球员每赛季总上限 +16 */
export const SEASON_CAP_PER_ATTR = 6;
export const SEASON_CAP_TOTAL = 16;
/** 团队项每赛季各最多 5 次 */
export const TEAM_CAP = 5;

/** 中场（系列赛两段之间）的临场布置报价与收益 */
export const SERIES_ADJUST = { boostCost: 90, boostGain: 2.5 };

export const TEAM_PLANS = {
  morale: { key: 'morale', name: '团队士气', gain: 4, base: 90, max: 100, desc: '提升全队士气，直接加战力' },
  chem: { key: 'chem', name: '团队默契', gain: 4, base: 120, max: 100, desc: '提升队内默契，长期收益更稳' },
  recover: { key: 'recover', name: '体能恢复', gain: 12, base: 110, max: FATIGUE.cap, desc: '安排理疗与休整，把跑商务积累的疲劳养回来' },
};

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function trainRec(game, playerId) {
  game.training = game.training || {};
  const rec = game.training[playerId] || { total: 0 };
  game.training[playerId] = rec;
  return rec;
}

/** 单项属性再训一次的报价（万元）。可传入 preview 记录模拟"连练多次"后的累计报价。 */
export function attrCost(game, player, attr, preview) {
  const rec = preview || game.training?.[player.id];
  const used = num(rec?.[attr]);
  const total = num(rec?.total);
  const base = 20 + Math.round(num(player.overall, 70) * 0.45);
  return Math.round(base * (1 + 0.4 * used) * (1 + 0.06 * total));
}

/** 团队项再投入一次的报价（万元） */
export function teamCost(game, kind) {
  const used = num(game.trainingTeam?.[kind]);
  const plan = TEAM_PLANS[kind];
  return Math.round(plan.base * (1 + 0.6 * used));
}

/** 该球员本赛季还能训多少（用于界面展示） */
export function remainingFor(game, playerId) {
  const rec = game.training?.[playerId] || {};
  const total = num(rec.total);
  return { total: Math.max(0, SEASON_CAP_TOTAL - total), perAttr: SEASON_CAP_PER_ATTR };
}

/** 花资金给某球员的某项属性 +1 */
export function trainAttr(game, playerId, attr) {
  const p = game.players[playerId];
  if (!p) return { ok: false, reason: '球员不存在' };
  if (!ATTR_BY_KEY[attr]) return { ok: false, reason: '未知属性' };
  const rec = trainRec(game, playerId);
  const used = num(rec[attr]);
  if (used >= SEASON_CAP_PER_ATTR) {
    return { ok: false, reason: `${ATTR_BY_KEY[attr].name} 本赛季已达上限 +${SEASON_CAP_PER_ATTR}` };
  }
  if (num(rec.total) >= SEASON_CAP_TOTAL) {
    return { ok: false, reason: `该球员本赛季训练总额已达上限 +${SEASON_CAP_TOTAL}` };
  }
  if (num(p[attr]) >= 99) return { ok: false, reason: '该属性已达 99 上限' };

  const cost = attrCost(game, p, attr);
  if (game.cash < cost) return { ok: false, reason: `现金不足：需要 ${cost} 万，目前 ${Math.round(game.cash)} 万` };

  game.cash -= cost;
  p[attr] = Math.min(99, num(p[attr]) + 1);
  rec[attr] = used + 1;
  rec.total = num(rec.total) + 1;
  recomputeOverall(p);
  p.value = marketValue(p);          // 能力提升会推高身价；年薪按合同不变
  game.flags.trainingSpend = num(game.flags.trainingSpend) + cost;

  return { ok: true, cost, attr, attrName: ATTR_BY_KEY[attr].name, value: p[attr], overall: p.overall, player: p };
}

/**
 * 一键训练：把该球员**所有还能练的属性**各 +1
 * 花的是"四项单独练"的总价（不加价，纯粹省点击）；受同样的赛季上限与现金约束。
 * @returns {{ok:boolean, cost?:number, gains?:Array<{attr:string,name:string,from:number,to:number}>, reason?:string}}
 */
export function trainAllAttrs(game, playerId) {
  const p = game.players[playerId];
  if (!p) return { ok: false, reason: '球员不存在' };
  const rec = game.training?.[playerId] || {};

  const plan = [];
  for (const a of ATTRS) {
    const used = num(rec[a.key]);
    if (used >= SEASON_CAP_PER_ATTR) continue;          // 单项满
    if (num(rec.total) + plan.length >= SEASON_CAP_TOTAL) break; // 球员总额满
    if (num(p[a.key]) >= 99) continue;                   // 属性到顶
    plan.push(a);
  }
  if (!plan.length) return { ok: false, reason: '该球员本赛季已无可训练的项目' };

  // 报价要按"依次练习"累加，因为每练一次都会抬高后续单价
  const preview = { ...rec };
  let total = 0;
  const costs = [];
  for (const a of plan) {
    const c = attrCost(game, p, a.key, preview);
    costs.push(c);
    total += c;
    preview[a.key] = num(preview[a.key]) + 1;
    preview.total = num(preview.total) + 1;
  }
  if (game.cash < total) {
    return { ok: false, reason: `现金不足：一键训练需要 ${total} 万，目前 ${Math.round(game.cash)} 万` };
  }

  game.cash -= total;
  const gains = [];
  for (let i = 0; i < plan.length; i += 1) {
    const a = plan[i];
    const from = num(p[a.key]);
    p[a.key] = Math.min(99, from + 1);
    gains.push({ attr: a.key, name: a.name, from, to: p[a.key] });
  }
  const r2 = trainRec(game, playerId);
  for (const a of plan) r2[a.key] = num(r2[a.key]) + 1;
  r2.total = num(r2.total) + plan.length;

  recomputeOverall(p);
  p.value = marketValue(p);
  game.flags.trainingSpend = num(game.flags.trainingSpend) + total;

  return { ok: true, cost: total, gains, overall: p.overall, player: p };
}

/** 团队项投入（士气 / 默契 / 体能恢复） */
export function trainTeam(game, kind) {
  const plan = TEAM_PLANS[kind];
  if (!plan) return { ok: false, reason: '未知投入项' };
  const pid = game.userTeamId;
  game.trainingTeam = game.trainingTeam || {};
  const used = num(game.trainingTeam[kind]);
  if (used >= TEAM_CAP) return { ok: false, reason: `${plan.name} 本赛季投入已达 ${TEAM_CAP} 次上限` };
  const cost = teamCost(game, kind);
  if (game.cash < cost) return { ok: false, reason: `现金不足：需要 ${cost} 万，目前 ${Math.round(game.cash)} 万` };

  // 体能恢复：把疲劳降下来（跑商务留下的代价可以花钱养回来）
  if (kind === 'recover') {
    const fat = num(game.fatigue?.[pid]);
    if (fat <= 0) return { ok: false, reason: '球队没有疲劳，不需要恢复' };
    game.cash -= cost;
    game.fatigue[pid] = Math.max(0, fat - plan.gain);
    game.trainingTeam[kind] = used + 1;
    game.flags.trainingSpend = num(game.flags.trainingSpend) + cost;
    return { ok: true, cost, kind, gain: plan.gain, value: game.fatigue[pid] };
  }

  const cur = num(game[kind === 'morale' ? 'morale' : 'chemistry'][pid], 70);
  if (cur >= plan.max) return { ok: false, reason: `${plan.name} 已满` };

  game.cash -= cost;
  const target = kind === 'morale' ? game.morale : game.chemistry;
  target[pid] = Math.min(plan.max, cur + plan.gain);
  game.trainingTeam[kind] = used + 1;
  game.flags.trainingSpend = num(game.flags.trainingSpend) + cost;

  return { ok: true, cost, kind, gain: plan.gain, value: target[pid] };
}

/** 一键推荐：给"最弱的首发"补最短板（用于赛果页的快捷资金决策） */
export function recommendTrain(game) {
  const pid = game.userTeamId;
  const sq = game.squads[pid];
  const starters = (sq?.starters || []).map((id) => game.players[id]).filter(Boolean);
  if (!starters.length) return null;
  let target = null;
  let worst = null;
  for (const p of starters) {
    for (const a of ATTRS) {
      const v = num(p[a.key]);
      if (worst === null || v < worst) { worst = v; target = { player: p, attr: a }; }
    }
  }
  if (!target) return null;
  return { playerId: target.player.id, playerName: target.player.name, attr: target.attr.key, attrName: target.attr.name, cost: attrCost(game, target.player, target.attr.key) };
}

/** 本赛季训练总投入 */
export const seasonTrainingSpend = (game) => num(game.flags?.trainingSpend);
