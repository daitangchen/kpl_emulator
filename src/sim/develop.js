/**
 * 球员成长与老化
 * 每个赛季结束时统一结算一次：年轻球员涨球、老将下滑、合同年限递减。
 * 目的：让四个赛季里阵容会自然老化，逼玩家做转会决策。
 * 性格会放大或抑制成长速度，成长历史用于推断"成长弧"。
 */
import { assignTrait, traitGrowthMul, arcOf } from './story.js';

const ROLE_KEYS = ['laning', 'macro', 'teamfight', 'champPool'];

/** 年龄成长系数：正数涨、负数跌 */
function ageCurve(age) {
  if (age <= 18) return { growth: 5.2, decline: 0 };
  if (age === 19) return { growth: 4.4, decline: 0 };
  if (age === 20) return { growth: 3.6, decline: 0 };
  if (age === 21) return { growth: 2.8, decline: 0 };
  if (age === 22) return { growth: 2.0, decline: 0 };
  if (age === 23) return { growth: 1.2, decline: 0 };
  if (age === 24) return { growth: 0.5, decline: 0.3 };
  if (age === 25) return { growth: 0, decline: 0.9 };
  if (age === 26) return { growth: 0, decline: 1.6 };
  if (age === 27) return { growth: 0, decline: 2.4 };
  if (age === 28) return { growth: 0, decline: 3.2 };
  if (age === 29) return { growth: 0, decline: 4.0 };
  return { growth: 0, decline: 5.0 };
}

/** 潜力空间：离潜力上限越近涨得越慢 */
function potentialRoom(player) {
  const room = Math.max(0, player.potential - player.overall);
  return Math.min(1, room / 12);
}

/** 计算某球员一季的成长量（不修改原对象） */
export function seasonDelta(player) {
  const { growth, decline } = ageCurve(player.age);
  const room = potentialRoom(player);
  // 涨球按潜力空间打折；老将下滑由"意识/英雄池"承担小部分（经验续命）
  const gain = growth * (0.45 + 0.55 * room);
  const loss = decline * (1 - 0.35 * room);
  return { gain: Number(gain.toFixed(2)), loss: Number(loss.toFixed(2)) };
}

/** 对一名球员施加一季成长，返回变化摘要 */
export function developPlayer(player, rng, meta = null, season = null) {
  assignTrait(player);
  const before = player.overall;
  const { gain: rawGain, loss } = seasonDelta(player);
  const gain = rawGain * traitGrowthMul(player);   // 性格影响成长速度
  const noise = () => (rng.chance(0.5) ? 1 : -1) * rng.range(0, 0.7);
  const next = {};
  for (const k of ROLE_KEYS) {
    let v = player[k];
    // 操作最先衰退，意识与英雄池最晚
    const weight = k === 'laning' ? 1.25 : k === 'teamfight' ? 1.0 : k === 'macro' ? 0.75 : 0.6;
    v += gain * weight + noise();
    v -= loss * weight;
    next[k] = Math.max(35, Math.min(99, Math.round(v)));
  }
  Object.assign(player, next);
  player.age += 1;
  player.contractYears = Math.max(0, (player.contractYears ?? 1) - 1);
  recomputeOverall(player);
  // 身价随年龄与实力重估；年薪不随能力自动浮动（只有续约/转会时才重谈），
  // 否则每年用 expectedWage 覆盖会把"合同"这层经营意义抹掉，也会让薪资总额失控。
  player.value = marketValue(player);
  // 记录成长历史：用于界面画出迷你成长曲线、推断"成长弧"
  if (season != null) {
    if (!Array.isArray(player.history) || !player.history.length) {
      player.history = [{ s: season - 1, o: before }];
    }
    player.history.push({ s: season, o: player.overall });
    if (player.history.length > 8) player.history = player.history.slice(-8);
  }
  return {
    id: player.id, name: player.name, from: before, to: player.overall,
    age: player.age, trait: player.trait, arc: arcOf(player),
  };
}

