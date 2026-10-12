/**
 * 全局常量：赛程日历、奖金、薪资结构、年总积分
 *
 * 赛制依据（2026 赛季，已核实）
 *  - 常规赛三轮：抽签分组 → S/A/B 重组 → 卡位赛 → 组内单循环，B 组后四名提前结束
 *  - 季后赛 BO7 双败；常规赛 BO5
 *  - 挑战者杯 32 队 8 赛道：32 进 8 单败（本作跳过），8 强 BO7 双败，决赛 BO9
 *  - 年度总决赛 12 队：擂台赛（大师组/精英组）→ 突围赛 → 淘汰赛双败 BO7 → 总决赛
 */

export const SEASON = {
  year: 2026,
  /** 游戏从 2026 年 10 月年总进行中接入 */
  startLabel: '2026 年 10 月',
};

/** 一周 = 一个推进单位；每项赛事由若干"比赛日"组成，玩家点一次推进算一个比赛日 */
export const CALENDAR = [
  { id: 'spring', name: 'KPL 春季赛', short: '春季赛', startWeek: 1, endWeek: 14, prize: { champion: 360, runnerUp: 120, semi: 60, quarter: 30 } },
  { id: 'challenger', name: '王者荣耀挑战者杯', short: '挑杯', startWeek: 15, endWeek: 20, prize: { champion: 500, runnerUp: 200, semi: 80, quarter: 40 } },
  { id: 'summer', name: 'KPL 夏季赛', short: '夏季赛', startWeek: 21, endWeek: 34, prize: { champion: 360, runnerUp: 120, semi: 60, quarter: 30 } },
  { id: 'finals', name: 'KPL 年度总决赛', short: '年总', startWeek: 35, endWeek: 42, prize: { champion: 2000, runnerUp: 800, semi: 400, quarter: 200 } },
];

export const EVENT_BY_ID = Object.fromEntries(CALENDAR.map((e) => [e.id, e]));

/** 常规赛三轮的轮次节奏（每轮 5 场组内单循环，打 5 个比赛日） */
export const REGULAR_ROUNDS = [
  { index: 1, name: '第一轮', note: '抽签分组，组内单循环，按名次重分 S/A/B' },
  { index: 2, name: '第二轮', note: 'S/A/B 组内单循环，赛后打 S/A、A/B 卡位赛' },
  { index: 3, name: '第三轮', note: 'S 组争季后赛席位；B 组后四名提前结束赛季' },
];

/** 财务：目标是一支中游队伍大致打平，垫底队伍必须亏钱，争冠队伍才有盈余 */
export const FINANCE = {
  /** 起步资金（万元）：按战队档位在 teams.js 的 budget 里给 */
  leagueShare: 700,          // 联盟分成基准（再乘以名次系数 leagueShareByRank）
  sponsorBase: 180,          // 赞助基础额
  sponsorPerFame: 14,        // 每点声望带来的赞助加成
  ticketBase: 70,            // 主场门票基础
  merchBase: 46,             // 周边基础
  /** 每场胜利的赢球奖金（万元） */
  winBonus: 8,
  /**
   * 常规营收：**只要打完一轮比赛就有进账**（门票 + 转播 + 主场餐饮），
   * 不依赖胜负，随声望浮动 —— 让"每打完比赛手头就宽一点"，缓解前期资金压力。
   * 单轮 = base + 声望 × perFame
   */
  matchIncome: { base: 5, perFame: 0.08 },
  /** 基地与运营固定开支（每赛季） */
  baseCost: 520,
  /** 青训投入档位 */
  youthTiers: [60, 140, 260],
  /** 声望变化 */
  fame: { win: 1.2, lose: -1.0, champion: 18, runnerUp: 10, title: 6 },
};

/**
 * 联盟分成的名次系数：成绩差 = 分成也少。
 * 这是"摆烂也能活下去"的封堵手段，垫底队伍必须亏钱。
 */
export const LEAGUE_SHARE_BY_RANK = [
  { maxRank: 4, mul: 1.40 },
  { maxRank: 8, mul: 1.05 },
  { maxRank: 12, mul: 0.78 },
  { maxRank: 15, mul: 0.60 },
  { maxRank: 18, mul: 0.48 },
];

export function leagueShareForRank(rank) {
  const row = LEAGUE_SHARE_BY_RANK.find((r) => rank <= r.maxRank);
  return Math.round(FINANCE.leagueShare * (row ? row.mul : 0.5));
}

/** 选手身价与薪资换算：身价高 = 薪水要求高 */
export const WAGE_FACTOR = 0.82;

/**
 * 全球员薪资缩放
 * players.js 里存的是"选手市场价"级别的数字，直接当俱乐部成本会让人力成本吃掉全部收入。
 * 这里统一缩放到"俱乐部可承受"的区间：中游队伍不夺冠时大致打平，争冠队伍才有余钱。
 */
export const WAGE_SCALE = 0.45;

/** 球队档位对应的薪资系数：豪门开高薪，小队自然压价 */
export function tierWageMul(tier) {
  return tier === 'S' ? 1 : tier === 'A' ? 0.82 : 0.66;
}

/** 一名球员对某档位球队的实际年薪（转会、青训、续约统一走这个口径） */
export function contractWage(playerValue, tier) {
  return Math.max(50, Math.round(playerValue * 0.62 * WAGE_SCALE * tierWageMul(tier)));
}

/** 年总参赛与分组（真实规则） */
export const FINALS_RULES = {
  qualified: 12,
  masters: 6,        // 年度积分 1-6 名 → 大师组
  elite: 6,          // 7-12 名 → 精英组
  /** 擂台赛：组外单循环 BO5，两个组别独立排名 */
  advanceToPlayoff: { mastersTop: 4, eliteTop: 1 },
  advanceToSurvival: { mastersBottom: 2, eliteRest: 4 },
};

/** 年度积分（春 / 挑杯 / 夏 三站累计，决定年总资格） */
export const ANNUAL_POINTS = {
  spring: { 1: 100, 2: 80, 3: 60, 4: 50, 5: 40, 6: 32, 8: 24, 12: 16, 18: 8 },
  challenger: { 1: 80, 2: 60, 3: 45, 4: 36, 5: 28, 6: 22, 8: 16, 12: 10, 18: 5 },
  summer: { 1: 120, 2: 95, 3: 72, 4: 60, 5: 48, 6: 38, 8: 28, 12: 18, 18: 10 },
};

/** 强制结束条件 */
export const FAILURE_RULES = {
  /** 现金低于此值触发资金危机 */
  cashCrisis: 0,
  /** 连续两个赛季现金为负 → 资金断裂，强制结束 */
  bankruptSeasons: 2,
  /** 连续两个赛季排名倒数 3（按组别总排名）→ 董事会解雇 */
  bottomSeasons: 2,
  bottomThreshold: 15, // 18 队中排名 >= 15 视为倒数 3
  hardSeasonLimit: 4,  // 硬上限：4 个赛季
};

/**
 * 疲劳（商务运营的代价）
 * 疲劳来自"跑商务/接活动"这类挤占训练时间的操作，数值越高战力越低。
 * 每支队伍在开季时清零，之后每个比赛日自然恢复一点。
 */
export const FATIGUE = {
  cap: 40,            // 疲劳上限，到顶就不能再跑商务
  perPower: 0.2,      // 每 1 点疲劳扣多少战力（疲劳 20 → -4 战力）
  recoverPerDay: 2,   // 每个比赛日恢复
};
