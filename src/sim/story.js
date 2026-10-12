/**
 * 选手剧情引擎 —— 让球员从一串数字变成有性格、有弧线、会说话的角色
 *
 * 三块内容：
 *  1. 性格（trait）   ：每个球员有一套稳定的性格原型，影响成长速度、薪资诉求与转会意愿
 *  2. 成长弧（arc）   ：根据成长历史 + 年龄 + 潜力，推断这名球员现在处在什么故事阶段
 *  3. 采访发言（quote）：赛果、转会、休赛期等节点，给球员配一句符合性格的发言
 *
 * 设计约束
 *  - 性格必须「确定性分配」：同一名球员在任何时候拿到的性格都一样（用 id 哈希，不消耗主 RNG）
 *  - 不能扰动比赛随机流：所有随机选择走独立的哈希函数，绝不调用 game.__rng
 *  - 不直接改动战力公式：性格只通过"成长速度 / 合同诉求 / 转会倾向"这些行为层生效，
 *    避免给每支队伍引入随机的战力扰动、破坏既有的平衡基线
 *  - 老存档要能平滑接入：ensureTraits 负责给缺字段的球员补齐
 */

/** FNV-1a 32 位哈希：把任意字符串稳定映射成一个整数 */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 用种子字符串从数组里稳定地选一项 */
export function pickBy(arr, seed) {
  if (!arr || !arr.length) return null;
  return arr[hash32(seed) % arr.length];
}

/* ══════════════════════════ 1. 性格原型 ══════════════════════════ */

/**
 * 字段说明
 *  growth        赛季成长倍率（1 = 常人）。性格只影响"练得快不快"，不改战力公式
 *  wageAsk       续约/转会时的薪资诉求倍率（>1 更贵，<1 更省）
 *  transferRisk  被其他战队挖角的倾向（>1 更容易被报价）
 *  moraleFragile 情绪脆弱：拒绝报价等事件里掉士气更多
 *  voice         该性格标志性的发言口吻（采访时会穿插使用）
 */
export const TRAITS = [
  {
    id: 'bigheart', name: '大心脏', icon: '🫀', tone: 'red',
    desc: '越到关键局越冷静，越是硬仗越稳。',
    growth: 1.0, wageAsk: 1.02,
    voice: '关键局我更兴奋，这种时候我从不手抖。',
  },
  {
    id: 'prodigy', name: '天才少年', icon: '✨', tone: 'gold',
    desc: '天赋惊人，涨球速度远超同龄人。',
    growth: 1.04, wageAsk: 1.06,
    voice: '我知道自己还有一大截没打出来。',
  },
  {
    id: 'grinder', name: '拼命三郎', icon: '🔨', tone: 'blue',
    desc: '训练最狠，成长最稳，从不偷懒。',
    growth: 1.03, wageAsk: 1.0,
    voice: '今天又加练了两个小时，习惯了。',
  },
  {
    id: 'captain', name: '队长型', icon: '🎖', tone: 'gold',
    desc: '天生的领袖，更衣室里的话事人。',
    growth: 1.0, wageAsk: 1.06,
    voice: '这不是我一个人的比赛，是五个人的。',
  },
  {
    id: 'streaky', name: '神经刀', icon: '⚡', tone: 'purple',
    desc: '上限极高，但状态起伏也大，胜负常系于他一人。',
    growth: 1.0, wageAsk: 1.0,
    voice: '今天手感来了，对面谁上都一样。',
  },
  {
    id: 'peacemaker', name: '老好人', icon: '🕊', tone: 'green',
    desc: '更衣室润滑剂，队内矛盾到他这里就化了。',
    growth: 0.99, wageAsk: 0.94,
    voice: '大家坐下来聊聊就好了，没什么过不去的。',
  },
  {
    id: 'hothead', name: '刺头', icon: '🔥', tone: 'red',
    desc: '实力在线，但脾气火爆，续约与情绪管理都是麻烦。',
    growth: 1.0, wageAsk: 1.18, moraleFragile: true,
    voice: '我打得没问题，问题从来不在我这边。',
  },
  {
    id: 'steady', name: '稳健派', icon: '🧱', tone: 'blue',
    desc: '极少失误，意识和英雄池都扎实。',
    growth: 0.99, wageAsk: 1.0,
    voice: '稳一点，别急，机会总会有的。',
  },
  {
    id: 'glass', name: '玻璃人', icon: '🩹', tone: 'purple',
    desc: '技术华丽，但身体是隐患，健康时无可阻挡。',
    growth: 1.01, wageAsk: 0.98,
    voice: '只要我健康，就没人能限制我。',
  },
  {
    id: 'ambitious', name: '野心家', icon: '🎯', tone: 'gold',
    desc: '极度渴望荣誉，打出身价就想走，留人成本高。',
    growth: 1.02, wageAsk: 1.12, transferRisk: 1.8,
    voice: '我是来拿冠军的，不是来陪跑的。',
  },
];