const ROLE_W = {
  top: { laning: 0.42, macro: 0.16, teamfight: 0.30, champPool: 0.12 },
  jungle: { laning: 0.22, macro: 0.36, teamfight: 0.28, champPool: 0.14 },
  mid: { laning: 0.32, macro: 0.30, teamfight: 0.22, champPool: 0.16 },
  adc: { laning: 0.38, macro: 0.12, teamfight: 0.26, champPool: 0.24 },
  support: { laning: 0.14, macro: 0.40, teamfight: 0.36, champPool: 0.10 },
};

export function recomputeOverall(player) {
  const w = ROLE_W[player.role];
  player.overall = Math.round(
    player.laning * w.laning + player.macro * w.macro
    + player.teamfight * w.teamfight + player.champPool * w.champPool,
  );
}

/** 市场身价：实力 × 年龄溢价（越年轻越贵） */
export function marketValue(player) {
  const base = Math.pow(Math.max(0, player.overall - 45), 1.9) * 0.55;
  const ageFactor = player.age <= 19 ? 1.7 : player.age <= 21 ? 1.45
    : player.age <= 23 ? 1.15 : player.age <= 25 ? 0.92 : player.age <= 27 ? 0.62 : 0.38;
  const potBonus = 1 + Math.min(0.5, Math.max(0, player.potential - player.overall) / 40);
  return Math.max(30, Math.round(base * ageFactor * potBonus));
}

/** 期望年薪：与身价挂钩，老将便宜但下滑快 */
export function expectedWage(player) {
  const base = player.value * 0.62;
  const ageFactor = player.age <= 21 ? 0.85 : player.age >= 27 ? 0.95 : 1;
  return Math.max(60, Math.round(base * ageFactor));
}

/** 全联盟球员结算：年龄 +1、涨跌、身价重估 */
export function developAll(game, rng) {
  const reports = [];
  for (const player of Object.values(game.players)) {
    const r = developPlayer(player, rng, null, game.season);
    if (r.to !== r.from) reports.push(r);
  }
  reports.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  return reports;
}

/** 青训候选名（虚构新人，避免与真实选手混淆） */
export const PROSPECT_NAMES = [
  '小火', '青禾', '半夏', '小野', '阿岩', '白鹿', '长安', '风起', '小满', '知秋',
  '拾光', '小北', '沉舟', '孤城', '苍术', '青枫', '砚台', '小柒', '夜阑', '拾贰',
  '踏雪', '寻梅', '折枝', '暮成', '青崖', '照野', '既白', '听风', '临江', '远山',
];

/** 生成一名青训新人（用于青训营抽卡与每年新秀补充） */
export function generateProspect(rng, teamId, quality = 'normal') {
  const roles = ['top', 'jungle', 'mid', 'adc', 'support'];
  const role = rng.pick(roles);
  const base = quality === 'elite' ? 72 : quality === 'good' ? 68 : 63;
  const spread = () => Math.round(rng.range(-4, 5));
  const p = {
    id: `youth_${teamId}_${Math.floor(rng.next() * 1e9).toString(36)}`,
    name: rng.pick(PROSPECT_NAMES),
    realName: '',
    role,
    teamId,
    age: rng.int(17, 19),
    laning: base + spread(),
    macro: base + spread() - 2,
    teamfight: base + spread(),
    champPool: base + spread() - 3,
    potential: Math.round(rng.range(78, quality === 'elite' ? 94 : 88)),
    tags: ['青训'],
    contractYears: 3,
  };
  recomputeOverall(p);
  p.value = marketValue(p);
  p.wage = Math.round(expectedWage(p) * 0.45);
  assignTrait(p);   // 青训新人同样有性格（潜力可能被"天才少年"再次抬高）
  p.history = [{ s: 0, o: p.overall }];
  return p;
}
