/**
 * 战队与选手的运行时模型
 * 数据表是静态的，这里是存档里的动态状态（战力、士气、合同、疲劳）
 */
import { PLAYERS, PLAYER_BY_ID, ROLE_ORDER, ROLE_WEIGHTS, squadOf } from '../data/players.js';
import { TEAMS, TEAM_BY_ID, STYLES } from '../data/teams.js';
import { FATIGUE } from '../core/constants.js';
import { assignTrait } from './story.js';

/** 版本 meta：每个赛季换一次，影响英雄池与战术风格权重 */
export const META_VERSIONS = [
  { id: 'v1', name: 'S45 月照长安', note: '中期团战版本，打野节奏权重大', styleBonus: { aggro: 4, macro: 2, protect: -2, flex: 1, late: 0 }, roleWeight: { jungle: 1.08, mid: 1.02, top: 1.0, adc: 0.96, support: 0.94 } },
  { id: 'v2', name: 'S46 星火燎原', note: '射手装备加强，四保一回潮', styleBonus: { aggro: 0, macro: 1, protect: 5, flex: 1, late: 2 }, roleWeight: { jungle: 0.98, mid: 1.0, top: 1.02, adc: 1.12, support: 0.92 } },
  { id: 'v3', name: 'S47 长夜将至', note: '野区改动，前期入侵收益暴涨', styleBonus: { aggro: 6, macro: -1, protect: -3, flex: 2, late: -2 }, roleWeight: { jungle: 1.14, mid: 1.04, top: 1.0, adc: 0.94, support: 0.9 } },
  { id: 'v4', name: 'S48 万流归宗', note: '平衡版本，英雄池深的队伍吃香', styleBonus: { aggro: 1, macro: 3, protect: 1, flex: 6, late: 3 }, roleWeight: { jungle: 1.0, mid: 1.02, top: 1.02, adc: 1.02, support: 1.0 } },
];

/** 教练战术风格的版本契合度 */
export function styleFit(style, meta) {
  return meta.styleBonus[style] ?? 0;
}

/** 计算一名选手在当前 meta 下的位置战力 */
export function playerPower(player, meta) {
  const w = ROLE_WEIGHTS[player.role];
  const raw = player.laning * w.laning + player.macro * w.macro
    + player.teamfight * w.teamfight + player.champPool * w.champPool;
  const rw = meta ? (meta.roleWeight[player.role] ?? 1) : 1;
  return raw * rw;
}

/** 首发五人（数组） */
export function startersOf(game, teamId) {
  const ids = game.squads[teamId]?.starters || [];
  return ids.map((id) => game.players[id]).filter(Boolean);
}

/**
 * 战队战力：首发五人战力 + 默契 + 教练版本契合 + 士气 + 疲劳
 * 这是所有比赛模拟的唯一输入，方便调平衡。
 */
export function teamPower(game, teamId, opts = {}) {
  const starters = startersOf(game, teamId);
  if (!starters.length) return 45;
  const meta = META_VERSIONS[game.season - 1] || META_VERSIONS[0];
  const base = starters.reduce((s, p) => s + playerPower(p, meta), 0) / starters.length;
  const missing = 5 - starters.length;
  const team = game.teams[teamId];
  const chem = (game.chemistry[teamId] ?? 72) - 72;         // 默契：-22 ~ +18
  const fit = styleFit(team.style, meta);                    // 版本契合：-3 ~ +6
  const morale = (game.morale[teamId] ?? 70) - 70;           // 士气
  const fatigue = (game.fatigue[teamId] ?? 0) * -FATIGUE.perPower; // 疲劳惩罚（跑商务的代价）
  const coach = (team.coachLevel ?? 70) - 70;                // 教练水平
  return base
    + chem * 0.16
    + fit * 0.9
    + morale * 0.10
    + coach * 0.06
    + fatigue
    - missing * 6;
}

/** 战队心态（决胜局用）：取首发 teamfight 与士气加权 */
export function teamMentality(game, teamId) {
  const starters = startersOf(game, teamId);
  if (!starters.length) return 55;
  const tf = starters.reduce((s, p) => s + p.teamfight, 0) / starters.length;
  return tf * 0.7 + (game.morale[teamId] ?? 70) * 0.3;
}

/** 从静态数据生成一支队伍的运行时对象 */
export function makeTeamRuntime(staticTeam, season = 1) {
  const meta = META_VERSIONS[season - 1] || META_VERSIONS[0];
  return {
    ...staticTeam,
    coachLevel: 60 + (staticTeam.tier === 'S' ? 16 : staticTeam.tier === 'A' ? 8 : 2),
    metaId: meta.id,
  };
}

/** 初始 18 队运行时 + 名册 */
export function buildInitialWorld() {
  const teams = {};
  const squads = {};
  const players = {};
  for (const t of TEAMS) {
    teams[t.id] = makeTeamRuntime(t, 1);
    const s = squadOf(t.id);
    squads[t.id] = {
      starters: s.starters.map((p) => p.id),
      bench: s.bench.map((p) => p.id),
      youth: s.youth.map((p) => p.id),
    };
    for (const p of s.all) players[p.id] = assignTrait({ ...p });
  }
  return { teams, squads, players };
}

export { ROLE_ORDER, ROLE_WEIGHTS, PLAYERS, PLAYER_BY_ID, TEAMS, TEAM_BY_ID, STYLES, squadOf };
