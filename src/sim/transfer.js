/**
 * 转会市场与青训营
 *
 * 设计原则
 *  - 买入要付"转会费"，费用在赛季结算时从现金里扣，所以钱必须在赛季前留出来
 *  - 卖出立刻回血（转会费按 85% 到账），但会削弱阵容
 *  - 工资帽软约束：全队年薪不能超过当季预估收入的 1.35 倍，超了就不给签
 *  - 其他战队会主动报价你的人（尤其你战绩好、球员年轻的时候）
 */
import { marketValue, expectedWage, recomputeOverall, generateProspect } from './develop.js';
import { traitWageMul, traitTransferRisk, traitMoraleFragile, pickQuote } from './story.js';
import { ROLE_ORDER } from '../data/players.js';
import { TEAMS } from '../data/teams.js';
import { FINANCE, leagueShareForRank, contractWage } from '../core/constants.js';

export const WAGE_CAP_RATIO = 1.35;

/** 某队档位下的实际签约年薪（与建档时的薪资缩放口径一致）；性格会影响球员的薪资诉求 */
export function wageForTeam(playerValue, teamId, player = null) {
  const tier = TEAMS.find((t) => t.id === teamId)?.tier || 'A';
  const base = contractWage(playerValue, tier);
  const mul = player ? traitWageMul(player) : 1;
  return Math.max(50, Math.round(base * mul));
}

/** 当季预估固定收入（用于工资帽）。用"预期排名"取一个中性分成，避免工资帽随战绩剧烈波动。 */
export function projectedIncome(game) {
  const fame = game.fame ?? 30;
  const rank = game.lastRank || 12;
  return leagueShareForRank(rank)
    + Math.round(FINANCE.sponsorBase + fame * FINANCE.sponsorPerFame)
    + Math.round(FINANCE.ticketBase * (1 + fame / 100))
    + Math.round(FINANCE.merchBase * (1 + fame / 60));
}

export function wageCap(game) {
  return Math.round(projectedIncome(game) * WAGE_CAP_RATIO);
}

export function teamWageBill(game, teamId) {
  const sq = game.squads[teamId] || {};
  return (sq.starters || []).concat(sq.bench || [], sq.youth || [])
    .reduce((s, id) => s + (game.players[id]?.wage || 0), 0);
}

/** 某队某个位置是否缺人（缺 = 能给出报价） */
export function neediestRoles(game, teamId) {
  const sq = game.squads[teamId] || { starters: [] };
  const have = {};
  for (const id of sq.starters || []) {
    const p = game.players[id];
    if (p) have[p.role] = p;
  }
  const missing = ROLE_ORDER.filter((r) => !have[r]);
  if (missing.length) return missing;
  // 没有空缺时，找最弱的位置（低于全队均值 4 分以上）
  const avg = (sq.starters || []).reduce((s, id) => s + (game.players[id]?.overall || 0), 0) / Math.max(1, (sq.starters || []).length);
  return ROLE_ORDER.filter((r) => (have[r]?.overall || 0) < avg - 4);
}

/** 生成本赛季其他战队对你队球员的报价 */
export function buildOffers(game, rng, count = 3) {
  const pid = game.userTeamId;
  const sq = game.squads[pid];
  const mine = (sq.starters || []).concat(sq.bench || [])
    .map((id) => game.players[id])
    .filter(Boolean)
    // 越强、越年轻越容易被挖
    .filter((p) => p.overall >= 70 || p.potential >= 82);
  if (!mine.length) return [];

  const buyers = Object.keys(game.teams).filter((id) => id !== pid);
  const offers = [];
  const used = new Set();
  for (let i = 0; i < count; i += 1) {
    const buyerId = rng.pick(buyers.filter((b) => !used.has(b)));
    if (!buyerId) break;
    used.add(buyerId);
    const needs = neediestRoles(game, buyerId);
    const pool = mine.filter((p) => !offers.some((o) => o.playerId === p.id));
    if (!pool.length) break;
    // 越有"野心"的球员越容易被盯上（转会风险高）
    const ranked = pool.slice().sort((a, b) => traitTransferRisk(b) - traitTransferRisk(a));
    const target = (needs.length ? ranked.filter((p) => needs.includes(p.role)) : ranked)[0] || rng.pick(pool);
    const buyerBudget = game.teams[buyerId].budget + (game.cashRich?.[buyerId] || 0);
    const value = target.value;
    // 报价在 0.85 ~ 1.25 倍身价之间，买不起就压价
    const mul = rng.range(0.85, 1.25);
    let fee = Math.round(value * mul);
    let aggressive = true;
    if (fee > buyerBudget * 0.6) {
      fee = Math.round(buyerBudget * 0.55);
      aggressive = false;
    }
    if (fee < 60) continue;
    // 玩家战绩越好，球员越不愿意走
    const rank = game.lastRank || 10;
    const resist = rank <= 6 ? 0.25 : rank <= 12 ? 0.1 : 0;
    offers.push({
      id: `offer_${i}_${buyerId}`,
      buyerId,
      playerId: target.id,
      playerName: target.name,
      role: target.role,
      overall: target.overall,
      age: target.age,
      potential: target.potential,
      fee,
      aggressive,
      /** 拒绝的后果：球员士气下降 */
      rejectMorale: -3 - Math.round(rng.range(0, 4) * (aggressive ? 1.4 : 0.6)),
      /** 接受的后果：本队声望小幅提升（卖人给强队） */
      acceptFame: aggressive ? 1 : 0,
    });
  }
  return offers;
}