export const TRAIT_BY_ID = Object.fromEntries(TRAITS.map((t) => [t.id, t]));

/** 给一名球员分配性格（确定性，只认 id）。已分配过的原样返回。返回该球员。 */
export function assignTrait(player) {
  if (!player) return null;
  if (player.trait && TRAIT_BY_ID[player.trait]) {
    if (!Array.isArray(player.history)) player.history = [{ s: 0, o: player.overall }];
    return player;
  }
  const trait = pickBy(TRAITS, `trait:${player.id}`);
  player.trait = trait.id;
  if (!Array.isArray(player.history)) {
    player.history = [{ s: 0, o: player.overall }];
  }
  return player;
}

/** 给整份存档补齐性格与成长历史（老档兼容 / 新建档统一入口） */
export function ensureTraits(game) {
  if (!game || !game.players) return game;
  for (const p of Object.values(game.players)) assignTrait(p);
  return game;
}

export const traitOf = (player) => (player && TRAIT_BY_ID[player.trait]) || null;

export function traitGrowthMul(player) {
  const t = traitOf(player);
  return t ? (t.growth ?? 1) : 1;
}

export function traitWageMul(player) {
  const t = traitOf(player);
  return t ? (t.wageAsk ?? 1) : 1;
}

export function traitTransferRisk(player) {
  const t = traitOf(player);
  return t ? (t.transferRisk ?? 1) : 1;
}

export function traitMoraleFragile(player) {
  const t = traitOf(player);
  return !!(t && t.moraleFragile);
}

/* ══════════════════════════ 2. 成长弧 ══════════════════════════ */

export const ARCS = {
  rising: { key: 'rising', label: '冉冉新星', icon: '🌱', tone: 'green', desc: '年轻且仍在涨球，上限还远没到。' },
  breakout: { key: 'breakout', label: '一飞冲天', icon: '🚀', tone: 'gold', desc: '本赛季能力大幅跃升，身价水涨船高。' },
  realized: { key: 'realized', label: '兑现天赋', icon: '💎', tone: 'blue', desc: '天赋基本兑现，已是球队可以倚仗的一线选手。' },
  prime: { key: 'prime', label: '当打之年', icon: '⚔️', tone: '', desc: '状态稳定在个人巅峰区间。' },
  veteran: { key: 'veteran', label: '宝刀未老', icon: '🏅', tone: 'gold', desc: '高龄仍保持顶级水准，靠意识续命。' },
  twilight: { key: 'twilight', label: '生涯暮年', icon: '⏳', tone: '', desc: '已进入职业生涯尾声，下滑不可逆。' },
  slump: { key: 'slump', label: '状态下滑', icon: '📉', tone: 'red', desc: '能力出现明显回落，是时候考虑换血了。' },
  bust: { key: 'bust', label: '伤仲永', icon: '🥀', tone: 'red', desc: '天赋很高却迟迟没有兑现，令人惋惜。' },
};

/** 根据成长历史 + 年龄 + 潜力推断球员当前的成长弧 */
export function arcOf(player) {
  const h = (player && player.history) || [];
  const last = h[h.length - 1];
  const prev = h[h.length - 2];
  const delta = last && prev ? last.o - prev.o : 0;
  const room = Math.max(0, (player.potential ?? player.overall) - player.overall);
  const age = player.age ?? 22;

  if (age >= 30) return ARCS.twilight;
  if (age >= 28 && player.overall >= 80) return ARCS.veteran;
  if (delta <= -4) return ARCS.slump;
  if (delta >= 5) return ARCS.breakout;
  if (age <= 20 && delta > 0) return ARCS.rising;
  if (room >= 8 && age >= 24) return ARCS.bust;
  if (room <= 3 && age <= 23 && player.overall >= 78) return ARCS.realized;
  return ARCS.prime;
}

/** 成长历史里的最近 N 个点（用于界面画迷你曲线） */
export function growthSeries(player, n = 6) {
  const h = (player && player.history) || [];
  return h.slice(-n);
}

/* ══════════════════════════ 3. 采访发言 ══════════════════════════ */

