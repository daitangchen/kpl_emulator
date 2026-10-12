/**
 * 突发事件池
 * 触发时机：每个赛季的赛程节点（每完成一个阶段有概率触发），一季约 3-5 次。
 * 所有选项都有代价，没有"纯赚"的选项。
 *
 * 选项效果（effect）可用字段
 *   cash          现金增减（万）
 *   fame          声望增减
 *   morale        本队士气（-20 ~ +20）
 *   chemistry     队内默契
 *   playerMorale  指定位置球员的个人士气（本作用 overall 小幅涨跌近似）
 *   strongestBoost 队内最强球员的能力微调（版本适应等）
 *   youthSpend    立刻投入青训的花费（并给一名新人）
 *   freeAgent     立刻签下一名自由人（补齐最缺的位置）
 *   skipPrize     本季奖金打折（0.5 = 减半）
 */
import { generateProspect } from './develop.js';
import { neediestRoles } from './transfer.js';

export const EVENTS = [
  {
    id: 'salary_demand',
    when: (g) => (g.fame >= 45 && topPlayer(g)),
    title: '核心选手要求加薪',
    body: (g) => `${topPlayer(g).name} 的经纪人找上门：以他本赛季的表现，现有年薪已经明显偏低，要求下赛季涨薪 40%，否则考虑挂牌。`,
    choices: [
      {
        label: '答应加薪',
        detail: '现金压力上升，但核心留队',
        effect: (g) => {
          const p = topPlayer(g);
          const add = Math.round(p.wage * 0.4);
          p.wage += add;
          g.flags.pendingTransferCost = (g.flags.pendingTransferCost || 0) + add;
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 6);
          return `年薪上调 ${add} 万，全队士气 +6`;
        },
      },
      {
        label: '拒绝并压价',
        detail: '省钱，但队内气氛变差',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 10);
          g.flags.angryStar = true;
          return '拒绝加薪，全队士气 -10，核心可能在赛季末申请转会';
        },
      },
      {
        label: '答应加薪但加长合同',
        detail: '用未来换现在',
        effect: (g) => {
          const p = topPlayer(g);
          const add = Math.round(p.wage * 0.3);
          p.wage += add;
          p.contractYears = (p.contractYears || 1) + 2;
          g.flags.pendingTransferCost = (g.flags.pendingTransferCost || 0) + add;
          return `年薪上调 ${add} 万，合同延长 2 年，锁死未来`;
        },
      },
    ],
  },
  {
    id: 'sponsor_drama',
    when: (g) => g.fame >= 35,
    title: '赞助商找上门',
    body: () => '一家外设品牌希望成为主赞助商，但要求全队参加为期三天的商业活动，挤占训练时间。',
    choices: [
      {
        label: '签下赞助',
        detail: '拿钱，牺牲训练',
        effect: (g) => {
          const gain = Math.round(120 + g.fame * 6);
          g.cash += gain;
          g.chemistry[g.userTeamId] = Math.max(40, g.chemistry[g.userTeamId] - 4);
          return `赞助到账 ${gain} 万，默契 -4`;
        },
      },
      {
        label: '只做单场露出',
        detail: '折中方案',
        effect: (g) => {
          const gain = Math.round(50 + g.fame * 2);
          g.cash += gain;
          return `小幅赞助 ${gain} 万，训练不受影响`;
        },
      },
      {
        label: '婉拒，专心备战',
        detail: '放弃收入换取状态',
        effect: (g) => {
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 5);
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 3);
          return '默契 +5，士气 +3';
        },
      },
    ],
  },
  {
    id: 'meta_shift',
    when: () => true,
    title: '版本大改',
    body: () => '新版本上线，强势英雄池彻底洗牌。教练组建议全队重练体系，但这会挤掉针对性训练的时间。',
    choices: [
      {
        label: '全队重练新体系',
        detail: '短期阵痛，长期收益',
        effect: (g) => {
          const pid = g.userTeamId;
          for (const id of g.squads[pid].starters) {
            const p = g.players[id];
            if (!p) continue;
            p.champPool = Math.min(99, p.champPool + 3);
          }
          g.chemistry[pid] = Math.max(40, g.chemistry[pid] - 6);
          return '全队英雄池 +3，默契 -6（磨合期）';
        },
      },
      {
        label: '只练版本答案',
        detail: '赌一把热门体系',
        effect: (g) => {
          const pid = g.userTeamId;
          const strong = topPlayer(g);
          if (strong) strong.champPool = Math.min(99, strong.champPool + 6);
          g.chemistry[pid] = Math.max(40, g.chemistry[pid] - 2);
          return `${strong ? strong.name : '核心'}英雄池 +6，但体系单一`;
        },
      },
      {
        label: '坚持原有体系',
        detail: '以不变应万变',
        effect: (g) => {
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 4);
          g.flags.metaStubborn = true;
          return '默契 +4，但版本契合度会吃亏';
        },
      },
    ],
  },
  {
    id: 'poach_coach',
    when: (g) => (g.lastRank || 18) <= 8,
    title: '教练被挖角',
    body: (g) => `一支豪门开出三倍薪水挖你的主教练（当前教练水平 ${g.teams[g.userTeamId].coachLevel}）。教练本人表示愿意留下，但希望俱乐部表态。`,
    choices: [
      {
        label: '加薪留人',
        detail: '花钱保住教练组',
        effect: (g) => {
          const cost = 180;
          g.cash -= cost;
          g.teams[g.userTeamId].coachLevel = Math.min(95, g.teams[g.userTeamId].coachLevel + 3);
          return `支出 ${cost} 万，教练水平 +3`;
        },
      },
      {
        label: '放人，提拔助教',
        detail: '省钱，但战术水平下滑',
        effect: (g) => {
          g.teams[g.userTeamId].coachLevel = Math.max(35, g.teams[g.userTeamId].coachLevel - 8);
          const gain = Math.round(topPlayer(g) ? 260 : 200);
          g.cash += gain;
          return `收违约金 ${gain} 万，教练水平 -8`;
        },
      },
      {
        label: '放人并从外面请名帅',
        detail: '高价换帅',
        effect: (g) => {
          g.cash -= 320;
          g.teams[g.userTeamId].coachLevel = Math.min(96, g.teams[g.userTeamId].coachLevel + 6);
          g.chemistry[g.userTeamId] = Math.max(40, g.chemistry[g.userTeamId] - 5);
          return '支出 320 万，教练水平 +6，但需要重新磨合（默契 -5）';
        },
      },
    ],
  },
  {
    id: 'player_feud',
    when: (g) => (g.morale[g.userTeamId] ?? 70) < 68,
    title: '队内矛盾',
    body: () => '训练赛连败之后，队内两位主力在语音里吵了起来，气氛僵到需要总经理介入。',
    choices: [
      {
        label: '开诚布公的队会',
        detail: '花时间解决',
        effect: (g) => {
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 7);
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 6);
          return '默契 +7，士气 +6';
        },
      },
      {
        label: '罚款警告',
        detail: '强硬管理',
        effect: (g) => {
          g.cash += 30;
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 4);
          return '罚款 30 万，士气 -4';
        },
      },
      {
        label: '不管，让他们自己解决',
        detail: '不投入精力',
        effect: (g) => {
          g.chemistry[g.userTeamId] = Math.max(40, g.chemistry[g.userTeamId] - 6);
          return '默契 -6';
        },
      },
    ],
  },
  {
    id: 'injury',
    when: (g) => g.squads[g.userTeamId].starters.length === 5,
    title: '主力伤病',
    body: (g) => `${topPlayer(g)?.name || '主力选手'} 在训练中手腕不适，队医建议休息两周。接下来几场比赛要不要让他上？`,
    choices: [
      {
        label: '强制轮休',
        detail: '让替补顶上',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 3);
          g.flags.restedStar = true;
          return '短期战力下降，但避免了伤情加重';
        },
      },
      {
        label: '带伤坚持',
        detail: '赌阵容完整',
        effect: (g) => {
          const p = topPlayer(g);
          if (p) {
            p.laning = Math.max(40, p.laning - 2);
            p.teamfight = Math.max(40, p.teamfight - 2);
          }
          return `${p ? p.name : '核心'}操作 -2、团战 -2（隐患）`;
        },
      },
      {
        label: '请专家会诊',
        detail: '花钱买安心',
        effect: (g) => {
          g.cash -= 90;
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 4);
          return '支出 90 万，士气 +4，伤情可控';
        },
      },
    ],
  },
  {
    id: 'cash_crisis',
    when: (g) => g.cash < 400,
    title: '资金告急',
    body: (g) => `账面现金只剩 ${Math.round(g.cash)} 万，下个月工资都发不出来。管理层连夜开会。`,
    choices: [
      {
        label: '找股东增资',
        detail: '稀释控制权换现金',
        effect: (g) => {
          const gain = 700;
          g.cash += gain;
          g.fame = Math.max(0, g.fame - 5);
          g.flags.shareDiluted = (g.flags.shareDiluted || 0) + 1;
          return `增资 ${gain} 万，声望 -5，股份被稀释`;
        },
      },
      {
        label: '紧急卖一名替补',
        detail: '立刻回血',
        effect: (g) => {
          const pid = g.userTeamId;
          const sq = g.squads[pid];
          const sellId = (sq.bench || [])[0];
          if (sellId && g.players[sellId]) {
            const p = g.players[sellId];
            sq.bench = sq.bench.filter((x) => x !== sellId);
            const gain = Math.round(p.value * 0.6);
            g.cash += gain;
            return `卖掉 ${p.name}，回血 ${gain} 万`;
          }
          g.cash += 150;
          return '无人可卖，只能拆借 150 万';
        },
      },
      {
        label: '全员欠薪，硬扛',
        detail: '士气崩盘但省钱',
        effect: (g) => {
          g.cash += 420;
          g.morale[g.userTeamId] = Math.max(15, g.morale[g.userTeamId] - 20);
          g.chemistry[g.userTeamId] = Math.max(35, g.chemistry[g.userTeamId] - 8);
          return '拆借 420 万，士气 -20，默契 -8';
        },
      },
    ],
  },
  {
    id: 'host_city',
    when: () => true,
    title: '主场城市邀约',
    body: () => '当地政府希望俱乐部把主场活动做进城市文旅项目，提供补贴，但要求队伍参加一系列线下活动。',
    choices: [
      {
        label: '深度合作',
        detail: '拿补贴，牺牲训练',
        effect: (g) => {
          const gain = Math.round(200 + g.fame * 3);
          g.cash += gain;
          g.chemistry[g.userTeamId] = Math.max(40, g.chemistry[g.userTeamId] - 3);
          g.fame = Math.min(100, g.fame + 3);
          return `补贴 ${gain} 万，声望 +3，默契 -3`;
        },
      },
      {
        label: '仅出席开幕式',
        detail: '低强度配合',
        effect: (g) => {
          g.cash += 80;
          g.fame = Math.min(100, g.fame + 1);
          return '补贴 80 万，声望 +1';
        },
      },
      {
        label: '拒绝，封闭训练',
        detail: '专注赛季',
        effect: (g) => {
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 3);
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 2);
          return '默契 +3，士气 +2';
        },
      },
    ],
  },
  {
    id: 'veteran_mentor',
    when: (g) => g.squads[g.userTeamId].youth?.length > 0,
    title: '青训苗子冒头',
    body: (g) => `青训营里 ${g.players[g.squads[g.userTeamId].youth[0]]?.name || '一名小将'} 在训练赛里打得非常亮眼，教练建议给他一队出场机会。`,
    choices: [
      {
        label: '直接提上一队',
        detail: '给年轻人机会',
        effect: (g) => {
          const pid = g.userTeamId;
          const sq = g.squads[pid];
          const yid = sq.youth[0];
          if (yid) {
            sq.youth = sq.youth.filter((x) => x !== yid);
            sq.bench.push(yid);
            const role = g.players[yid].role;
            const hasRole = sq.starters.some((id) => g.players[id]?.role === role);
            if (!hasRole) {
              sq.starters.push(yid);
              sq.bench = sq.bench.filter((x) => x !== yid);
            }
            g.morale[pid] = Math.min(100, g.morale[pid] + 3);
            return `${g.players[yid].name} 进入一队`;
          }
          return '青训名单为空';
        },
      },
      {
        label: '再练一季',
        detail: '稳一点',
        effect: (g) => {
          const pid = g.userTeamId;
          const yid = g.squads[pid].youth[0];
          const p = g.players[yid];
          if (p) {
            p.laning = Math.min(99, p.laning + 3);
            p.macro = Math.min(99, p.macro + 3);
            p.teamfight = Math.min(99, p.teamfight + 3);
          }
          return `${p ? p.name : '青训'}能力 +3（继续培养）`;
        },
      },
      {
        label: '卖掉换钱',
        detail: '变现潜力',
        effect: (g) => {
          const pid = g.userTeamId;
          const yid = g.squads[pid].youth[0];
          const p = g.players[yid];
          if (p) {
            g.squads[pid].youth = g.squads[pid].youth.filter((x) => x !== yid);
            const gain = Math.round(p.value * 0.8);
            g.cash += gain;
            return `卖掉 ${p.name}，回血 ${gain} 万`;
          }
          return '无人可卖';
        },
      },
    ],
  },
  {
    id: 'public_opinion',
    when: (g) => g.fame >= 50,
    title: '舆论危机',
    body: () => '一次赛后采访被断章取义，热搜挂了整整一天，粉丝情绪激动，赞助商打来电话询问情况。',
    choices: [
      {
        label: '公开发声解释',
        detail: '正面回应',
        effect: (g) => {
          g.fame = Math.max(0, g.fame - 2);
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 4);
          return '声望 -2，队内士气 +4（俱乐部护着队员）';
        },
      },
      {
        label: '冷处理，等热度过去',
        detail: '不回应',
        effect: (g) => {
          g.fame = Math.max(0, g.fame - 6);
          return '声望 -6';
        },
      },
      {
        label: '买热搜压下去',
        detail: '公关费用',
        effect: (g) => {
          g.cash -= 140;
          return '支出 140 万公关费，热度被压住';
        },
      },
    ],
  },
  {
    id: 'streaming_deal',
    when: (g) => g.fame >= 40,
    title: '直播平台合约',
    body: () => '直播平台希望全队签下独家合约，保底金额可观，但要求队员每周固定开播，占用休息时间。',
    choices: [
      {
        label: '签独家',
        detail: '稳定现金流',
        effect: (g) => {
          const gain = Math.round(260 + g.fame * 4);
          g.cash += gain;
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 5);
          g.fame = Math.min(100, g.fame + 4);
          return `收入 ${gain} 万，声望 +4，士气 -5（休息不足）`;
        },
      },
      {
        label: '只签队长一人',
        detail: '折中',
        effect: (g) => {
          g.cash += 120;
          g.fame = Math.min(100, g.fame + 2);
          return '收入 120 万，声望 +2';
        },
      },
      {
        label: '不签，保证训练',
        detail: '放弃直播收入',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 5);
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 3);
          return '士气 +5，默契 +3';
        },
      },
    ],
  },
  {
    id: 'playoff_bonus',
    when: (g) => (g.lastRank || 18) <= 10,
    title: '季后赛奖金方案',
    body: () => '董事会提议：如果本赛季打进四强，全队分享一笔额外奖金；如果没打进，这笔钱留在俱乐部。',
    choices: [
      {
        label: '承诺高额奖金',
        detail: '激励拉满，风险自担',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 10);
          g.flags.bonusPromise = 400;
          return '士气 +10；若打进四强将支出 400 万';
        },
      },
      {
        label: '小额激励',
        detail: '稳健方案',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 4);
          g.flags.bonusPromise = 150;
          return '士气 +4；打进四强支出 150 万';
        },
      },
      {
        label: '不设奖金',
        detail: '省钱',
        effect: (g) => {
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 5);
          return '士气 -5，但没有额外支出';
        },
      },
    ],
  },
  {
    id: 'rent_hike',
    when: () => true,
    title: '基地租金上涨',
    body: () => '基地物业通知续租涨租 30%，或者俱乐部可以选择搬到郊区、通勤时间增加一小时。',
    choices: [
      {
        label: '接受涨租留在市区',
        detail: '训练效率优先',
        effect: (g) => {
          g.cash -= 160;
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 2);
          return '支出 160 万，默契 +2';
        },
      },
      {
        label: '搬到郊区',
        detail: '省钱但通勤累',
        effect: (g) => {
          g.cash += 120;
          g.morale[g.userTeamId] = Math.max(20, g.morale[g.userTeamId] - 6);
          return '省下 120 万，士气 -6';
        },
      },
      {
        label: '和别队合租基地',
        detail: '共享设施',
        effect: (g) => {
          g.cash += 60;
          g.chemistry[g.userTeamId] = Math.max(40, g.chemistry[g.userTeamId] - 2);
          return '省下 60 万，默契 -2（设施排期冲突）';
        },
      },
    ],
  },
  {
    id: 'fan_event',
    when: (g) => g.fame >= 25,
    title: '粉丝见面会',
    body: () => '后援会申请举办线下见面会，需要俱乐部出人出力，收益不大但能稳住核心粉丝。',
    choices: [
      {
        label: '全员出席',
        detail: '花时间换人气',
        effect: (g) => {
          g.fame = Math.min(100, g.fame + 5);
          g.morale[g.userTeamId] = Math.min(100, g.morale[g.userTeamId] + 3);
          return '声望 +5，士气 +3';
        },
      },
      {
        label: '只派两人出席',
        detail: '最低成本',
        effect: (g) => {
          g.fame = Math.min(100, g.fame + 2);
          return '声望 +2';
        },
      },
      {
        label: '取消活动',
        detail: '全员训练',
        effect: (g) => {
          g.fame = Math.max(0, g.fame - 3);
          g.chemistry[g.userTeamId] = Math.min(95, g.chemistry[g.userTeamId] + 2);
          return '声望 -3，默契 +2';
        },
      },
    ],
  },
  {
    id: 'free_agent',
    when: () => true,
    title: '自由人试训',
    body: (g) => `一名有经验的老将主动来试训，位置正好是你队最缺的${roleName(neediestRoles(g, g.userTeamId)[0])}，但他要的年薪不低。`,
    choices: [
      {
        label: '签下他',
        detail: '即战力补充',
        effect: (g) => {
          const pid = g.userTeamId;
          const role = neediestRoles(g, pid)[0] || 'mid';
          const rng = g.__rng;
          const p = generateProspect(rng, pid, 'normal');
          p.role = role;
          p.age = rng.int(25, 28);
          p.laning += 6; p.macro += 8; p.teamfight += 6; p.champPool += 4;
          p.potential = Math.max(p.potential, 80);
          p.value = 320;
          p.wage = 260;
          g.players[p.id] = p;
          const sq = g.squads[pid];
          const hasRole = sq.starters.some((id) => g.players[id]?.role === role);
          if (!hasRole) sq.starters.push(p.id);
          else sq.bench.push(p.id);
          return `签下老将 ${p.name}（${roleName(role)}，年薪 260 万）`;
        },
      },
      {
        label: '婉拒',
        detail: '不增加工资负担',
        effect: () => '保持现有阵容',
      },
    ],
  },
];