/** 生成挂牌市场：其他队伍可买的球员 */
export function buildListings(game, rng, count = 14) {
  const pid = game.userTeamId;
  const candidates = [];
  for (const teamId of Object.keys(game.teams)) {
    if (teamId === pid) continue;
    const sq = game.squads[teamId];
    const all = (sq.starters || []).concat(sq.bench || [], sq.youth || [])
      .map((id) => game.players[id])
      .filter(Boolean);
    if (all.length <= 6) continue; // 人手不够就不卖
    // 每队最多挂 2 人：优先挂"实力尚可但位置重叠"或"老将/青训"
    const byRoleCount = {};
    const pool = [];
    for (const p of all) {
      byRoleCount[p.role] = (byRoleCount[p.role] || 0) + 1;
    }
    for (const p of all) {
      const surplus = byRoleCount[p.role] > 1;
      const isStarter = (sq.starters || []).includes(p.id);
      if (isStarter && !surplus && p.age < 27) continue;   // 核心不卖
      if (!isStarter) pool.push(p);
      else if (surplus && p.age >= 24) pool.push(p);
    }
    for (const p of rng.shuffle(pool).slice(0, 2)) {
      candidates.push({
        playerId: p.id,
        sellerId: teamId,
        role: p.role,
        overall: p.overall,
        potential: p.potential,
        age: p.age,
        wage: p.wage,
        value: p.value,
        price: Math.round(p.value * rng.range(1.0, 1.4)),
      });
    }
  }
  // 按实力排序，混入少量高位球员让市场有看点
  candidates.sort((a, b) => b.overall - a.overall);
  const top = candidates.slice(0, Math.ceil(count * 0.35));
  const rest = rng.shuffle(candidates.slice(Math.ceil(count * 0.35)));
  return rng.shuffle(top.concat(rest.slice(0, count - top.length)));
}

