/**
 * 王者荣耀英雄池 —— 巅峰对决 BP 用
 *
 * 每个英雄按 5 个位置归类，带「版本强度」信息：
 *  - tier：0 = T0（版本强势）/ 1 = T1（常用）/ 2 = T2（冷门）
 *  - rate：KPL 赛场出场率（%），出场率越高越算版本答案
 *  - style：打法倾向（对应 lineup.js 里的克制环：强开团/四一分推/远程消耗/保核反手/抓单集火）
 *
 * 数据参照 KPL 赛场的常见英雄与出场率梯度整理，供"先看版本强势阵容，再逐位置选英雄"的 BP 体验。
 */

export const POSITIONS = [
  { key: 'top', name: '对抗路', icon: '🛡' },
  { key: 'jungle', name: '打野', icon: '🌲' },
  { key: 'mid', name: '中路', icon: '✦' },
  { key: 'adc', name: '发育路', icon: '🏹' },
  { key: 'support', name: '游走', icon: '🧭' },
];

export const TIER_LABEL = { 0: 'T0', 1: 'T1', 2: 'T2' };
export const STYLE_LABEL = {
  teamfight: '强开团', split: '四一分推', poke: '远程消耗', protect: '保核反手', collapse: '抓单集火',
};

export const HEROES = [
  // ── 对抗路 ──
  { id: 'machao', name: '马超', pos: 'top', style: 'split', tier: 0, rate: 30 },
  { id: 'xialuote', name: '夏洛特', pos: 'top', style: 'collapse', tier: 0, rate: 28 },
  { id: 'guanyu', name: '关羽', pos: 'top', style: 'split', tier: 1, rate: 25 },
  { id: 'lubu', name: '吕布', pos: 'top', style: 'teamfight', tier: 1, rate: 22 },
  { id: 'kuangtie', name: '狂铁', pos: 'top', style: 'teamfight', tier: 1, rate: 20 },
  { id: 'zhubajie', name: '猪八戒', pos: 'top', style: 'teamfight', tier: 1, rate: 18 },
  { id: 'mengtian', name: '蒙恬', pos: 'top', style: 'protect', tier: 2, rate: 12 },
  { id: 'yuange', name: '元歌', pos: 'top', style: 'collapse', tier: 2, rate: 8 },
  // ── 打野 ──
  { id: 'jing', name: '镜', pos: 'jungle', style: 'collapse', tier: 0, rate: 32 },
  { id: 'gongben', name: '宫本武藏', pos: 'jungle', style: 'teamfight', tier: 0, rate: 30 },
  { id: 'lan', name: '澜', pos: 'jungle', style: 'collapse', tier: 1, rate: 26 },
  { id: 'yao', name: '曜', pos: 'jungle', style: 'split', tier: 1, rate: 22 },
  { id: 'aguduo', name: '阿古朵', pos: 'jungle', style: 'protect', tier: 1, rate: 18 },
  { id: 'kai', name: '铠', pos: 'jungle', style: 'teamfight', tier: 2, rate: 15 },
  { id: 'yunying', name: '云缨', pos: 'jungle', style: 'teamfight', tier: 2, rate: 10 },
  { id: 'juyoujing', name: '橘右京', pos: 'jungle', style: 'collapse', tier: 2, rate: 9 },
  // ── 中路 ──
  { id: 'xishi', name: '西施', pos: 'mid', style: 'poke', tier: 0, rate: 30 },
  { id: 'buzhihuowu', name: '不知火舞', pos: 'mid', style: 'collapse', tier: 0, rate: 28 },
  { id: 'shenmengxi', name: '沈梦溪', pos: 'mid', style: 'poke', tier: 1, rate: 24 },
  { id: 'wangzhaojun', name: '王昭君', pos: 'mid', style: 'poke', tier: 1, rate: 20 },
  { id: 'yixing', name: '弈星', pos: 'mid', style: 'protect', tier: 1, rate: 18 },
  { id: 'ganjiang', name: '干将莫邪', pos: 'mid', style: 'poke', tier: 2, rate: 14 },
  { id: 'haiyue', name: '海月', pos: 'mid', style: 'protect', tier: 2, rate: 10 },
  { id: 'jinchan', name: '金蝉', pos: 'mid', style: 'protect', tier: 2, rate: 8 },
  // ── 发育路 ──
  { id: 'gongsunli', name: '公孙离', pos: 'adc', style: 'split', tier: 0, rate: 30 },
  { id: 'sunshangxiang', name: '孙尚香', pos: 'adc', style: 'teamfight', tier: 0, rate: 28 },
  { id: 'direnjie', name: '狄仁杰', pos: 'adc', style: 'protect', tier: 1, rate: 22 },
  { id: 'makeboluo', name: '马可波罗', pos: 'adc', style: 'split', tier: 1, rate: 20 },
  { id: 'jialuo', name: '伽罗', pos: 'adc', style: 'protect', tier: 1, rate: 18 },
  { id: 'luban', name: '鲁班七号', pos: 'adc', style: 'teamfight', tier: 2, rate: 16 },
  { id: 'chengjisihan', name: '成吉思汗', pos: 'adc', style: 'poke', tier: 2, rate: 8 },
  { id: 'huangzhong', name: '黄忠', pos: 'adc', style: 'protect', tier: 2, rate: 7 },
  // ── 游走 ──
  { id: 'zhangfei', name: '张飞', pos: 'support', style: 'protect', tier: 0, rate: 28 },
  { id: 'taiyi', name: '太乙真人', pos: 'support', style: 'protect', tier: 0, rate: 26 },
  { id: 'sunbin', name: '孙膑', pos: 'support', style: 'split', tier: 1, rate: 22 },
  { id: 'lubandashi', name: '鲁班大师', pos: 'support', style: 'teamfight', tier: 1, rate: 20 },
  { id: 'dunshan', name: '盾山', pos: 'support', style: 'teamfight', tier: 1, rate: 18 },
  { id: 'niumo', name: '牛魔', pos: 'support', style: 'teamfight', tier: 2, rate: 15 },
  { id: 'donghuang', name: '东皇太一', pos: 'support', style: 'collapse', tier: 2, rate: 12 },
  { id: 'guiguzi', name: '鬼谷子', pos: 'support', style: 'collapse', tier: 2, rate: 10 },
];

export const HERO_BY_ID = Object.fromEntries(HEROES.map((h) => [h.id, h]));

/** 某个位置的全部英雄（按出场率从高到低） */
export function heroesByPos(pos) {
  return HEROES.filter((h) => h.pos === pos).sort((a, b) => b.rate - a.rate);
}
