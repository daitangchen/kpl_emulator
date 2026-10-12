/**
 * 18 支 KPL 真实战队数据
 *
 * 数据基准：2026 赛季（春季赛 / 挑战者杯 / 夏季赛 / 年度总决赛）
 * 来源：KPL 官网夏季赛积分榜、2026 夏季赛 18 队大名单、2026 夏季转会期官宣、
 *      2026 夏季赛决赛战报（广州 TTG 4:3 重庆狼队）、2026 春季赛决赛（KSG 夺冠）
 *
 * 字段说明
 *  id        稳定英文 id，存档里只存 id
 *  name      队名（含城市前缀，官方叫法）
 *  short     2-4 字简称，界面用
 *  city      主场城市
 *  tier      现实档位 S/A/B，只用于难度星级与初始身价，会随游戏进程变化
 *  budget    初始可用预算（万元），强队预算高但历史包袱（高薪合同）也重
 *  baseWage  队内平均年薪基准（万元/年），影响续约与转会报价
 *  style     战术风格，与版本 meta 匹配度参与战力计算
 *  coach     主教练
 *  honors    历史荣誉，只做展示
 */

export const STYLES = {
  macro: { id: 'macro', name: '运营', desc: '前中期稳、打资源置换，后期团战强' },
  aggro: { id: 'aggro', name: '前期打架', desc: '节奏快、入侵凶，容错低' },
  protect: { id: 'protect', name: '四保一', desc: '围绕发育路打，核心状态决定上限' },
  flex: { id: 'flex', name: '灵活多变', desc: '英雄池深，BP 优势大' },
  late: { id: 'late', name: '后期大团', desc: '抗压能力弱但决胜团极强' },
};

export const TEAMS = [
  {
    id: 'ag', name: '成都AG超玩会', short: 'AG', city: '成都', tier: 'S',
    budget: 5200, baseWage: 620, style: 'flex', coach: '陈正正',
    honors: ['2026 春 11 人大名单', 'KPL 历史豪门'],
  },
  {
    id: 'wolves', name: '重庆狼队', short: '狼队', city: '重庆', tier: 'S',
    budget: 5000, baseWage: 640, style: 'macro', coach: 'SK',
    honors: ['2026 夏季赛亚军'],
  },
  {
    id: 'ksg', name: '苏州KSG', short: 'KSG', city: '苏州', tier: 'S',
    budget: 4600, baseWage: 580, style: 'aggro', coach: '张角',
    honors: ['2026 春季赛冠军'],
  },
  {
    id: 'wb', name: '北京WB', short: 'WB', city: '北京', tier: 'S',
    budget: 5400, baseWage: 660, style: 'flex', coach: '老林',
    honors: ['2025 挑战者杯冠军', '2026 夏窗重金补强'],
  },
  {
    id: 'ttg', name: '广州TTG', short: 'TTG', city: '广州', tier: 'S',
    budget: 4800, baseWage: 600, style: 'aggro', coach: 'Pomi',
    honors: ['2026 夏季赛冠军', '2023 夏季赛冠军'],
  },
  {
    id: 'estar', name: '武汉eStarPro', short: 'eStar', city: '武汉', tier: 'A',
    budget: 3400, baseWage: 520, style: 'protect', coach: '晨羽',
    honors: ['多冠王朝后重建期'],
  },
  {
    id: 'drg', name: '佛山DRG', short: 'DRG', city: '佛山', tier: 'A',
    budget: 3200, baseWage: 480, style: 'late', coach: '行天',
    honors: ['保留核心班底'],
  },
  {
    id: 'dyg', name: '深圳DYG', short: 'DYG', city: '深圳', tier: 'A',
    budget: 3100, baseWage: 470, style: 'macro', coach: '白书',
    honors: ['老牌劲旅'],
  },
  {
    id: 'edgm', name: '上海EDG.M', short: 'EDG.M', city: '上海', tier: 'A',
    budget: 3000, baseWage: 460, style: 'aggro', coach: 'Dgc',
    honors: ['2026 夏季赛晋级季后赛'],
  },
  {
    id: 'hero', name: '南通Hero久竞', short: 'Hero', city: '南通', tier: 'A',
    budget: 3100, baseWage: 470, style: 'macro', coach: '张角',
    honors: ['Hero 系青训传统'],
  },
  {
    id: 'jdg', name: '北京JDG', short: 'JDG', city: '北京', tier: 'A',
    budget: 3600, baseWage: 520, style: 'flex', coach: '十一',
    honors: ['资本入局新贵'],
  },
  {
    id: 'lgd', name: '杭州LGD.NBW', short: 'LGD', city: '杭州', tier: 'A',
    budget: 2900, baseWage: 450, style: 'flex', coach: '张角',
    honors: ['全员重建'],
  },
  {
    id: 'rw', name: '济南RW侠', short: 'RW侠', city: '济南', tier: 'A',
    budget: 3300, baseWage: 490, style: 'aggro', coach: '小淇',
    honors: ['2025 挑战者杯亚军'],
  },
  {
    id: 'tes', name: '长沙TES.A', short: 'TES.A', city: '长沙', tier: 'A',
    budget: 3000, baseWage: 465, style: 'late', coach: '落幕',
    honors: ['2026 夏季赛败者组半决赛'],
  },
  {
    id: 'rngm', name: '上海RNG.M', short: 'RNG.M', city: '上海', tier: 'B',
    budget: 2200, baseWage: 380, style: 'protect', coach: '十一',
    honors: ['重建中'],
  },
  {
    id: 'we', name: '西安WE', short: 'WE', city: '西安', tier: 'B',
    budget: 2100, baseWage: 370, style: 'aggro', coach: '晨羽',
    honors: ['多名主力挂牌'],
  },
  {
    id: 'wst', name: '深圳WST', short: 'WST', city: '深圳', tier: 'B',
    budget: 1800, baseWage: 330, style: 'macro', coach: '待定',
    honors: ['KPL 新军'],
  },
  {
    id: 'syg', name: 'SYG', short: 'SYG', city: '上海', tier: 'B',
    budget: 1700, baseWage: 320, style: 'aggro', coach: '待定',
    honors: ['全国大赛赛道升入 KPL', '屡有爆冷'],
  },
];

/** 难度星级：B 档起步 = 地狱模式，S 档 = 简单模式 */
export const DIFFICULTY = {
  S: { stars: 1, label: '简单', desc: '豪门班底，预算充足，容错高' },
  A: { stars: 3, label: '普通', desc: '中游球队，需在预算与成绩间取舍' },
  B: { stars: 5, label: '地狱', desc: '预算紧、阵容薄，一步走错就破产' },
};

export const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