const ROLE_CN = { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' };
function roleName(r) { return ROLE_CN[r] || '空缺位置'; }

/** 队内最强首发 */
export function topPlayer(game) {
  const ids = game.squads[game.userTeamId].starters || [];
  const list = ids.map((id) => game.players[id]).filter(Boolean);
  if (!list.length) return null;
  return list.slice().sort((a, b) => b.overall - a.overall)[0];
}

/** 抽取一个当前可触发的随机事件 */
export function rollEvent(game, rng) {
  const pool = EVENTS.filter((e) => {
    try { return e.when(game); } catch { return false; }
  });
  if (!pool.length) return null;
  const ev = rng.pick(pool);
  const hostile = ev.id === 'cash_crisis' || ev.id === 'injury' || ev.id === 'player_feud';
  const chance = hostile ? 0.55 : 0.7;
  if (!rng.chance(chance)) return null;
  return buildEventCard(game, ev);
}

/** 把事件模板实例化成界面可用的卡片 */
export function buildEventCard(game, ev) {
  return {
    id: ev.id,
    title: ev.title,
    body: typeof ev.body === 'function' ? ev.body(game) : ev.body,
    choices: ev.choices.map((c, i) => ({
      index: i,
      label: c.label,
      detail: typeof c.detail === 'function' ? c.detail(game) : c.detail,
    })),
  };
}

/** 应用玩家选择 */
export function resolveEvent(game, eventId, choiceIndex) {
  const ev = EVENTS.find((e) => e.id === eventId);
  if (!ev) return { ok: false, reason: '事件不存在' };
  const choice = ev.choices[choiceIndex];
  if (!choice) return { ok: false, reason: '选项不存在' };
  const rng = game.__rng;
  const text = choice.effect(game, rng);
  game.eventLog = game.eventLog || [];
  game.eventLog.push({ season: game.season, eventId, choice: choice.label, result: text });
  return { ok: true, text };
}