/** 通用发言池：按场景划分 */
const QUOTES = {
  win: [
    '这一场我们把训练里的东西打出来了，赢下来是应该的。',
    '对手很强，但我们准备得更充分，细节做对了。',
    '团队配合比个人发挥更重要，今天每个人都到位了。',
    '赢是赢了，但我还有几个失误，回去还得复盘。',
    '感谢队友把节奏带起来，我只是做了该做的事。',
  ],
  lose: [
    '输球的责任在我，几个关键团我没处理好。',
    '我们输在细节，回去把这几个问题一个个解决。',
    '对手的准备比我们更足，这一场输得不冤。',
    '心态有点急，越急越打不出东西，这是我们要改的。',
    '没关系，系列赛还长，下一场再来。',
  ],
  mvp: [
    '今天状态不错，但这是全队的功劳。',
    '能拿到全场最佳，是因为队友把机会留给了我。',
    '数据不重要，能赢才是最重要的。',
    '练了很久的东西终于打出来了，很开心。',
  ],
  title: [
    '这个冠军属于整支队伍，属于所有支持我们的人。',
    '我们等这个冠军等太久了，今天终于做到了。',
    '奖杯很重，但更重的是这一路走来队友的信任。',
    '拿了冠军也不能停，下一个目标已经开始了。',
  ],
  sign: [
    '很高兴加入这支队伍，我会尽快融入体系。',
    '这里的氛围很好，教练组给了我明确的定位。',
    '选择这里，是因为我看到了争冠的可能。',
    '感谢新东家的信任，我会用表现回报。',
  ],
  youth: [
    '终于等到上调一队的机会，我一定不会浪费。',
    '在青训营练了很久，就等着这一刻。',
    '先别急着夸我，我还有很多要学的。',
  ],
  slump: [
    '状态确实不好，是我不够努力，我会加练。',
    '我不找借口，下滑就是下滑，得自己爬出来。',
    '年龄上来了，得换一种打法，我在适应。',
  ],
  rumor: [
    '外面的消息我不看，我现在的重心只在这支队伍。',
    '合同的事交给经纪人，我只负责打好比赛。',
    '如果有更适合争冠的地方，我确实会考虑。',
  ],
  season: [
    '这一季有遗憾，但方向是对的。',
    '我们离目标还差一点，下个赛季补上。',
    '感谢这个赛季每一个并肩作战的人。',
  ],
};

/**
 * 生成一句符合球员性格的发言
 * @param {object} player  球员
 * @param {string} situation win|lose|mvp|title|sign|youth|slump|rumor|season
 * @param {string} salt    额外种子（例如赛季号），让同一场景在不同赛季略有变化
 */
export function pickQuote(player, situation = 'season', salt = '') {
  if (!player) return '';
  const trait = traitOf(player);
  const pool = QUOTES[situation] || QUOTES.season;
  // 一半概率用性格专属语气，让"人设"更明显
  const useVoice = trait && hash32(`voice:${player.id}:${situation}:${salt}`) % 100 < 55;
  const base = useVoice ? trait.voice : pickBy(pool, `q:${player.id}:${situation}:${salt}`);
  return `「${base}」——${player.name}`;
}

/** 从球员数组里挑出综合最高的一位（用于赛后最佳） */
export function bestOf(players) {
  return players.slice().sort((a, b) => (b?.overall || 0) - (a?.overall || 0))[0] || null;
}

/**
 * 某场比赛结束后，给玩家的队伍配一条赛后采访
 * @param {object} game
 * @param {object} series  比赛结果（需含 winnerId）
 * @param {object} opts    { title:boolean } 是否为夺冠场次
 */
export function matchQuote(game, series, opts = {}) {
  if (!game || !series) return null;
  const pid = game.userTeamId;
  if (series.a !== pid && series.b !== pid) return null;
  const sq = game.squads[pid];
  const starters = (sq?.starters || []).map((id) => game.players[id]).filter(Boolean);
  const star = bestOf(starters);
  if (!star) return null;
  const won = series.winnerId === pid;
  const situation = opts.title ? 'title' : won ? 'win' : 'lose';
  return {
    playerId: star.id,
    playerName: star.name,
    trait: star.trait,
    won,
    text: pickQuote(star, situation, `s${game.season}:${series.matchId || series.a}`),
  };
}

/** 汇总一名球员的"档案"数据，供球员详情弹窗使用 */
export function playerStory(game, playerId) {
  const p = game.players[playerId];
  if (!p) return null;
  assignTrait(p);
  const trait = traitOf(p);
  const arc = arcOf(p);
  return {
    player: p,
    trait,
    arc,
    history: growthSeries(p, 6),
    quotes: [
      pickQuote(p, 'season', `s${game.season}`),
      pickQuote(p, arc.tone === 'red' ? 'slump' : 'mvp', `s${game.season}`),
    ],
  };
}