/** 执行买入。返回 {ok, reason} */
export function signPlayer(game, listing, { replacePlayerId = null } = {}) {
  const pid = game.userTeamId;
  const player = game.players[listing.playerId];
  if (!player) return { ok: false, reason: '球员不存在' };

  const bill = teamWageBill(game, pid);
  const newWage = wageForTeam(player.value, pid, player);
  const cap = wageCap(game);
  if (bill + newWage > cap) {
    return {
      ok: false,
      reason: `工资帽不足：全队年薪 ${bill} + ${newWage} 会超过上限 ${cap} 万（预估收入的 ${WAGE_CAP_RATIO} 倍）`,
    };
  }
  if (game.cash < listing.price) {
    return { ok: false, reason: `现金不足：需要 ${listing.price} 万，目前 ${Math.round(game.cash)} 万` };
  }

  // 从原队移除
  const seller = game.squads[listing.sellerId];
  for (const k of ['starters', 'bench', 'youth']) {
    seller[k] = (seller[k] || []).filter((id) => id !== listing.playerId);
  }

  // 进入我方：放到替补席，由玩家在阵容里调整
  const mine = game.squads[pid];
  let replaced = null;
  if (replacePlayerId) {
    replaced = game.players[replacePlayerId];
    for (const k of ['starters', 'bench', 'youth']) {
      mine[k] = (mine[k] || []).filter((id) => id !== replacePlayerId);
    }
    // 被替换的人如果还有位置需求，自动补进首发同位置
    const needRole = player.role;
    const idx = (mine.starters || []).findIndex((id) => game.players[id]?.role === needRole);
    if (idx >= 0) mine.starters[idx] = listing.playerId;
    else mine.bench.push(listing.playerId);
  } else {
    mine.bench.push(listing.playerId);
    // 空位自动首发
    const rolesInStarters = (mine.starters || []).map((id) => game.players[id]?.role);
    if (!rolesInStarters.includes(player.role)) mine.starters.push(listing.playerId);
  }

  player.teamId = pid;
  player.wage = newWage;
  player.contractYears = 3;
  player.value = marketValue(player);
  recomputeOverall(player);

  // 费用在赛季结算时统一扣除
  game.flags.pendingTransferCost = (game.flags.pendingTransferCost || 0) + listing.price;
  game.transferLog = game.transferLog || [];
  game.transferLog.push({
    season: game.season, type: 'buy', playerId: player.id, playerName: player.name,
    from: listing.sellerId, to: pid, fee: listing.price,
  });
  if (replaced) {
    // 被换下的人自动挂牌回市场（简化处理：直接给其他队，回收 70%）
    const back = Math.round(replaced.value * 0.7);
    const buyer = pickBuyerFor(game, replaced);
    if (buyer) {
      replaced.teamId = buyer;
      for (const k of ['starters', 'bench', 'youth']) game.squads[buyer][k] = game.squads[buyer][k] || [];
      game.squads[buyer].bench.push(replaced.id);
      game.flags.pendingTransferIncome = (game.flags.pendingTransferIncome || 0) + back;
      game.transferLog.push({
        season: game.season, type: 'sell', playerId: replaced.id, playerName: replaced.name,
        from: pid, to: buyer, fee: back,
      });
    }
  }
  return { ok: true, player, replaced, quote: pickQuote(player, 'sign', `s${game.season}`) };
}

function pickBuyerFor(game, player) {
  const pid = game.userTeamId;
  for (const teamId of Object.keys(game.teams)) {
    if (teamId === pid) continue;
    if (neediestRoles(game, teamId).includes(player.role)) return teamId;
  }
  return Object.keys(game.teams).find((t) => t !== pid) || null;
}

/** 接受别队对你球员的报价 */
export function acceptOffer(game, offer) {
  const pid = game.userTeamId;
  const player = game.players[offer.playerId];
  if (!player) return { ok: false, reason: '球员不存在' };
  const fee = Math.round(offer.fee * 0.85); // 中介与税费
  for (const k of ['starters', 'bench', 'youth']) {
    game.squads[pid][k] = (game.squads[pid][k] || []).filter((id) => id !== offer.playerId);
  }
  const buyer = game.squads[offer.buyerId];
  player.teamId = offer.buyerId;
  buyer.bench.push(offer.playerId);
  // 若买家缺这个位置则直接首发
  const rolesInStarters = (buyer.starters || []).map((id) => game.players[id]?.role);
  if (!rolesInStarters.includes(player.role)) {
    buyer.starters.push(offer.playerId);
    buyer.bench = buyer.bench.filter((id) => id !== offer.playerId);
  }
  game.flags.pendingTransferIncome = (game.flags.pendingTransferIncome || 0) + fee;
  game.fame = Math.min(100, game.fame + (offer.acceptFame || 0));
  game.transferLog = game.transferLog || [];
  game.transferLog.push({
    season: game.season, type: 'sell', playerId: player.id, playerName: player.name,
    from: pid, to: offer.buyerId, fee,
  });
  // 卖核心会掉士气
  game.morale[pid] = Math.max(20, (game.morale[pid] ?? 70) - 5);
  return { ok: true, fee };
}

/** 拒绝报价 */
export function rejectOffer(game, offer) {
  const pid = game.userTeamId;
  const player = game.players[offer.playerId];
  // 情绪脆弱的球员（如刺头）被强留时反应更大
  const mul = player && traitMoraleFragile(player) ? 1.6 : 1;
  const delta = Math.round((offer.rejectMorale || -3) * mul);
  game.morale[pid] = Math.max(20, (game.morale[pid] ?? 70) + delta);
  game.flags.rejectedOffers = (game.flags.rejectedOffers || 0) + 1;
  return { ok: true, moraleDelta: delta };
}

/** 青训营：花钱抽一名新人，投入越高天赋越好 */
export function investYouth(game, rng, tierIndex = 1) {
  const pid = game.userTeamId;
  const cost = FINANCE.youthTiers[tierIndex] ?? FINANCE.youthTiers[1];
  if (game.cash < cost) return { ok: false, reason: `现金不足：需要 ${cost} 万` };
  const quality = tierIndex === 0 ? 'normal' : tierIndex === 1
    ? (rng.chance(0.25) ? 'good' : 'normal')
    : (rng.chance(0.35) ? 'elite' : 'good');
  const p = generateProspect(rng, pid, quality);
  game.players[p.id] = p;
  game.squads[pid].youth = game.squads[pid].youth || [];
  game.squads[pid].youth.push(p.id);
  game.flags.youthInvest = (game.flags.youthInvest || 0) + cost;
  game.transferLog = game.transferLog || [];
  game.transferLog.push({
    season: game.season, type: 'youth', playerId: p.id, playerName: p.name, to: pid, fee: cost,
  });
  return { ok: true, player: p, cost };
}

/** 调整首发（从替补/青训里换人） */
export function setStarter(game, inPlayerId, outPlayerId) {
  const pid = game.userTeamId;
  const sq = game.squads[pid];
  const inP = game.players[inPlayerId];
  if (!inP) return { ok: false, reason: '球员不存在' };
  const idx = sq.starters.indexOf(outPlayerId);
  if (idx < 0) return { ok: false, reason: '被换下的球员不在首发' };
  const outP = game.players[outPlayerId];
  if (outP && outP.role !== inP.role) {
    return { ok: false, reason: `位置不符：首发需要 ${outP.role}，该球员是 ${inP.role}` };
  }
  sq.starters[idx] = inPlayerId;
  for (const k of ['bench', 'youth']) {
    sq[k] = (sq[k] || []).filter((id) => id !== inPlayerId);
  }
  sq.bench.push(outPlayerId);
  return { ok: true };
}

/** 赛季开始前的市场刷新：重置报价与挂牌 */
export function refreshMarket(game, rng) {
  game.market = {
    season: game.season,
    listings: buildListings(game, rng, 14),
    offers: buildOffers(game, rng, 3),
  };
  return game.market;
}

/**
 * 补齐首发阵容：首发必须满 5 人且五个位置齐全。
 * 不足时按"替补 → 青训 → 临时签自由人"的顺序补，保证赛季能正常开打。
 */
export function repairSquad(game, rng, teamId = game.userTeamId) {
  const sq = game.squads[teamId];
  const picks = [];
  const used = new Set();
  const overallOf = (id) => game.players[id]?.overall || 0;

  // 1. 保留现有首发里每个位置最强的一人
  for (const role of ROLE_ORDER) {
    const cands = (sq.starters || [])
      .filter((id) => game.players[id]?.role === role && !used.has(id))
      .sort((a, b) => overallOf(b) - overallOf(a));
    if (cands[0]) { picks.push(cands[0]); used.add(cands[0]); }
  }
  // 2. 空缺位置从替补、青训里补
  const rest = (sq.bench || []).concat(sq.youth || [])
    .filter((id) => !used.has(id) && game.players[id]);
  for (const role of ROLE_ORDER) {
    if (picks.some((id) => game.players[id]?.role === role)) continue;
    const cand = rest
      .filter((id) => game.players[id].role === role && !used.has(id))
      .sort((a, b) => overallOf(b) - overallOf(a))[0];
    if (cand) { picks.push(cand); used.add(cand); }
  }
  // 3. 实在没人：给一名临时自由人
  const freeAgents = [];
  for (const role of ROLE_ORDER) {
    if (picks.some((id) => game.players[id]?.role === role)) continue;
    const p = generateProspect(rng, teamId, 'normal');
    p.role = role;
    p.age = 21;
    p.name = `${p.name}`;
    p.tags = ['紧急补位'];
    p.wage = Math.round(p.wage * 1.2);
    game.players[p.id] = p;
    picks.push(p.id);
    used.add(p.id);
    freeAgents.push(p.name);
  }

  // 剩余人全部放进替补/青训
  const leftover = (sq.starters || []).concat(sq.bench || [], sq.youth || [])
    .filter((id) => !used.has(id) && game.players[id]);
  sq.starters = picks;
  sq.bench = leftover.filter((id) => !(game.players[id].tags || []).includes('青训'));
  sq.youth = leftover.filter((id) => (game.players[id].tags || []).includes('青训'));
  return { starters: picks, freeAgents };
}
