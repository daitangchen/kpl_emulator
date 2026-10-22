/**
 * KPL 战队经营模拟器 —— 主控制器
 */
import { TEAMS, TEAM_BY_ID, DIFFICULTY, STYLES } from '../data/teams.js';
import { PLAYERS, ROLE_ORDER } from '../data/players.js';
import { createGame, advanceOnce, saveGame, loadGame, hasSave, clearSave } from '../core/state.js';
import { currentStage, nextStage, beginNextSeason, beginOffseason, overallRanking, divisionOfTeam, annualStandings, finalLeaguePlacements, finalsBoard } from '../sim/season.js';
import { rankTeams } from '../sim/groups.js';
import { META_VERSIONS, teamPower } from '../sim/team.js';
import { FINANCE, REGULAR_ROUNDS, FAILURE_RULES, FINALS_RULES, leagueShareForRank } from '../core/constants.js';
import { resolveEvent } from '../sim/events.js';
import { signPlayer, acceptOffer, rejectOffer, investYouth, setStarter, teamWageBill, wageCap, projectedIncome, wageForTeam } from '../sim/transfer.js';
import { marketValue } from '../sim/develop.js';
import { TRAIT_BY_ID, traitOf, arcOf, playerStory, matchQuote, growthSeries } from '../sim/story.js';
import {
  createDraft, drawRole, drawAll, reroll, rerollCost, draftReady, draftStarters, draftSummary, rarityOf, RARITIES,
} from '../sim/draft.js';
import { createRng } from '../core/rng.js';
import {
  ATTRS, ATTR_BY_KEY, TEAM_PLANS, SEASON_CAP_PER_ATTR, SEASON_CAP_TOTAL, TEAM_CAP, SERIES_ADJUST,
  trainAttr, trainTeam, trainAllAttrs, attrCost, teamCost, remainingFor, recommendTrain, seasonTrainingSpend,
} from '../sim/training.js';
import {
  ACTIVITIES, doBusiness, canDoBusiness, activityCash, businessUsed, businessIncome,
  remainingBusiness, fatiguePenalty,
} from '../sim/business.js';
import { FATIGUE } from '../core/constants.js';
import { HEROES, HERO_BY_ID, POSITIONS, heroesByPos, TIER_LABEL, STYLE_LABEL } from '../data/heroes.js';
import { metaRecommendation, teamBpHabit } from '../sim/lineup.js';
import { h, clear, modal, closeModal, toast, teamShort, ROLE_LABEL, divBadge } from './dom.js';
import { eventsFromResult, newSeasonEvent, cashWarning, boardWarning } from './events.js';
import { playPeakBgm, stopBgm, toggleBgm, bgmEnabled } from './bgm.js';

const ROLE_NAME = { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' };
const ROLE_ICON = { top: '🛡', jungle: '🌲', mid: '✦', adc: '🏹', support: '🧭' };

const state = {
  game: null,
  tab: 'office',
  log: [],              // 待展示的事件流
  cursor: 0,            // 当前展示到第几条
  seriesStage: {},      // BO7/BO9 分段进度
  peakPicks: null,      // 巅峰对决 BP 的选人 { top, jungle, mid, adc, support }
  peakFor: null,        // 当前 BP 对应的事件引用（用于判断是否首次进入）
  pendingSeasonEnd: false,
  offseason: null,      // 休赛期数据（成长/新秀/市场）
  offseasonStage: 'develop',
};

/* ══════════════════════════ 引导 / 建队 ══════════════════════════ */
/** 抽卡随机种子：正常游玩用时间戳（每局都不一样）；测试可固定成常量以保证可复现 */
let draftSeedOverride = null;

function renderStart() {
  const screen = document.getElementById('screen');
  clear(screen);
  screen.classList.remove('locked');   // 建队页内容较长，保持可滚动
  document.getElementById('topbar').innerHTML = '';
  document.getElementById('tabbar').innerHTML = '';

  let pickedTeam = null;
  let draft = null;
  // 抽卡在建档之前发生，用一个独立随机源，不写入存档
  const draftRng = createRng(draftSeedOverride === null
    ? (((Date.now() >>> 0) ^ 0x9e3779b9) >>> 0)
    : (draftSeedOverride >>> 0));

  const grid = h('div', { class: 'team-pick' });
  const detail = h('div', { class: 'mt' });

  const rarityBadge = (player) => {
    const r = rarityOf(player);
    return h('span', { class: `rarity tone-${r.tone}`, text: `${'★'.repeat(r.stars)} ${r.key}` });
  };

  const renderDetail = () => {
    clear(detail);
    if (!pickedTeam) {
      detail.append(h('p', { class: 'dim', text: '先选一支战队。档位只影响初始预算，起步一律从 B 组开始。' }));
      return;
    }
    if (!draft) draft = createDraft();

    const budgetLeft = () => pickedTeam.budget - draft.spent;
    const refresh = () => { renderDetail(); renderStartFooter(); };
    const drawFor = (role) => { drawRole(draftRng, draft, role); refresh(); };
    const rerollFor = (role) => {
      const r = reroll(draftRng, draft, role, budgetLeft());
      if (!r.ok) return toast(r.reason);
      return refresh();
    };

    const card = h('div', { class: 'card' }, [
      h('div', { class: 'card-title' }, [
        `${pickedTeam.name} · 抽卡建队`,
        h('span', { class: 'tag pill', text: `已花费 ${draft.spent} 万` }),
      ]),
      h('p', { class: 'mute', text: '五个位置各抽一次，球员从全联盟卡池随机产生。不满意可重抽：前 3 次免费，之后消耗资金。' }),
      h('p', { class: 'mute', text: '分档按该位置的相对水平划分：SSR 传说 8% · SR 史诗 30% · R 稀有 36% · N 普通 26%；连抽两次没出史诗及以上，下一次保底史诗。' }),
    ]);

    for (const role of ROLE_ORDER) {
      const id = draft.slots[role];
      const p = id ? PLAYERS.find((x) => x.id === id) : null;
      const row = h('div', { class: 'draft-row' }, [h('div', { class: 'draft-role', text: ROLE_NAME[role] })]);
      if (!p) {
        row.append(h('button', { class: 'gold small', text: '抽卡', onClick: () => drawFor(role) }));
      } else {
        row.append(
          h('div', { class: 'draft-card' }, [
            h('div', { class: 'row between' }, [
              h('b', { text: p.name }),
              h('span', { class: 'draft-ovr', text: String(p.overall) }),
            ]),
            h('div', { class: 'mute', style: { fontSize: '11px' }, text: `${TEAM_BY_ID[p.teamId]?.short || p.teamId} · 年薪 ${p.wage} 万` }),
          ]),
          rarityBadge(p),
        );
        const cost = rerollCost(draft);
        row.append(h('button', {
          class: 'small',
          text: cost > 0 ? `重抽 ${cost} 万` : '重抽·免费',
          disabled: cost > 0 && budgetLeft() < cost,
          onClick: () => rerollFor(role),
        }));
      }
      card.append(row);
    }

    const sum = draftSummary(draft);
    const openCount = ROLE_ORDER.filter((r) => !draft.slots[r]).length;
    const info = h('div', { class: 'card hi' }, [
      h('div', { class: 'row between' }, [
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '首发战力' }), h('div', { class: 'v', text: sum.players.length ? String(sum.avg) : '—' })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '首发年薪' }), h('div', { class: 'v', text: `${sum.wage} 万` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '可用预算' }), h('div', { class: 'v', text: `${budgetLeft()} 万` })]),
      ]),
      Object.keys(sum.counts).length
        ? h('div', { class: 'row wrap mt', style: { gap: '6px' } }, RARITIES
          .filter((r) => sum.counts[r.key])
          .map((r) => h('span', { class: `rarity tone-${r.tone}`, text: `${r.key} ×${sum.counts[r.key]}` })))
        : null,
      openCount ? h('button', {
        class: 'small block mt',
        text: `一键抽满剩余 ${openCount} 个位置`,
        onClick: () => { drawAll(draftRng, draft); refresh(); },
      }) : null,
    ]);

    detail.append(card, info);
  };

  let footer = h('div', { class: 'mt' });
  const renderStartFooter = () => {
    clear(footer);
    const ready = !!(pickedTeam && draft && draftReady(draft));
    const openCount = pickedTeam && draft ? ROLE_ORDER.filter((r) => !draft.slots[r]).length : 5;
    footer.append(h('button', {
      class: 'primary block',
      text: ready
        ? `就任 ${pickedTeam.name} 总经理，开始第 1 赛季`
        : (!pickedTeam ? '请选择战队' : `还需抽 ${openCount} 个位置`),
      disabled: !ready,
      onClick: () => {
        try {
          const g = createGame({
            userTeamId: pickedTeam.id,
            starterIds: draftStarters(draft),
            draftSpend: draft.spent,
          });
          state.game = g;
          saveGame(g);
          state.tab = 'office';
          state.log = [];
          state.cursor = 0;
          state.pendingSeasonEnd = false;
          state.offseason = null;
          renderShell();
          toast(`已就任 ${pickedTeam.name} 总经理，第 1 赛季从 B 组开始`);
        } catch (err) {
          console.error('建队失败', err);
          toast(`建队失败：${err.message}`);
        }
      },
    }));
  };

  for (const t of TEAMS) {
    const d = DIFFICULTY[t.tier];
    const opt = h('button', {
      class: 'team-opt',
      onClick: () => {
        pickedTeam = t;                     // 保存整支战队对象（历史 bug：这里曾误存 t.id，导致读 .name/.budget 崩溃）
        draft = createDraft();              // 换队即重置抽卡
        for (const el of grid.children) el.classList.toggle('on', el.dataset.id === t.id);
        renderDetail();
        renderStartFooter();
      },
    }, [
      h('div', { class: 'nm', text: t.name }),
      h('div', { class: 'mt-line' }, [h('span', { class: 'stars', text: '★'.repeat(d.stars) + '☆'.repeat(5 - d.stars) }), ` ${d.label}`]),
      h('div', { class: 'mt-line', text: `${t.city} · 预算 ${t.budget} 万` }),
    ]);
    opt.dataset.id = t.id;
    grid.append(opt);
  }

  screen.append(
    h('h1', { text: 'KPL 战队经营模拟器' }),
    h('p', { class: 'dim', text: '你是老板兼总经理。四个赛季，从 B 组泥潭往上爬，一边别让俱乐部先破产。' }),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '规则速览' }),
      h('p', { class: 'mute', text: '· 18 支真实 KPL 战队，全程包含春季赛 → 挑战者杯 → 夏季赛 → 年度总决赛' }),
      h('p', { class: 'mute', text: '· 常规赛 BO5 一次出最终比分；淘汰赛 BO7 分段推进，3-3 触发巅峰对决；挑杯决赛为 BO9' }),
      h('p', { class: 'mute', text: '· 第 1 赛季一律从 B 组出发；B 组后四名提前结束赛季' }),
      h('p', { class: 'mute', text: '· 资金断裂或连续两季排名倒数三 → 强制结束；硬上限四个赛季' }),
    ]),
    h('h2', { text: '选择战队' }),
    grid,
    detail,
    footer,
  );
  renderDetail();
  renderStartFooter();
}

/* ══════════════════════════ 外壳 ══════════════════════════ */

/**
 * 渲染目标：默认写入 #screen。
 * 二分布局下，"决策"区的内容会被渲染进左侧上方面板，其余侧栏另行渲染。
 */
let renderTarget = null;
function screenEl() { return renderTarget || document.getElementById('screen'); }

/** 分栏布局的宽度门槛：宽屏才一分为二，窄屏让底部页签切换整页 */
const SPLIT_MIN_WIDTH = 900;
let viewportWidth = null;   // 测试可注入；浏览器里用真实窗口宽度
function useSplitLayout() {
  const w = viewportWidth ?? ((typeof window !== 'undefined' && window.innerWidth) || 1440);
  return w >= SPLIT_MIN_WIDTH;
}
const TABS = [
  { id: 'office', icon: '🏢', label: '办公室' },
  { id: 'roster', icon: '👥', label: '阵容' },
  { id: 'training', icon: '🏋', label: '训练' },
  { id: 'league', icon: '📊', label: '积分榜' },
  { id: 'finance', icon: '💰', label: '财务' },
  { id: 'career', icon: '🏆', label: '生涯' },
];

function renderTopbar() {
  const g = state.game;
  const bar = document.getElementById('topbar');
  clear(bar);
  if (!g) return;
  const stage = currentStage(g);
  const div = divisionOfTeam(g, g.userTeamId);
  const rank = overallRanking(g, { strict: false }).find((r) => r.id === g.userTeamId);
  bar.append(
    h('div', { class: 'tb-row' }, [
      h('span', { class: 'tb-team', text: TEAM_BY_ID[g.userTeamId].name }),
      h('span', { class: 'tb-div', text: `${div} 组` }),
      h('span', { class: 'tb-stage', text: stage ? `${stage.eventName} · ${stage.roundName || stage.label || ''}` : '赛季结束' }),
      h('button', {
        class: 'tb-bgm',
        title: '背景音乐（巅峰对决时播放）',
        text: bgmEnabled() ? '🔊' : '🔇',
        onClick: () => { toggleBgm(); renderShell(); },
      }),
    ]),
    h('div', { class: 'tb-stats' }, [
      h('span', { class: g.cash < 0 ? 'danger' : '' }, ['现金 ', h('b', { text: `${Math.round(g.cash)} 万` })]),
      h('span', ['声望 ', h('b', { text: Math.round(g.fame) })]),
      h('span', ['第 ', h('b', { text: String(g.season) }), ' / ', String(g.seasonLimit), ' 赛季']),
      rank ? h('span', { class: rank.rank >= 15 ? 'danger' : rank.rank <= 6 ? 'good' : '' }, ['排名 ', h('b', { text: `#${rank.rank}` })]) : null,
    ]),
  );
}

function renderTabbar() {
  const bar = document.getElementById('tabbar');
  clear(bar);
  for (const t of TABS) {
    bar.append(h('button', {
      class: state.tab === t.id ? 'on' : '',
      onClick: () => { state.tab = t.id; renderShell(); },
    }, [h('span', { class: 'ico', text: t.icon }), t.label]));
  }
}

/**
 * 工作台外壳（一屏到底，无整页滚动）
 *
 * 三个角落常驻，中间主区域（工作台）由底部页签切换：
 *
 *   ┌──────────────────────┬──────────────┐
 *   │  工作台（页签切换）    │  战斗情况      │   ← 右上角常驻
 *   │  办公室/阵容/训练/     │              │
 *   │  积分榜/财务/生涯      │              │
 *   ├──────────────────────┼──────────────┤
 *   │  积分榜 / 对阵图       │  下一步·推进   │   ← 右下角常驻
 *   │  （左下角常驻）        │              │
 *   └──────────────────────┴──────────────┘
 *
 *  - 不再有独立的"决策栏"：推进按钮常驻右下角，事件流在当前工作台内展开。
 *  - 窄屏（< 900px）退回单列整页滚动，信息面板附在页尾。
 */
function renderShell() {
  try {
    renderTopbar();
    renderTabbar();
    const screen = document.getElementById('screen');
    clear(screen);
    const g = state.game;
    if (!g) return;

    const isEvent = state.cursor < state.log.length;
    const split = useSplitLayout();

    if (!split) {
      // 窄屏：整页滚动，页签切整页，信息面板附在页尾
      screen.classList.remove('locked');
      renderTarget = screen;
      try {
        if (isEvent) renderEvent(state.log[state.cursor]);
        else renderTabContent();
        if (!isEvent) {
          if (state.tab === 'office') screen.append(renderMatchPanel(), renderSquadPanel(), renderBoardPanel());
          if (state.tab !== 'office') screen.append(renderBoardPanel(), renderNextPanel());
        }
      } finally {
        renderTarget = null;
      }
      return;
    }

    // 宽屏：一屏锁定的 2×2 工作台
    screen.classList.add('locked');
    const workspace = h('div', { class: 'panel panel-workspace' });

    screen.append(h('div', { class: 'workbench' }, [
      workspace,                              // 左上：工作台（页签切换）
      renderMatchPanel(),                     // 右上：战斗情况（常驻）
      renderBoardPanel(),                     // 左下：积分榜/对阵图（常驻）
      renderNextPanel(),                      // 右下：下一步/推进（常驻）
    ]));

    // 工作台内容：有事件先展示事件，否则展示当前页签
    renderTarget = workspace;
    try {
      if (isEvent) renderEvent(state.log[state.cursor]);
      else renderTabContent();
    } finally {
      renderTarget = null;
    }
  } catch (err) {
    // 兜底：任何渲染异常都要在界面上暴露出来，而不是留一片空白
    console.error('渲染失败', err);
    renderTarget = null;
    const screen = document.getElementById('screen');
    clear(screen);
    screen.classList.remove('locked');
    screen.append(h('div', { class: 'card danger' }, [
      h('div', { class: 'card-title', text: '界面渲染出错' }),
      h('p', { class: 'dim', text: err.message }),
      h('p', { class: 'mute', text: '存档可能来自旧版本。可以点下面的按钮修复存档，或重新开始。' }),
      h('div', { class: 'btn-row mt' }, [
        h('button', {
          text: '修复存档并重试',
          onClick: () => {
            const fixed = loadGame();
            if (!fixed) { toast('存档无法修复，请重新开始'); return; }
            state.game = fixed;
            (fixed.__repair?.fixed || []).forEach((f) => console.warn('已修复：', f));
            toast(fixed.__repair?.fixed?.length ? `已修复 ${fixed.__repair.fixed.length} 处问题` : '存档校验通过');
            state.tab = 'office';
            state.log = [];
            state.cursor = 0;
            state.pendingSeasonEnd = false;
            state.offseason = null;
            renderShell();
          },
        }),
        h('button', {
          class: 'gold',
          text: '删除存档，重新开始',
          onClick: () => { clearSave(); state.game = null; renderStart(); },
        }),
      ]),
    ]));
  }
}

/* ══════════════════════════ 推进 ══════════════════════════ */
function progress(action = {}) {
  const g = state.game;
  if (g.gameOver) return;
  try {
    const stage = currentStage(g);
    const stageSnapshot = stage ? { ...stage } : null;
    const r = advanceOnce(g, action);
    const evs = eventsFromResult(g, r, stageSnapshot || stage || {});
    const warn = cashWarning(g);
    state.log = evs;
    state.cursor = 0;
    state.seriesStage = {};
    saveGame(g);
    renderShell();
    if (warn && !evs.some((e) => e.kind === 'info')) {
      // 资金警告作为补充信息，不打断主流程
      setTimeout(() => toast(warn.title), 300);
    }
    if (r.type === 'seasonEnd') state.pendingSeasonEnd = true;
  } catch (err) {
    // 任何引擎异常都要让玩家看见，而不是"点了没反应"
    console.error('推进失败', err);
    toast(`推进失败：${err.message}`);
    saveGame(g);
    renderShell();
  }
}

/* ══════════════════ 决策区页签 ══════════════════ */
function renderTabContent() {
  if (state.tab === 'office') return renderOffice();
  if (state.tab === 'roster') return renderRoster();
  if (state.tab === 'training') return renderTraining();
  if (state.tab === 'league') return renderLeague();
  if (state.tab === 'finance') return renderFinance();
  if (state.tab === 'career') return renderCareer();
  return renderOffice();
}

/* ══════════════════ 左下：积分榜 / 淘汰赛对阵图 ══════════════════ */

/** 当前是否处于淘汰赛阶段（决定左下角显示积分榜还是对阵图） */
function knockoutStage(game) {
  const st = currentStage(game);
  if (st && st.kind === 'bracket' && st.bracket) {
    return { bracket: st.bracket, eventName: st.eventName, label: st.label, championId: st.championId, playerPlacement: st.playerPlacement };
  }
  const last = state.log[state.cursor];
  if (last && last.kind === 'bracket' && last.bracket) {
    return { bracket: last.bracket, eventName: last.stageName, label: last.label, championId: last.championId, playerPlacement: last.playerPlacement };
  }
  return null;
}

function renderBoardPanel() {
  const g = state.game;
  const ko = knockoutStage(g);
  const fb = ko ? null : finalsBoard(g);
  const title = ko ? '淘汰赛对阵图' : fb ? '年总积分榜' : '积分榜 · 近五场';
  const tag = ko ? (ko.eventName || '淘汰赛') : fb ? '大师组 × 精英组' : `第 ${g.season} 赛季`;
  const panel = h('div', { class: 'panel panel-board' }, [
    h('div', { class: 'panel-title' }, [title, h('span', { class: 'tag pill', text: tag })]),
  ]);
  if (ko) {
    panel.append(renderBracketTree(ko.bracket, g));
    if (ko.championId) {
      panel.append(h('p', { class: 'mute mt', text: `冠军：${TEAM_BY_ID[ko.championId]?.name || '-'}${ko.playerPlacement ? `　|　你的名次：第 ${ko.playerPlacement} 名` : ''}` }));
    }
  } else if (fb) {
    // 年总小组赛：大师组 / 精英组两组积分榜并置
    const table = (title2, ids, tb) => h('div', { class: 'board-group' }, [
      h('div', { class: 'board-head' }, [h('b', { text: title2 })]),
      ...rankTeams(ids, tb).map((id, i) => {
        const row = tb?.[id];
        return h('div', { class: `board-row ${id === g.userTeamId ? 'mine' : ''}` }, [
          h('span', { class: 'pos', text: String(i + 1) }),
          h('span', { class: 'nm', text: TEAM_BY_ID[id].short }),
          h('span', { class: 'rec', text: row ? `${row.wins}-${row.losses}` : '—' }),
        ]);
      }),
    ]);
    panel.append(h('div', { class: 'board-split' }, [
      table('大师组', fb.masters, fb.mastersTable),
      table('精英组', fb.elite, fb.eliteTable),
    ]));
  } else {
    // 积分榜与近五场左右并置
    panel.append(h('div', { class: 'board-split' }, [
      renderStandingsCompact(g),
      renderRecentForm(g),
    ]));
  }
  return panel;
}

/** 紧凑积分榜（左下角常驻）：S / A / B 三组并排 */
function renderStandingsCompact(game) {
  const g = game;
  const wrap = h('div', { class: 'board-table' });
  const round = g.groupsByRound[3] ? 3 : g.groupsByRound[2] ? 2 : 1;
  const groups = g.groupsByRound[round] || g.divisionOf;
  const tables = g.tablesByRound[round] || {};
  if (!groups) return wrap;
  for (const d of ['S', 'A', 'B']) {
    const ids = groups[d] || [];
    if (!ids.length) continue;
    const ranked = rankTeams(ids, tables[d]);
    wrap.append(h('div', { class: 'board-group' }, [
      h('div', { class: 'board-head' }, [
        divBadge(d),
        h('b', { text: `${d} 组` }),
        h('span', { class: 'mute', text: `第${round}轮` }),
      ]),
      ...ranked.map((id, i) => {
        const row = tables[d]?.[id];
        return h('div', {
          class: `board-row ${id === g.userTeamId ? 'mine' : ''}`,
          title: `${TEAM_BY_ID[id].name}　${row ? `${row.wins} 胜 ${row.losses} 负（净 ${row.netGames > 0 ? '+' : ''}${row.netGames}）` : '暂无战绩'}`,
        }, [
          h('span', { class: 'pos', text: String(i + 1) }),
          h('span', { class: 'nm', text: TEAM_BY_ID[id].short }),
          h('span', { class: 'rec', text: row ? `${row.wins}-${row.losses}` : '—' }),
        ]);
      }),
    ]));
  }
  return wrap;
}

/** 近五场战绩（左下角常驻）：最近 5 场的胜负与对手 */
function renderRecentForm(g) {
  const list = (g.recentResults || []).slice(0, 5);
  const box = h('div', { class: 'his-sec' }, [h('div', { class: 'his-title', text: '近五场' })]);
  if (!list.length) {
    box.append(h('div', { class: 'mute', text: '本赛季还没有比赛记录。' }));
    return box;
  }
  for (const r of list) {
    box.append(h('div', { class: 'his-h2h' }, [
      h('span', { class: `dot ${r.win ? 'w' : 'l'}`, text: r.win ? '胜' : '负' }),
      h('span', { class: 'nm', text: `vs ${TEAM_BY_ID[r.opp]?.short || r.opp}` }),
      h('span', { class: 'rec', text: `${r.my}-${r.opp}` }),
      r.season ? h('span', { class: 'mute last', text: `S${r.season}` }) : null,
    ]));
  }
  return box;
}

/* ══════════════════ 右下：下一步 / 推进（常驻） ══════════════════ */

/** 当前阶段对应的推进按钮文案 */
function nextActionLabel(g) {
  const stage = currentStage(g);
  if (!stage) return g.gameOver ? '查看生涯' : '推进赛程';
  if (stage.kind === 'group') return `推进 ${stage.eventName} ${stage.roundName}（第 ${(stage.cursor || 0) + 1} / 5 个比赛日）`;
  if (stage.kind === 'regroup') return '查看 S/A/B 重组结果';
  if (stage.kind === 'card') return '进行卡位赛';
  if (stage.kind === 'bracket') return `推进 ${stage.eventName}${stage.label ? ' · ' + stage.label : ''}（第 ${stage.day} 个比赛日）`;
  if (stage.kind === 'finals') return `推进 ${stage.eventName}`;
  return '推进赛程';
}

/** 右下角常驻面板：下一步 / 推进，或赛季结算 / 游戏结束的收尾动作 */
function renderNextPanel() {
  const g = state.game;
  const panel = h('div', { class: 'panel panel-next' }, [
    h('div', { class: 'panel-title' }, ['下一步', h('span', { class: 'tag pill', text: currentStage(g)?.eventName || '赛季' })]),
  ]);

  // 事件还没看完时：右下角也放一个真正可点的「继续」（与事件流里的「继续」等价）
  // 这样用户无论在事件流底部、还是在右下角点，都能推进，不会点到 disabled 占位符而"没反应"。
  if (state.cursor < state.log.length) {
    panel.append(h('button', {
      class: 'primary block',
      text: '继续',
      onClick: () => { state.cursor += 1; renderShell(); },
    }));
    return panel;
  }

  if (g.gameOver) {
    panel.append(
      h('button', { class: 'gold block', text: '查看生涯回顾', onClick: () => { state.tab = 'career'; renderShell(); } }),
    );
    return panel;
  }

  if (state.pendingSeasonEnd) {
    const summary = g.history[g.history.length - 1];
    panel.append(
      h('p', { class: 'mute', text: `第 ${g.season} 赛季结算完成：第 ${summary.rank} 名，净收支 ${summary.net > 0 ? '+' : ''}${summary.net} 万。` }),
      h('button', {
        class: 'primary block mt',
        text: g.season >= g.seasonLimit ? '查看生涯结局' : '进入休赛期',
        onClick: () => {
          state.pendingSeasonEnd = false;
          if (g.season >= g.seasonLimit) {
            const nx = beginNextSeason(g);
            state.log = [{ kind: 'gameOver', gameOver: nx.gameOver || { reason: 'complete', title: '四个赛季结束', detail: '硬上限到期，进入生涯回顾。' } }];
            state.cursor = 0;
            saveGame(g);
            renderShell();
            return;
          }
          startOffseason();
        },
      }),
    );
    return panel;
  }

  panel.append(
    h('button', { class: 'primary block', text: nextActionLabel(g), onClick: progress }),
  );
  return panel;
}

/* ══════════════════ 右上：战斗情况（常驻） ══════════════════ */

function renderMatchPanel() {
  const g = state.game;
  const panel = h('div', { class: 'panel panel-match' }, [
    h('div', { class: 'panel-title' }, ['战斗情况', h('span', { class: 'tag pill', text: `第 ${g.season} 赛季` })]),
  ]);
  const ev = state.log[state.cursor];
  let mine = (ev && (ev.playerResult || ev.playerMatch?.result)) || null;
  if (!mine && ev && ev.kind === 'seriesPause' && ev.series) {
    const s = ev.series;
    mine = { a: ev.match.a, b: ev.match.b, scoreA: s.a, scoreB: s.b, games: s.games };
  }
  if (!mine && ev && ev.playerCard) mine = ev.playerCard;

  if (mine && mine.a) {
    const myIsA = mine.a === g.userTeamId;
    const oppId = myIsA ? mine.b : mine.a;
    const my = myIsA ? mine.scoreA : mine.scoreB;
    const op = myIsA ? mine.scoreB : mine.scoreA;
    panel.append(
      h('div', { class: 'row between' }, [
        h('div', {}, [h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[g.userTeamId].name }), h('div', { class: 'mute', text: '我方' })]),
        h('div', { class: `big ${my > op ? 'green' : my < op ? 'red' : ''}`, text: `${mine.scoreA} : ${mine.scoreB}` }),
        h('div', { style: { textAlign: 'right' } }, [h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[oppId]?.name || oppId }), h('div', { class: 'mute', text: '对手' })]),
      ]),
      mine.games?.length ? renderDotsFor(mine.games, myIsA) : null,
    );
    if (mine.finalScore) panel.append(h('p', { class: 'mute mt', text: `最终比分 ${mine.finalScore}` }));
  } else {
    panel.append(h('p', { class: 'mute', text: '暂无进行中的比赛。点右下角的「推进」开始下一个比赛日。' }));
  }

  const recent = (g.history || []).slice(-1)[0];
  if (recent) {
    panel.append(h('p', { class: 'mute mt', text: `上赛季：第 ${recent.rank} 名 · 净收支 ${recent.net > 0 ? '+' : ''}${recent.net} 万` }));
  }
  const rank = overallRanking(g, { strict: false }).find((r) => r.id === g.userTeamId);
  if (rank) panel.append(h('p', { class: 'mute', text: `当前战绩：#${rank.rank}（${rank.wins} 胜 ${rank.losses} 负）` }));

  // 附上战队状态（战力/现金/声望/疲劳/士气/默契），一眼看清
  panel.append(renderTeamMiniStats(g));
  return panel;
}

/** 战队状态速览（六项指标，附在战斗情况面板底部） */
function renderTeamMiniStats(g) {
  const pid = g.userTeamId;
  const fat = g.fatigue?.[pid] || 0;
  return h('div', { class: 'mini-stats mt' }, [
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '战力' }), h('b', { text: teamPower(g, pid).toFixed(1) })]),
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '现金' }), h('b', { class: g.cash < 0 ? 'red' : 'gold', text: `${Math.round(g.cash)}万` })]),
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '声望' }), h('b', { text: String(Math.round(g.fame)) })]),
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '疲劳' }), h('b', { class: fat > 0 ? 'red' : '', text: `${fat}/${FATIGUE.cap}` })]),
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '士气' }), h('b', { text: String(g.morale[pid] ?? 70) })]),
    h('div', { class: 'ms' }, [h('span', { class: 'k', text: '默契' }), h('b', { text: String(g.chemistry[pid] ?? 72) })]),
  ]);
}

/* ══════════════════ 右下：战队情况（保留，供阵容/窄屏引用） ══════════════════ */

function renderSquadPanel() {
  const g = state.game;
  const pid = g.userTeamId;
  const sq = g.squads[pid] || { starters: [], bench: [], youth: [] };
  const div = divisionOfTeam(g, pid);
  const fat = g.fatigue?.[pid] || 0;
  const panel = h('div', { class: 'panel panel-squad' }, [
    h('div', { class: 'panel-title' }, [
      '战队情况',
      h('span', { class: `tag ${div === 'S' ? 'gold' : ''}`, text: `${div} 组` }),
    ]),
    h('div', { class: 'mini-stats' }, [
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '战力' }), h('b', { text: teamPower(g, pid).toFixed(1) })]),
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '现金' }), h('b', { class: g.cash < 0 ? 'red' : 'gold', text: `${Math.round(g.cash)}万` })]),
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '声望' }), h('b', { text: String(Math.round(g.fame)) })]),
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '疲劳' }), h('b', { class: fat > 0 ? 'red' : '', text: `${fat}/${FATIGUE.cap}` })]),
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '士气' }), h('b', { text: String(g.morale[pid] ?? 70) })]),
      h('div', { class: 'ms' }, [h('span', { class: 'k', text: '默契' }), h('b', { text: String(g.chemistry[pid] ?? 72) })]),
    ]),
  ]);
  const list = h('div', { class: 'squad-list' });
  for (const id of sq.starters || []) {
    const p = g.players[id];
    if (!p) continue;
    list.append(h('div', { class: 'squad-row', onClick: () => openPlayerModal(id) }, [
      h('span', { class: 'role', text: ROLE_NAME[p.role] }),
      h('span', { class: 'nm', text: p.name }),
      h('span', { class: 'ovr', text: String(p.overall) }),
    ]));
  }
  panel.append(list);
  const benchN = (sq.bench || []).length;
  const youthN = (sq.youth || []).length;
  if (benchN || youthN) panel.append(h('p', { class: 'mute mt', text: `替补 ${benchN} 人 · 青训 ${youthN} 人` }));
  return panel;
}

/* ══════════════════════════ 办公室 ══════════════════════════ */
function renderOffice() {
  const g = state.game;
  const screen = screenEl();
  const stage = currentStage(g);
  const div = divisionOfTeam(g, g.userTeamId);
  const rank = overallRanking(g, { strict: false }).find((r) => r.id === g.userTeamId);
  const meta = META_VERSIONS[g.season - 1] || META_VERSIONS[0];
  const power = teamPower(g, g.userTeamId);
  const starterWage = (g.squads[g.userTeamId].starters || []).reduce((s, id) => s + (g.players[id]?.wage || 0), 0);

  // 赛程进度条
  const total = g.stages.length;
  const strip = h('div', { class: 'stage-strip' },
    g.stages.map((s, i) => h('div', { class: `seg ${s.done ? 'done' : i === g.stageIndex ? 'now' : ''}` })));

  // 下一步动作已常驻右下角，这里只做信息概览
  const overview = h('div', { class: 'card hi' }, [
    h('div', { class: 'card-title' }, [h('span', { text: '办公室' }), h('span', { class: 'tag pill gold', text: stage?.eventName || '赛季结束' })]),
    h('p', { class: 'dim', text: stage?.note || stage?.label || '点击右下角的「推进」模拟下一个比赛日。自家战队的比赛会逐场展开，其余比赛直接出比分。' }),
  ]);

  screen.append(
    strip,
    overview,
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '当前版本' }),
      h('p', { class: 'dim', text: `${meta.name} —— ${meta.note}` }),
      h('div', {}, Object.entries(meta.styleBonus).map(([k, v]) => h('span', {
        class: `pill ${v > 0 ? 'green' : v < 0 ? 'red' : ''}`,
        text: `${({ aggro: '前期打架', macro: '运营', protect: '四保一', flex: '灵活多变', late: '后期大团' })[k]} ${v > 0 ? '+' : ''}${v}`,
      }))),
    ]),
    renderLockerRoom(),
  );
}

/** 更衣室动态：展示核心球员的性格、成长弧与一句发言 */
function renderLockerRoom() {
  const g = state.game;
  const sq = g.squads[g.userTeamId];
  const starters = (sq.starters || []).map((id) => g.players[id]).filter(Boolean);
  if (!starters.length) return null;
  const top = starters.slice().sort((a, b) => b.overall - a.overall).slice(0, 3);
  const card = h('div', { class: 'card' }, [
    h('div', { class: 'card-title' }, ['更衣室动态', h('span', { class: 'tag pill', text: `第 ${g.season} 赛季` })]),
    h('p', { class: 'mute', text: '点击球员查看完整档案（性格 / 成长弧 / 采访）。' }),
  ]);
  for (const p of top) {
    card.append(h('div', {
      class: 'locker-row',
      onClick: () => openPlayerModal(p.id),
    }, [
      h('div', { class: 'row between' }, [
        h('b', { text: p.name }),
        h('span', { class: 'mute', text: `${ROLE_NAME[p.role]} · ${p.overall}` }),
      ]),
      h('div', { class: 'row wrap', style: { gap: '4px' } }, [traitPill(traitOf(p)), arcPill(arcOf(p))]),
    ]));
  }
  const starStory = playerStory(g, top[0].id);
  if (starStory?.quotes?.length) {
    card.append(h('p', { class: 'quote mt', text: starStory.quotes[0] }));
  }
  return card;
}


/* ══════════════════════════ 赛果展示 ══════════════════════════ */
function renderEvent(ev) {
  const screen = screenEl();
  const g = state.game;
  const next = () => { state.cursor += 1; renderShell(); };

  const footer = (text = '继续') => h('button', { class: 'primary block mt', text, onClick: next });

  if (ev.kind === 'info') {
    screen.append(
      h('div', { class: `card ${ev.tone === 'danger' ? 'danger' : 'hi'}` }, [
        h('div', { class: 'card-title', text: ev.title }),
        h('p', { class: 'dim', text: ev.text }),
      ]),
      footer(),
    );
    return;
  }

  if (ev.kind === 'matchday') {
    const mine = ev.playerResult;
    const win = mine && mine.winnerId === g.userTeamId;
    const myScore = mine ? (mine.a === g.userTeamId ? mine.scoreA : mine.scoreB) : 0;
    const oppScore = mine ? (mine.a === g.userTeamId ? mine.scoreB : mine.scoreA) : 0;
    const oppId = mine ? (mine.a === g.userTeamId ? mine.b : mine.a) : null;

    const card = h('div', { class: 'card hi' }, [
      h('div', { class: 'card-title' }, [
        `${ev.stageName} ${ev.roundName} · 第 ${ev.day}/${ev.totalDays} 比赛日`,
        h('span', { class: 'tag pill', text: 'BO5' }),
      ]),
    ]);
    if (mine) {
      card.append(
        h('div', { class: 'row between', style: { margin: '6px 0' } }, [
          h('div', { class: 'grow' }, [
            h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[g.userTeamId].name }),
            h('div', { class: 'mute', text: `主场：${TEAM_BY_ID[mine.a].name}` }),
          ]),
          h('div', { class: 'big', style: { color: win ? 'var(--green)' : 'var(--red)' }, text: `${myScore} : ${oppScore}` }),
          h('div', { class: 'grow', style: { textAlign: 'right' } }, [
            h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[oppId].name }),
            h('div', { class: 'mute', text: win ? '我方获胜' : '我方告负' }),
          ]),
        ]),
        renderGameDots(mine, g.userTeamId),
        mine.hadPeakShowdown
          ? h('div', { class: 'peak-banner', text: '★ 决胜局顶住压力，2-2 后拿下最后一局' })
          : null,
        renderInterview(mine),
      );
    } else {
      card.append(h('p', { class: 'dim', text: '本轮没有你的比赛，联盟其余场次结果如下。' }));
    }

    // 其余比赛
    const others = ev.results.filter((r) => !r.isPlayer);
    if (others.length) {
      const list = h('div', { class: 'mt' }, [h('h3', { text: '本轮其他场次' })]);
      for (const r of others) {
        list.append(h('div', { class: 'score-line' }, [
          h('span', { class: 't', text: TEAM_BY_ID[r.a].name }),
          h('span', { class: 'sc', text: `${r.scoreA}-${r.scoreB}` }),
          h('span', { class: 't right', text: TEAM_BY_ID[r.b].name }),
          h('span', { class: 'flag', text: `[${r.division}]` }),
        ]));
      }
      card.append(list);
    }

    if (ev.finished && ev.eliminated?.length) {
      card.append(h('div', { class: 'mt' }, [
        h('h3', { text: 'B 组后四名提前结束赛季' }),
        h('div', {}, ev.eliminated.map((id) => h('span', { class: `pill ${id === g.userTeamId ? 'red' : ''}`, text: TEAM_BY_ID[id].short }))),
      ]));
    }
    screen.append(card, renderMoneyDecision(), renderGroupTable(ev.groups, ev.tables, g), footer('继续'));
    return;
  }

  if (ev.kind === 'regroup') {
    screen.append(
      h('div', { class: 'card hi' }, [
        h('div', { class: 'card-title', text: 'S / A / B 重新分组' }),
        h('p', { class: 'dim', text: '第一轮结束。各组前 2 名进 S 组，3-4 名进 A 组，5-6 名落入 B 组。' }),
      ]),
      ...['S', 'A', 'B'].map((d) => h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [divBadge(d), h('b', { text: `${d} 组` })]),
        h('div', { class: 'mt' }, (ev.groups[d] || []).map((id) => h('span', {
          class: `pill ${id === g.userTeamId ? 'gold' : ''}`,
          text: TEAM_BY_ID[id].name,
        }))),
      ])),
      footer('继续'),
    );
    return;
  }

  if (ev.kind === 'card') {
    const card = h('div', { class: 'card hi' }, [
      h('div', { class: 'card-title' }, ['卡位赛（BO7）', h('span', { class: 'tag pill', text: 'S/A · A/B' })]),
      h('p', { class: 'dim', text: '高组第 5、6 名对阵低组第 2、1 名，BO7 一场定生死，胜者进高组。' }),
    ]);
    for (const c of ev.cards) {
      const involves = c.isPlayer;
      card.append(h('div', { class: `score-line ${involves ? 'mine' : ''}` }, [
        h('span', { class: 't', text: TEAM_BY_ID[c.a].name }),
        h('span', { class: 'sc', text: `${c.scoreA}-${c.scoreB}` }),
        h('span', { class: 't right', text: TEAM_BY_ID[c.b].name }),
      ]));
    }
    if (ev.playerCard) {
      const ok = ev.playerCard.winnerId === g.userTeamId;
      card.append(h('div', { class: 'peak-banner', style: { borderColor: ok ? 'var(--green)' : 'var(--red)' }, text: ok ? '✓ 卡位赛取胜，成功留在/升入高组' : '✗ 卡位赛失利，下轮降入低组' }));
      if (ev.chunks) {
        const pc = ev.playerCard;
        card.append(h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', marginTop: '6px' } }, [
          h('span', { class: 'mute', style: { fontSize: '11px', minWidth: '92px' }, text: `你的 BO${pc.bestOf}` }),
          renderDotsFor(pc.games, true, false),
        ]));
        if (ev.adjustment) card.append(h('div', { class: 'peak-banner', text: `中场调整：${ev.adjustment.text}` }));
        if (ev.lineup) card.append(peakLineupShow(ev.lineup));
      }
    }
    screen.append(card, h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '第三轮分组' }),
      ...['S', 'A', 'B'].map((d) => h('div', { class: 'mt' }, [
        h('div', { class: 'row' }, [divBadge(d), h('b', { text: `${d} 组` })]),
        h('div', {}, (ev.groups[d] || []).map((id) => h('span', { class: `pill ${id === g.userTeamId ? 'gold' : ''}`, text: TEAM_BY_ID[id].short }))),
      ])),
    ]), footer('继续'));
    return;
  }

  if (ev.kind === 'bracket') {
    renderBracketEvent(ev, next);
    return;
  }

  if (ev.kind === 'seriesPause') {
    renderSeriesPause(ev);
    return;
  }

  if (ev.kind === 'arena') {
    const g = state.game;
    const masters = ev.masters || [];
    const elite = ev.elite || [];
    const isMaster = (id) => masters.includes(id);
    const isElite = (id) => elite.includes(id);

    const card = h('div', { class: 'card hi' }, [
      h('div', { class: 'card-title' }, [`年度总决赛 · 小组赛 第 ${ev.day}/6 日`, h('span', { class: 'tag pill', text: '大师组 × 精英组' })]),
      h('p', { class: 'dim', text: '12 队按年度积分分为大师组与精英组，组外单循环 BO5，两组独立排名。' }),
    ]);

    // 本轮对阵（标注大师组/精英组）
    const ms = h('div', { class: 'mt' }, [h('h3', { text: '本轮对阵' })]);
    for (const r of ev.results || []) {
      ms.append(h('div', { class: `score-line ${r.isPlayer ? 'mine' : ''}` }, [
        h('span', { class: 't', text: TEAM_BY_ID[r.a].name }),
        h('span', { class: `flag ${isMaster(r.a) ? 'm' : isElite(r.a) ? 'e' : ''}`, text: isMaster(r.a) ? '大师' : isElite(r.a) ? '精英' : '' }),
        h('span', { class: 'sc', text: `${r.scoreA}-${r.scoreB}` }),
        h('span', { class: `flag ${isMaster(r.b) ? 'm' : isElite(r.b) ? 'e' : ''}`, text: isMaster(r.b) ? '大师' : isElite(r.b) ? '精英' : '' }),
        h('span', { class: 't right', text: TEAM_BY_ID[r.b].name }),
      ]));
    }
    card.append(ms);

    // 两个组别的实时积分榜
    if (ev.tables) {
      const table = (title, ids, tb) => h('div', { class: 'card mt' }, [
        h('div', { class: 'card-title', text: title }),
        ...rankTeams(ids, tb).map((id, i) => {
          const row = tb?.[id];
          return h('div', {
            class: `board-row ${id === g.userTeamId ? 'mine' : ''}`,
          }, [
            h('span', { class: 'pos', text: String(i + 1) }),
            h('span', { class: 'nm', text: TEAM_BY_ID[id].short }),
            h('span', { class: 'rec', text: row ? `${row.wins}胜${row.losses}负` : '—' }),
          ]);
        }),
      ]);
      card.append(
        h('div', { class: 'split mt' }, [
          table('大师组积分榜', masters, ev.tables.masters),
          table('精英组积分榜', elite, ev.tables.elite),
        ]),
      );
    }

    screen.append(card, footer('继续'));
    return;
  }

  if (ev.kind === 'survival') {
    const card = h('div', { class: 'card hi' }, [
      h('div', { class: 'card-title', text: '年度总决赛 · 突围赛（BO7）' }),
      h('p', { class: 'dim', text: '大师组 5、6 名与精英组 2-5 名捉对厮杀，胜者拿到淘汰赛门票。' }),
    ]);
    for (const r of ev.results || []) {
      card.append(h('div', { class: `score-line ${r.isPlayer ? 'mine' : ''}` }, [
        h('span', { class: 't', text: TEAM_BY_ID[r.a].name }),
        h('span', { class: 'sc', text: `${r.scoreA}-${r.scoreB}` }),
        h('span', { class: 't right', text: TEAM_BY_ID[r.b].name }),
      ]));
    }
    screen.append(card, footer('继续'));
    return;
  }

  if (ev.kind === 'seasonEnd') {
    renderSeasonEnd(ev.summary, next);
    return;
  }

  if (ev.kind === 'gameOver') {
    screen.append(
      h('div', { class: 'card danger' }, [
        h('div', { class: 'card-title', text: ev.gameOver.title }),
        h('p', { class: 'dim', text: ev.gameOver.detail }),
      ]),
      h('button', { class: 'gold block mt', text: '查看生涯回顾', onClick: () => { state.cursor = state.log.length; state.tab = 'career'; renderShell(); } }),
    );
    return;
  }

  if (ev.kind === 'newSeason') {
    const g2 = state.game;
    const meta = META_VERSIONS[g2.season - 1] || META_VERSIONS[0];
    screen.append(
      h('div', { class: 'card gold' }, [
        h('div', { class: 'card-title', text: `第 ${ev.season} 赛季开始` }),
        h('p', { class: 'dim', text: `版本更新至 ${meta.name}：${meta.note}` }),
        h('p', { class: 'mute', text: '本赛季预算、阵容与转会窗口已重置；上赛季结束时的组别即为本赛季起点。' }),
      ]),
      footer('开始新赛季'),
    );
    return;
  }

  if (ev.kind === 'eventCard') {
    const card = ev.card;
    const box = h('div', { class: 'card danger' }, [
      h('div', { class: 'card-title' }, [`突发事件 · ${card.title}`, h('span', { class: 'tag pill', text: '必须做出选择' })]),
      h('p', { class: 'dim', text: card.body }),
    ]);
    screen.append(box);
    for (const c of card.choices) {
      screen.append(h('button', {
        class: 'block mt',
        onClick: () => {
          const r = resolveEvent(g, card.id, c.index);
          g.eventPending = null;
          saveGame(g);
          modal({
            title: r.ok ? '结果' : '无法执行',
            body: h('p', { class: 'dim', text: r.ok ? r.text : r.reason }),
            actions: [{ label: '知道了', cls: 'primary', onClick: () => { state.cursor += 1; renderShell(); } }],
          });
        },
      }, [
        h('div', { style: { fontWeight: 700 }, text: c.label }),
        c.detail ? h('div', { class: 'mute', style: { fontSize: '11px' }, text: c.detail }) : null,
      ]));
    }
    return;
  }

  screen.append(h('div', { class: 'card' }, [h('p', { text: '（无内容）' })]), footer());
}

/** 一局一局的小圆点；BO7 按分段揭示 */
function renderGameDots(series, myId) {
  const wrap = h('div', { class: 'games' });
  const stage = state.seriesStage[series.matchId || 'last'] || 1;
  const isMineA = series.a === myId;
  const reveal = () => {
    clear(wrap);
    let limit = series.games.length;
    if (series.bestOf >= 7 && series.wentDecider) {
      limit = stage === 1 ? Math.min(3, series.games.length)
        : stage === 2 ? Math.min(6, series.games.length)
          : series.games.length;
    }
    series.games.slice(0, limit).forEach((gm, i) => {
      const iWon = (gm.winner === 'A') === isMineA;
      const isPeak = series.wentDecider && i === series.games.length - 1;
      wrap.append(h('span', {
        class: `game-dot ${iWon ? 'w' : 'l'} ${isPeak ? 'peak' : ''}`,
        title: `第 ${gm.no} 局`,
        text: iWon ? 'W' : 'L',
      }));
    });
    if (limit < series.games.length) {
      const btn = h('button', {
        class: 'small',
        style: { marginLeft: '6px' },
        text: stage === 1 ? '继续第 4-6 局' : '★ 巅峰对决',
        onClick: () => { state.seriesStage[series.matchId || 'last'] = stage + 1; reveal(); },
      });
      wrap.append(btn);
    }
  };
  reveal();
  return wrap;
}

/** 按分段计划切割系列赛的局（用于"上半场 / 下半场 / 巅峰对决"分组展示） */
function seriesGroups(s) {
  const plan = s.bestOf === 9 ? [4, 7, 8, 9] : s.bestOf === 7 ? [3, 6, 7] : [3];
  const out = [];
  let prev = 0;
  plan.forEach((n, i) => {
    const games = s.games.slice(prev, Math.min(n, s.games.length));
    prev = n;
    if (!games.length) return;
    const label = s.bestOf === 9
      ? ['前 4 局', '第 5-7 局', '第 8 局', '★ 巅峰对决'][i]
      : s.bestOf === 7
        ? ['上半场（1-3 局）', '下半场（4-6 局）', '★ 巅峰对决'][i]
        : '全场';
    out.push({ label, games, peak: i === plan.length - 1 && s.games.length >= n && s.bestOf > 5 });
  });
  return out;
}

/** 一组小圆点 */
function renderDotsFor(games, myIsA, lastIsPeak = false) {
  const wrap = h('div', { class: 'games' });
  games.forEach((gm, i) => {
    const iWon = (gm.winner === 'A') === myIsA;
    wrap.append(h('span', {
      class: `game-dot ${iWon ? 'w' : 'l'} ${lastIsPeak && i === games.length - 1 ? 'peak' : ''}`,
      title: `第 ${gm.no} 局`,
      text: iWon ? 'W' : 'L',
    }));
  });
  return wrap;
}

/** 系列赛上半场结束 → 中场调整窗口；巅峰对决前 → 阵容博弈 */
function renderSeriesPause(ev) {
  if (ev.phase === 'lineup') return renderLineupPause(ev);
  const g = state.game;
  const screen = screenEl();
  const s = ev.series;
  const pid = g.userTeamId;
  const myIsA = ev.match.a === pid;
  const oppId = myIsA ? ev.match.b : ev.match.a;
  const my = myIsA ? s.a : s.b;
  const op = myIsA ? s.b : s.a;
  const half = s.segments[0];

  const card = h('div', { class: 'card hi' }, [
    h('div', { class: 'card-title' }, [
      `${ev.stageName} · ${ev.label}`,
      h('span', { class: 'tag pill', text: `BO${s.bestOf}` }),
    ]),
    h('p', { class: 'dim', text: `上半场（前 ${half} 局）结束。这是你的调整窗口：换人、临场布置，或直接进入下半场。` }),
    h('div', { class: 'row between', style: { margin: '6px 0' } }, [
      h('div', { class: 'grow' }, [
        h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[pid].name }),
        h('div', { class: 'mute', text: my > op ? '领先' : my < op ? '落后' : '战平' }),
      ]),
      h('div', { class: 'big', style: { color: my > op ? 'var(--green)' : my < op ? 'var(--red)' : '' }, text: `${my} : ${op}` }),
      h('div', { class: 'grow', style: { textAlign: 'right' } }, [
        h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[oppId].name }),
        h('div', { class: 'mute', text: '对手' }),
      ]),
    ]),
    renderDotsFor(s.games.slice(0, half), myIsA),
  ]);

  const panel = h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: '中场调整' }),
    h('p', { class: 'mute', text: '换人永久改变首发；临场布置只加成本场剩余局的战力，花的是现金。' }),
  ]);

  const sq = g.squads[pid];
  const swapRows = [];
  for (const role of ROLE_ORDER) {
    const sid = (sq.starters || []).find((id) => g.players[id]?.role === role);
    const sp = sid ? g.players[sid] : null;
    if (!sp) continue;
    const bp = (sq.bench || []).concat(sq.youth || [])
      .map((id) => g.players[id])
      .filter((p) => p && p.role === role)
      .sort((a, b) => b.overall - a.overall)[0];
    if (!bp) continue;
    swapRows.push(h('button', {
      class: 'small',
      text: `换人 ${ROLE_NAME[role]}：${sp.name}(${sp.overall}) → ${bp.name}(${bp.overall})`,
      onClick: () => progress({ series: { type: 'swap', inId: bp.id, outId: sp.id } }),
    }));
  }
  if (swapRows.length) panel.append(h('div', { class: 'btn-col' }, swapRows));
  else panel.append(h('p', { class: 'mute', text: '替补席没有同位置球员可换。' }));

  panel.append(h('button', {
    class: 'small block mt',
    text: `临场布置：花费 ${SERIES_ADJUST.boostCost} 万，本场剩余局战力 +${SERIES_ADJUST.boostGain}（现金 ${Math.round(g.cash)} 万）`,
    disabled: g.cash < SERIES_ADJUST.boostCost,
    onClick: () => progress({ series: { type: 'boost' } }),
  }));
  panel.append(h('button', {
    class: 'primary block mt',
    text: '不做调整，直接进入下半场',
    onClick: () => progress({ series: { type: 'none' } }),
  }));

  screen.append(card, panel);
}

/** 巅峰对决前的阵容博弈（真实 BP）：看版本强势 + 对手 BP 习惯，再逐位置选英雄 */
function renderLineupPause(ev) {
  const g = state.game;
  const screen = screenEl();
  const s = ev.series;
  const pid = g.userTeamId;
  const myIsA = ev.match.a === pid;
  const oppId = myIsA ? ev.match.b : ev.match.a;
  const my = myIsA ? s.a : s.b;
  const op = myIsA ? s.b : s.a;

  // 首次进入本次 BP：清空选人（主动选 5 个，而非"换"默认阵容）+ 播放《冠军杯》音乐
  if (state.peakFor !== ev) {
    state.peakFor = ev;
    state.peakPicks = {};
    playPeakBgm();
  }
  const rec = metaRecommendation();
  const habit = teamBpHabit(g, oppId);
  const picked = POSITIONS.filter((p) => state.peakPicks[p.key]);
  const allPicked = picked.length === POSITIONS.length;

  const card = h('div', { class: 'card gold peak-card' }, [
    h('div', { class: 'card-title' }, ['★ 巅峰对决', h('span', { class: 'tag pill', text: `决胜局（BO${s.bestOf} 第 ${s.bestOf} 局）` })]),
    h('p', { class: 'dim', text: `${my} : ${op} 战平，进入巅峰对决 —— 双方**互不可见**地提交 5 个英雄，且不受全局 BP 限制。` }),
    h('div', { class: 'row between', style: { margin: '6px 0' } }, [
      h('div', { class: 'grow' }, [h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[pid].name }), h('div', { class: 'mute', text: '我方' })]),
      h('div', { class: 'big', text: `${my} : ${op}` }),
      h('div', { class: 'grow', style: { textAlign: 'right' } }, [h('div', { style: { fontWeight: 700 }, text: TEAM_BY_ID[oppId].name }), h('div', { class: 'mute', text: '对手' })]),
    ]),
    // 当前版本强势阵容
    h('div', { class: 'card-title', text: '当前版本强势阵容（KPL 出场率参考）' }),
    h('div', { class: 'peak-meta' }, rec.map((hero) => h('div', { class: 'peak-meta-hero' }, [
      h('div', { class: 'mute', text: POSITIONS.find((p) => p.key === hero.pos)?.name }),
      h('div', { class: 'nm', text: hero.name }),
      h('div', { class: `tag ${hero.tier === 0 ? 'gold' : 'mute'}`, text: `T${hero.tier} · ${hero.rate}%` }),
    ]))),
    // 对手 BP 习惯
    h('div', { class: 'card-title', text: `对手 BP 习惯 · ${TEAM_BY_ID[oppId].name}` }),
    h('p', { class: 'mute', text: `战术风格「${habit.styleName}」，偏好打法「${habit.tendencyName}」—— 大概率往这个方向拿英雄。` }),
    h('div', { class: 'peak-habit' }, habit.signatures.map(({ pos, hero }) => h('div', { class: 'peak-habit-hero' }, [
      h('div', { class: 'mute', text: POSITIONS.find((p) => p.key === pos)?.name }),
      h('div', { class: 'nm', text: hero.name }),
      h('div', { class: 'mute', text: STYLE_LABEL[hero.style] }),
    ]))),
  ]);

  // 逐位置选英雄
  const panel = h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: `逐位置选英雄（已选 ${picked.length}/5）` }),
    h('p', { class: 'mute', text: '克制环：强开团 → 四一分推 → 远程消耗 → 保核反手 → 抓单集火 → 强开团。读对手习惯，拿克制它的一套。' }),
  ]);
  for (const p of POSITIONS) {
    const cur = state.peakPicks[p.key] ? HERO_BY_ID[state.peakPicks[p.key]] : null;
    panel.append(h('div', { class: 'peak-pick-row' }, [
      h('span', { class: 'pos', text: `${p.icon} ${p.name}` }),
      h('div', { class: 'grow' }, cur ? [
        h('b', { text: cur.name }),
        h('span', { class: 'mute', style: { marginLeft: '6px' }, text: `T${cur.tier} · ${cur.rate}% · ${STYLE_LABEL[cur.style]}` }),
      ] : [h('span', { class: 'mute', text: '未选择' })]),
      h('button', { class: 'small', text: '选英雄', onClick: () => openHeroPicker(p) }),
    ]));
  }
  panel.append(
    h('button', {
      class: 'ghost block mt',
      text: '一键采用版本强势阵容',
      onClick: () => {
        state.peakPicks = {};
        for (const hh of metaRecommendation()) state.peakPicks[hh.pos] = hh.id;
        renderShell();
      },
    }),
    h('button', {
      class: 'primary block mt',
      text: '提交阵容，进入决胜局',
      disabled: !allPicked,
      onClick: () => { stopBgm(); progress({ picks: POSITIONS.map((p) => state.peakPicks[p.key]) }); },
    }),
  );

  screen.append(card, panel);
}

/** 打开某个位置的英雄选择器（modal） */
function openHeroPicker(pos) {
  const pool = heroesByPos(pos.key);
  const body = h('div', { class: 'hero-picker' });
  for (const hero of pool) {
    const on = state.peakPicks[pos.key] === hero.id;
    body.append(h('div', {
      class: `hero-opt ${on ? 'on' : ''}`,
      onClick: () => {
        state.peakPicks[pos.key] = hero.id;
        closeModal();
        renderShell();
      },
    }, [
      h('b', { text: hero.name }),
      h('span', { class: `tag ${hero.tier === 0 ? 'gold' : hero.tier === 2 ? 'mute' : ''}`, text: `T${hero.tier} · ${hero.rate}%` }),
      h('span', { class: 'mute', text: STYLE_LABEL[hero.style] }),
    ]));
  }
  modal({ title: `选择${pos.name}英雄`, body });
}

/** 展示一次巅峰对决的双方英雄阵容 + 结算结论 */
function peakLineupShow(lineup) {
  const row = (title, ids) => h('div', { class: 'peak-lineup' }, [
    h('span', { class: 'mute', text: title }),
    ...(ids || []).map((id) => {
      const hh = HERO_BY_ID[id];
      return hh ? h('span', {
        class: 'pill', text: hh.name,
        title: `T${hh.tier} · 出场率 ${hh.rate}% · ${STYLE_LABEL[hh.style]}`,
      }) : null;
    }),
  ]);
  return h('div', { class: 'peak-banner gold' }, [
    h('div', { class: 'card-title', text: '巅峰对决阵容' }),
    row('我方　', lineup.mine),
    row('对手　', lineup.theirs),
    h('p', { class: 'mute', style: { marginTop: '4px' }, text: lineup.text }),
  ]);
}

function renderGroupTable(groups, tables, game) {
  const card = h('div', { class: 'card' }, [h('div', { class: 'card-title', text: '本轮积分榜' })]);
  for (const d of ['S', 'A', 'B']) {
    if (!groups[d]) continue;
    const ids = groups[d].slice().sort((x, y) => {
      const a = tables[d]?.[x] || { wins: 0, netGames: 0 };
      const b = tables[d]?.[y] || { wins: 0, netGames: 0 };
      return b.wins - a.wins || b.netGames - a.netGames;
    });
    card.append(h('div', { class: 'div-head' }, [divBadge(d), `${d} 组`]));
    const t = h('table', {}, [
      h('tr', {}, [h('th', { class: 'num', text: '#' }), h('th', { text: '战队' }), h('th', { class: 'num', text: '胜' }), h('th', { class: 'num', text: '负' }), h('th', { class: 'num', text: '净胜' })]),
    ]);
    ids.forEach((id, i) => {
      t.append(h('tr', { class: id === game.userTeamId ? 'me' : '' }, [
        h('td', { class: 'num', text: String(i + 1) }),
        h('td', { text: TEAM_BY_ID[id].name }),
        h('td', { class: 'num', text: String(tables[d]?.[id]?.wins ?? 0) }),
        h('td', { class: 'num', text: String(tables[d]?.[id]?.losses ?? 0) }),
        h('td', { class: 'num', text: String(tables[d]?.[id]?.netGames ?? 0) }),
      ]));
    });
    card.append(t);
  }
  return card;
}

/* ══════════════════════════ 淘汰赛 ══════════════════════════ */
function renderBracketEvent(ev, next) {
  const g = state.game;
  const screen = screenEl();
  const card = h('div', { class: 'card hi' }, [
    h('div', { class: 'card-title' }, [
      `${ev.stageName} · ${ev.label} · 第 ${ev.day} 比赛日`,
      h('span', { class: 'tag pill', text: 'BO7 双败' }),
    ]),
  ]);
  for (const { match, result } of ev.matches) {
    const involvesPlayer = match.a === g.userTeamId || match.b === g.userTeamId;
    const line = h('div', { class: `score-line ${involvesPlayer ? 'mine' : ''}` }, [
      h('span', { class: 't', text: TEAM_BY_ID[match.a]?.name || match.a }),
      h('span', { class: 'sc', text: `${result.scoreA}-${result.scoreB}` }),
      h('span', { class: 't right', text: TEAM_BY_ID[match.b]?.name || match.b }),
      h('span', { class: 'flag', text: match.bracket === 'F' ? '总决赛' : match.label }),
    ]);
    card.append(line);

    if (involvesPlayer && ev.chunks) {
      // 玩家自己的 BO7/BO9：按「上半场 / 下半场 / 巅峰对决」分组展示
      const myIsA = match.a === g.userTeamId;
      for (const grp of seriesGroups(result)) {
        card.append(h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', marginTop: '4px' } }, [
          h('span', { class: 'mute', style: { fontSize: '11px', minWidth: '92px' }, text: grp.label }),
          renderDotsFor(grp.games, myIsA, grp.peak),
        ]));
      }
      if (ev.adjustment) {
        card.append(h('div', { class: 'peak-banner', text: `中场调整：${ev.adjustment.text}` }));
      }
      if (ev.lineup) {
        card.append(peakLineupShow(ev.lineup));
      }
      card.append(renderInterview({ ...result, matchId: match.id }, { title: match.bracket === 'F' && result.winnerId === g.userTeamId }));
      continue;
    }

    if (result.games) card.append(renderGameDots({ ...result, matchId: match.id }, g.userTeamId));
    if (result.hadPeakShowdown) card.append(h('div', { class: 'peak-banner', text: '★ 3-3 战平，进入巅峰对决：英雄池重置，一局定生死' }));
    if (involvesPlayer) {
      card.append(renderInterview({ ...result, matchId: match.id }, { title: match.bracket === 'F' && result.winnerId === g.userTeamId }));
    }
  }
  if (ev.finished) {
    if (ev.championId === g.userTeamId) {
      // 玩家夺冠：捧杯时刻 + 冠军赛后采访
      card.append(renderChampionCelebration(ev));
    }
    card.append(h('div', { class: 'peak-banner', text: `冠军：${TEAM_BY_ID[ev.championId]?.name || '-'}　|　你的名次：${ev.playerPlacement ? '第 ' + ev.playerPlacement + ' 名' : '未参赛'}` }));
  }
  const played = ev.matches.some(({ match }) => match.a === g.userTeamId || match.b === g.userTeamId);
  screen.append(
    card,
    played ? renderMoneyDecision() : null,
    renderBracketTree(ev.bracket, g),
    h('button', { class: 'primary block mt', text: '继续', onClick: next }),
  );
}

/** 夺冠庆祝：捧杯时刻 + 冠军赛后采访 */
function renderChampionCelebration(ev) {
  const g = state.game;
  const box = h('div', { class: 'champion-card' }, [
    h('div', { class: 'champion-rays' }),
    h('div', { class: 'champion-trophy', text: '🏆' }),
    h('div', { class: 'champion-title', text: '捧杯时刻' }),
    h('div', { class: 'champion-sub', text: `${TEAM_BY_ID[g.userTeamId].name} 捧起 ${ev.stageName} 冠军奖杯！` }),
  ]);
  // 冠军赛后采访（冠军口吻）
  const fMatch = ev.matches.find(({ match }) => match.bracket === 'F');
  if (fMatch) {
    const interview = renderInterview({
      ...fMatch.result,
      a: fMatch.match.a, b: fMatch.match.b, matchId: fMatch.match.id,
    }, { title: true });
    if (interview) box.append(interview);
  }
  return box;
}

/**
 * 淘汰赛对阵图 —— 官方赛程图样式（横向分层树，从左向右汇聚）
 *
 *   上半：胜者组首轮(M3/M4) → 胜者组决赛(M7) ──────────┐
 *   下半：败者组第一轮(M1/M2) → 第二轮(M5/M6) → 第三轮(M8) → 败者组决赛(M9) ─┤→ 总决赛(F)
 *
 * 每场是"上队/下队 + 各自小分"的竖式节点卡片，列间用连接线表达晋级。
 * 比分一律按 node.a 在上、node.b 在下（scoreA/scoreB 各自对应）。
 */
function renderBracketTree(bracket, g) {
  const wrap = h('div', { class: 'bk2' });
  const M = (id) => bracket.find((m) => m.id === id) || { id, a: null, b: null, winnerId: null, result: null };

  const node = (m) => {
    const done = !!m.winnerId;
    const mine = m.a === g.userTeamId || m.b === g.userTeamId;
    const winA = done && m.winnerId === m.a;
    const winB = done && m.winnerId === m.b;
    const row = (id, win, score) => h('div', { class: 'bk2-row' }, [
      h('span', { class: `bk2-team ${win ? 'win' : done ? 'lose' : ''}`, text: TEAM_BY_ID[id]?.short || '待定' }),
      h('span', { class: 'bk2-score', text: done ? String(score) : '' }),
    ]);
    return h('div', { class: `bk2-node ${mine ? 'mine' : ''} ${done ? 'done' : ''}`, title: m.label || m.id }, [
      row(m.a, winA, m.result ? m.result.scoreA : ''),
      row(m.b, winB, m.result ? m.result.scoreB : ''),
    ]);
  };

  const col = (title, nodes, cls = '') => h('div', { class: `bk2-col ${cls}` }, [
    h('div', { class: 'bk2-col-title', text: title }),
    ...nodes,
  ]);

  wrap.append(
    h('div', { class: 'bk2-grid' }, [
      // 第一列：两组首轮
      h('div', { class: 'bk2-stack' }, [
        col('胜者组首轮', [node(M('M3')), node(M('M4'))], 'wb'),
        col('败者组第一轮', [node(M('M1')), node(M('M2'))], 'lb'),
      ]),
      // 第二列：胜者组决赛 + 败者组第二轮
      h('div', { class: 'bk2-stack' }, [
        col('胜者组决赛', [node(M('M7'))], 'wb'),
        col('败者组第二轮', [node(M('M5')), node(M('M6'))], 'lb'),
      ]),
      // 第三列：败者组第三轮 + 败者组决赛
      h('div', { class: 'bk2-stack' }, [
        col('　', [], 'wb'),
        col('败者组第三轮', [node(M('M8'))], 'lb'),
        col('败者组决赛', [node(M('M9'))], 'lb'),
      ]),
      // 第四列：总决赛
      col('总决赛', [node(M('F'))], 'f'),
    ]),
  );
  return wrap;
}

/* ══════════════════════════ 赛季结算 ══════════════════════════ */
function renderSeasonEnd(summary, next) {
  const g = state.game;
  const screen = screenEl();
  const led = h('div', { class: 'ledger' });
  const line = (k, v, cls = '') => h('div', { class: `li ${cls}` }, [h('span', { text: k }), h('span', { class: cls === 'total' ? 'gold' : '', text: v })]);
  const incomeTotal = Object.values(summary.income).reduce((a, b) => a + b, 0);
  const expenseTotal = Object.values(summary.expense).reduce((a, b) => a + b, 0);
  led.append(
    h('h3', { text: '收入' }),
    line('联盟分成', `${summary.income.leagueShare} 万`),
    line('赞助', `${summary.income.sponsor} 万`),
    line('赛事奖金', `${summary.income.prize} 万`),
    line('门票 / 主场', `${summary.income.ticket} 万`),
    line('周边电商', `${summary.income.merch} 万`),
    line('收入合计', `${incomeTotal} 万`, 'total'),
    h('h3', { class: 'mt', text: '支出' }),
    line('选手薪酬', `${summary.expense.wages} 万`),
    line('基地运营', `${summary.expense.base} 万`),
    line('支出合计', `${expenseTotal} 万`, 'total'),
    line('赛季净收支', `${summary.net > 0 ? '+' : ''}${summary.net} 万`, 'total'),
  );

  screen.append(
    h('div', { class: `card ${summary.champion ? 'gold' : 'hi'}` }, [
      h('div', { class: 'card-title', text: `第 ${summary.season} 赛季结算` }),
      h('div', { class: 'split' }, [
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '联赛最终排名' }), h('div', { class: 'v', text: `#${summary.rank}` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '组别' }), h('div', { class: 'v', text: `${summary.div} 组` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '现金' }), h('div', { class: `v ${summary.cashAfter < 0 ? 'red' : ''}`, text: `${summary.cashAfter} 万` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '声望' }), h('div', { class: 'v', text: String(summary.fameAfter) })]),
      ]),
      summary.champion ? h('div', { class: 'peak-banner mt', text: '★ 本赛季夺得冠军！' }) : null,
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '赛事名次与年度积分' }),
      h('table', {}, [
        h('tr', {}, [h('th', { text: '赛事' }), h('th', { class: 'num', text: '名次' }), h('th', { class: 'num', text: '奖金' }), h('th', { class: 'num', text: '积分' })]),
        ...summary.awards.map((a) => h('tr', {}, [
          h('td', { text: ({ spring: '春季赛', challenger: '挑战者杯', summer: '夏季赛', finals: '年度总决赛' })[a.eventId] }),
          h('td', { class: 'num', text: a.placement ? `第${a.placement}` : '未参赛' }),
          h('td', { class: 'num', text: `${a.prize}` }),
          h('td', { class: 'num', text: `+${a.points}` }),
        ])),
      ]),
    ]),
    h('div', { class: 'card' }, [h('div', { class: 'card-title', text: '财务流水' }), led]),
    next ? h('button', { class: 'primary block mt', text: '继续', onClick: next }) : null,
  );
}

/* ══════════════════════════ 阵容 ══════════════════════════ */
/** 性格标签 */
function traitPill(trait) {
  if (!trait) return null;
  return h('span', { class: `pill trait tone-${trait.tone || 'plain'}`, text: `${trait.icon} ${trait.name}` });
}

/** 成长弧标签 */
function arcPill(arc) {
  if (!arc) return null;
  return h('span', { class: `pill arc tone-${arc.tone || 'plain'}`, text: `${arc.icon} ${arc.label}` });
}

/** 迷你成长曲线（纯 DOM 柱状），数据来自 player.history */
function growthBars(history) {
  const pts = growthSeries({ history }, 6);
  if (pts.length < 2) {
    return h('p', { class: 'mute', text: '暂无跨赛季成长数据（赛季结算后出现）' });
  }
  const wrap = h('div', { class: 'grow-bars' });
  const min = Math.min(...pts.map((p) => p.o));
  const max = Math.max(...pts.map((p) => p.o));
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const prev = pts[i - 1];
    const ratio = max === min ? 0.6 : (p.o - min) / (max - min);
    const up = !prev || p.o >= prev.o;
    wrap.append(h('div', { class: `gb ${up ? 'up' : 'down'}` }, [
      h('div', { class: 'bar', style: { height: `${24 + ratio * 56}%` } }),
      h('div', { class: 'lb', text: p.s === 0 ? '初始' : `S${p.s}` }),
      h('div', { class: 'val', text: String(p.o) }),
    ]));
  }
  return wrap;
}

/** 赛后采访：由队内综合最高的球员出面说一句符合性格的话 */
function renderInterview(series, opts = {}) {
  const g = state.game;
  const q = matchQuote(g, series, opts);
  if (!q) return null;
  const trait = q.trait ? TRAIT_BY_ID[q.trait] : null;
  return h('div', { class: `interview ${q.won ? 'win' : 'lose'}` }, [
    h('div', { class: 'who' }, [
      h('span', { text: `${trait ? trait.icon + ' ' : ''}${q.playerName}` }),
      h('span', { class: 'mute', text: '　赛后采访' }),
    ]),
    h('div', { class: 'said', text: q.text }),
  ]);
}

/** 一行商务活动（财务页与赛果页共用） */
function activityRow(act, compact = false) {
  const g = state.game;
  const used = businessUsed(g, act.id);
  const cash = activityCash(g, act);
  const gate = canDoBusiness(g, act.id);
  return h('div', { class: 'train-row' }, [
    h('div', { class: 'grow' }, [
      h('b', { text: `${act.icon} ${act.name}` }),
      h('span', { class: 'mute', style: { fontSize: '11px', marginLeft: '6px' }, text: `${used}/${act.cap} 次` }),
      compact ? null : h('div', { class: 'mute', style: { fontSize: '11px' }, text: act.desc }),
    ]),
    h('button', {
      class: 'small',
      title: gate.ok ? '' : gate.reason,
      text: `+${cash} 万 · 疲劳+${act.fatigue}`,
      disabled: !gate.ok,
      onClick: () => {
        const r = doBusiness(g, act.id);
        if (!r.ok) return toast(r.reason);
        toast(`「${act.name}」入账 ${r.cash} 万，声望 ${r.fame}，疲劳 ${r.fatigue}/${FATIGUE.cap}`);
        saveGame(g);
        return renderShell();
      },
    }),
  ]);
}

/** 每轮比赛后的资金决策卡：既能花钱，也能挣钱 */
function renderMoneyDecision() {
  const g = state.game;
  if (!g || g.gameOver) return null;
  const rec = recommendTrain(g);
  const card = h('div', { class: 'card' }, [
    h('div', { class: 'card-title' }, ['本轮资金决策', h('span', { class: 'tag pill', text: `现金 ${Math.round(g.cash)} 万` })]),
    h('p', { class: 'mute', text: '比赛打完，钱怎么花由你定：特训能立刻提升战力，但也可能让账面更紧张。' }),
  ]);
  const col = h('div', { class: 'btn-col mt' });
  if (rec) {
    col.append(h('button', {
      class: 'small',
      text: `特训 ${rec.playerName}「${rec.attrName}」+1（${rec.cost} 万）`,
      disabled: g.cash < rec.cost,
      onClick: () => {
        const r = trainAttr(g, rec.playerId, rec.attr);
        if (!r.ok) return toast(r.reason);
        toast(`${rec.playerName} ${r.attrName} +1，花费 ${r.cost} 万`);
        saveGame(g);
        return renderShell();
      },
    }));
  }
  for (const kind of ['morale', 'chem']) {
    const plan = TEAM_PLANS[kind];
    const cost = teamCost(g, kind);
    col.append(h('button', {
      class: 'small',
      text: `${plan.name} +${plan.gain}（${cost} 万）`,
      disabled: g.cash < cost,
      onClick: () => {
        const r = trainTeam(g, kind);
        if (!r.ok) return toast(r.reason);
        toast(`${plan.name} +${r.gain}，花费 ${r.cost} 万`);
        saveGame(g);
        return renderShell();
      },
    }));
  }
  card.append(col);
  // 挣钱的路子：接一档商务（会累积疲劳）
  const fat = g.fatigue?.[g.userTeamId] || 0;
  const earn = ACTIVITIES.filter((a) => canDoBusiness(g, a.id).ok).slice(0, 2);
  if (earn.length) {
    const box = h('div', { class: 'btn-col mt' }, [
      h('p', { class: 'mute', style: { margin: '4px 0' }, text: `也可以选择挣钱（当前疲劳 ${fat}/${FATIGUE.cap}，战力 ${fatiguePenalty(g)}）：` }),
      ...earn.map((a) => activityRow(a, true)),
    ]);
    card.append(box);
  }
  card.append(h('button', {
    class: 'small ghost block mt',
    text: '进入财务页看全部商务机会 →',
    onClick: () => { state.tab = 'finance'; state.cursor = state.log.length; renderShell(); },
  }));
  card.append(h('button', {
    class: 'small ghost block mt',
    text: '进入训练中心（逐人特训）→',
    onClick: () => { state.tab = 'training'; state.cursor = state.log.length; renderShell(); },
  }));
  return card;
}

/** 球员档案弹窗：性格 / 成长弧 / 能力 / 合同 / 语录 */
function openPlayerModal(playerId) {
  const g = state.game;
  const story = playerStory(g, playerId);
  if (!story) { toast('找不到该球员'); return; }
  const { player: p, trait, arc, history, quotes } = story;
  const div = divisionOfTeam(g, p.teamId);
  const body = h('div', {}, [
    h('div', { class: 'row between' }, [
      h('div', {}, [
        h('div', { class: 'big', style: { fontSize: '20px' }, text: p.name }),
        h('div', { class: 'mute', text: `${ROLE_NAME[p.role]} · ${p.age} 岁 · ${TEAM_BY_ID[p.teamId]?.name || p.teamId}` }),
      ]),
      h('div', { class: 'ovr gold', style: { fontSize: '26px', fontWeight: 800 }, text: String(p.overall) }),
    ]),
    h('div', { class: 'row wrap mt' }, [traitPill(trait), arcPill(arc)]),
    trait ? h('p', { class: 'mute', style: { marginTop: '6px' }, text: `性格：${trait.desc}` }) : null,
    h('div', { class: 'card', style: { margin: '10px 0' } }, [
      h('div', { class: 'card-title', text: `成长弧 · ${arc.label}` }),
      h('div', { class: 'mute', text: arc.desc }),
      growthBars(history),
    ]),
    h('table', {}, [
      h('tr', {}, [h('th', { text: '操作' }), h('th', { text: '意识' }), h('th', { text: '团战' }), h('th', { text: '英雄池' }), h('th', { class: 'num', text: '潜力' })]),
      h('tr', {}, [
        h('td', { text: String(p.laning) }), h('td', { text: String(p.macro) }),
        h('td', { text: String(p.teamfight) }), h('td', { text: String(p.champPool) }),
        h('td', { class: 'num', text: String(p.potential) }),
      ]),
    ]),
    h('div', { class: 'ledger mt' }, [
      h('div', { class: 'li' }, [h('span', { text: '市场身价' }), h('span', { class: 'gold', text: `${p.value} 万` })]),
      h('div', { class: 'li' }, [h('span', { text: '当前年薪' }), h('span', { text: `${p.wage} 万` })]),
      h('div', { class: 'li' }, [h('span', { text: '合同剩余' }), h('span', { text: `${p.contractYears ?? 1} 年` })]),
      div ? h('div', { class: 'li' }, [h('span', { text: '所属组别' }), h('span', { text: `${div} 组` })]) : null,
    ]),
    p.tags?.length ? h('div', { class: 'mt' }, p.tags.map((t) => h('span', { class: 'pill', text: t }))) : null,
    quotes?.length ? h('div', { class: 'mt' }, [
      h('h3', { text: '近期发言' }),
      ...quotes.map((q) => h('p', { class: 'quote', text: q })),
    ]) : null,
  ]);
  modal({
    title: '球员档案',
    body,
    actions: [{ label: '关闭', cls: 'ghost' }],
  });
}

function renderRoster() {
  const g = state.game;
  const screen = screenEl();
  const sq = g.squads[g.userTeamId];
  const cardOf = (id, isStarter) => {
    const p = g.players[id];
    if (!p) return null;
    const trait = traitOf(p);
    const arc = arcOf(p);
    return h('div', {
      class: `p-card clickable ${isStarter ? 'starter' : ''}`,
      title: '点击查看球员档案',
      onClick: () => openPlayerModal(id),
    }, [
      h('div', { class: 'row between' }, [
        h('div', {}, [
          h('div', { class: 'nm', text: p.name }),
          h('div', { class: 'role', text: `${ROLE_ICON[p.role]} ${ROLE_NAME[p.role]} · ${p.age} 岁` }),
        ]),
        h('div', { class: 'ovr gold', text: String(p.overall) }),
      ]),
      h('div', { class: 'bar' }, [h('i', { style: { width: `${p.overall}%` } })]),
      h('div', { class: 'row wrap mt', style: { gap: '4px' } }, [traitPill(trait), arcPill(arc)]),
      h('div', { class: 'mute', style: { fontSize: '11px' }, text: `操作${p.laning} 意识${p.macro} 团战${p.teamfight} 英雄池${p.champPool}` }),
      h('div', { class: 'mute', style: { fontSize: '11px' }, text: `潜力${p.potential} · 身价${p.value}万 · 年薪${p.wage}万` }),
      p.tags?.length ? h('div', { class: 'mt' }, p.tags.map((t) => h('span', { class: 'pill', text: t }))) : null,
    ]);
  };
  const wageTotal = sq.starters.concat(sq.bench || [], sq.youth || []).reduce((s, id) => s + (g.players[id]?.wage || 0), 0);

  screen.append(
    h('h1', { text: '阵容' }),
    h('div', { class: 'card' }, [
      h('div', { class: 'row between' }, [
        h('div', {}, [h('div', { class: 'mute', text: '全队年薪合计' }), h('div', { class: 'big gold', text: `${wageTotal} 万` })]),
        h('div', { style: { textAlign: 'right' } }, [
          h('div', { class: 'mute', text: '战队战力' }),
          h('div', { class: 'big', text: teamPower(g, g.userTeamId).toFixed(1) }),
        ]),
      ]),
      h('p', { class: 'mute mt', text: '转会窗与挂牌功能将在后续版本开放；目前可在赛季间调整首发。' }),
    ]),
    h('h2', { class: 'mt', text: '首发五人' }),
    h('div', { class: 'p-grid' }, sq.starters.map((id) => cardOf(id, true))),
    h('h2', { class: 'mt', text: '替补席' }),
    h('div', { class: 'p-grid' }, (sq.bench || []).map((id) => cardOf(id, false))),
    sq.youth?.length ? h('h2', { class: 'mt', text: '青训' }) : null,
    sq.youth?.length ? h('div', { class: 'p-grid' }, sq.youth.map((id) => cardOf(id, false))) : null,
  );
}

/* ══════════════════════════ 积分榜 ══════════════════════════ */
/* ══════════════════════════ 训练中心（资金决策） ══════════════════════════ */
function renderTraining() {
  const g = state.game;
  const screen = screenEl();
  const pid = g.userTeamId;
  const starters = (g.squads[pid]?.starters || []).map((id) => g.players[id]).filter(Boolean);
  const spend = seasonTrainingSpend(g);
  const avg = starters.length ? Math.round(starters.reduce((s, p) => s + p.overall, 0) / starters.length) : 0;

  screen.append(
    h('h1', { text: '训练中心' }),
    h('div', { class: 'card hi' }, [
      h('div', { class: 'card-title', text: '把现金变成战力' }),
      h('p', { class: 'dim', text: '用现金直接提升首发球员的能力。同一项练得越多越贵；每项属性每赛季最多 +6，每人每赛季累计最多 +16。能力提升会推高身价，但已签合同的年薪不变。' }),
      h('div', { class: 'row between mt' }, [
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '可用现金' }), h('div', { class: 'v', text: `${Math.round(g.cash)} 万` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '本赛季已投入' }), h('div', { class: 'v', text: `${spend} 万` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '首发平均' }), h('div', { class: 'v', text: String(avg) })]),
      ]),
    ]),
  );

  // ── 团队投入 ──
  const teamCard = h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: '团队投入' }),
    h('p', { class: 'mute', text: '士气/默契直接提升战力；体能恢复用来把跑商务积累的疲劳养回来。' }),
  ]);
  for (const kind of ['morale', 'chem', 'recover']) {
    const plan = TEAM_PLANS[kind];
    const used = (g.trainingTeam?.[kind]) || 0;
    const cur = kind === 'morale' ? (g.morale[pid] ?? 70)
      : kind === 'chem' ? (g.chemistry[pid] ?? 72)
        : (g.fatigue?.[pid] || 0);
    const cost = teamCost(g, kind);
    const done = kind === 'recover' ? cur <= 0 : cur >= plan.max;
    const disabled = g.cash < cost || used >= TEAM_CAP || done;
    const shown = kind === 'recover' ? `疲劳 ${cur}/${plan.max}` : `${cur}`;
    const btnText = kind === 'recover' ? `-${plan.gain} 疲劳（${cost} 万）` : `+${plan.gain}（${cost} 万）`;
    teamCard.append(h('div', { class: 'train-row' }, [
      h('div', { class: 'grow' }, [
        h('b', { text: `${plan.name}　${shown}` }),
        h('div', { class: 'mute', style: { fontSize: '11px' }, text: `${plan.desc} · 本赛季 ${used}/${TEAM_CAP} 次` }),
      ]),
      h('button', {
        class: 'small',
        text: btnText,
        disabled,
        onClick: () => {
          const r = trainTeam(g, kind);
          if (!r.ok) return toast(r.reason);
          toast(kind === 'recover'
            ? `${plan.name}：疲劳降至 ${r.value}，花费 ${r.cost} 万`
            : `${plan.name} +${r.gain}，花费 ${r.cost} 万`);
          saveGame(g);
          return renderShell();
        },
      }),
    ]));
  }
  screen.append(teamCard);

  // ── 首发球员特训（一行一名球员，保证工作台一屏放下） ──
  const grid = h('div', { class: 'tr-rows' }, [
    h('div', { class: 'tr-row tr-head' }, [
      h('span', { class: 'tr-p', text: '球员' }),
      ...ATTRS.map((a) => h('span', { class: 'tr-attr', text: a.name })),
      h('span', { class: 'tr-attr', text: '一键' }),
    ]),
  ]);
  for (const p of starters) {
    const rem = remainingFor(g, p.id);
    const row = h('div', { class: 'tr-row' }, [
      h('span', { class: 'tr-p', title: `${ROLE_NAME[p.role]} · ${p.age} 岁 · 剩余可训 +${rem.total}`, onClick: () => openPlayerModal(p.id) }, [
        h('b', { text: p.name }),
        h('span', { class: 'gold', text: ` ${p.overall}` }),
      ]),
    ]);
    for (const a of ATTRS) {
      const used = (g.training?.[p.id]?.[a.key]) || 0;
      const maxed = used >= SEASON_CAP_PER_ATTR || rem.total <= 0 || p[a.key] >= 99;
      const cost = attrCost(g, p, a.key);
      row.append(h('button', {
        class: 'small tr-btn',
        title: `${a.name} ${p[a.key]}（本赛季 ${used}/${SEASON_CAP_PER_ATTR}）`,
        text: `${p[a.key]} +1`,
        disabled: maxed || g.cash < cost,
        onClick: () => {
          const r = trainAttr(g, p.id, a.key);
          if (!r.ok) return toast(r.reason);
          toast(`${p.name} ${r.attrName} +1（${r.cost} 万）`);
          saveGame(g);
          return renderShell();
        },
      }));
    }
    row.append(h('button', {
      class: 'small gold tr-btn',
      title: '把操作/意识/团战/英雄池所有还能练的项目各 +1',
      text: '⚡ 全部 +1',
      disabled: rem.total <= 0,
      onClick: () => {
        const r = trainAllAttrs(g, p.id);
        if (!r.ok) return toast(r.reason);
        const names = r.gains.map((x) => x.name).join('、');
        toast(`「${p.name}」一键训练完成：${names} 各 +1，花费 ${r.cost} 万`);
        saveGame(g);
        return renderShell();
      },
    }));
    grid.append(row);
  }
  screen.append(grid);
}

function renderLeague() {  const g = state.game;
  const screen = screenEl();
  const keys = Object.keys(g.groupsByRound).map(Number).sort((a, b) => b - a);
  const round = keys[0] || 1;
  const groups = g.groupsByRound[round] || {};
  const tables = g.tablesByRound[round] || {};
  const stage = g.stages.find((s) => s.kind === 'group' && s.roundIndex === round)
    || g.stages.find((s) => s.kind === 'group');

  screen.append(h('h1', { text: '联赛积分榜' }));
  screen.append(h('p', { class: 'dim', text: `当前为常规赛第 ${round} 轮。第三轮 S 组前 4 与 A 组前 2 进季后赛胜者组/败者组，B 组后四名提前结束赛季。` }));

  for (const d of ['S', 'A', 'B']) {
    if (!groups[d]) continue;
    const ids = groups[d].slice().sort((x, y) => {
      const a = tables[d]?.[x] || { wins: 0, netGames: 0 };
      const b = tables[d]?.[y] || { wins: 0, netGames: 0 };
      return b.wins - a.wins || b.netGames - a.netGames;
    });
    screen.append(h('div', { class: 'div-head' }, [divBadge(d), `${d} 组`, h('span', { class: 'mute', text: `（第 ${round} 轮）` })]));
    const t = h('table', {}, [
      h('tr', {}, [
        h('th', { class: 'num', text: '#' }), h('th', { text: '战队' }),
        h('th', { class: 'num', text: '胜' }), h('th', { class: 'num', text: '负' }),
        h('th', { class: 'num', text: '净胜局' }), h('th', { class: 'num', text: '小局' }),
      ]),
    ]);
    ids.forEach((id, i) => {
      const row = tables[d]?.[id] || { wins: 0, losses: 0, netGames: 0, gameWins: 0, gameLosses: 0 };
      let cls = id === g.userTeamId ? 'me' : '';
      if (round === 3 && d === 'S' && i < 4) cls += ' advance';
      if (round === 3 && d === 'B' && i >= 4) cls += ' elim';
      t.append(h('tr', { class: cls }, [
        h('td', { class: 'num', text: String(i + 1) }),
        h('td', { text: TEAM_BY_ID[id].name }),
        h('td', { class: 'num', text: String(row.wins) }),
        h('td', { class: 'num', text: String(row.losses) }),
        h('td', { class: 'num', text: String(row.netGames) }),
        h('td', { class: 'num', text: `${row.gameWins}-${row.gameLosses}` }),
      ]));
    });
    screen.append(h('div', { class: 'card' }, [t]));
  }

  // 年度积分
  const annual = annualStandings(g);
  const ac = h('div', { class: 'card' }, [
    h('div', { class: 'card-title' }, ['年度总决赛积分', h('span', { class: 'tag pill', text: '前 12 名晋级' })]),
    h('p', { class: 'mute', text: '春季赛 + 挑战者杯 + 夏季赛三站累计，1-6 名进大师组，7-12 名进精英组。' }),
  ]);
  const at = h('table', {}, [h('tr', {}, [h('th', { class: 'num', text: '#' }), h('th', { text: '战队' }), h('th', { class: 'num', text: '积分' }), h('th', { class: 'num', text: '组别' })])]);
  annual.forEach((r) => {
    at.append(h('tr', { class: r.id === g.userTeamId ? 'me' : (r.rank <= 12 ? '' : 'elim') }, [
      h('td', { class: 'num', text: String(r.rank) }),
      h('td', { text: TEAM_BY_ID[r.id].name }),
      h('td', { class: 'num', text: String(r.points) }),
      h('td', { class: 'num', text: r.group === 'masters' ? '大师' : '精英' }),
    ]));
  });
  ac.append(at);
  screen.append(ac);
}

/* ══════════════════════════ 财务 ══════════════════════════ */
function renderFinance() {
  const g = state.game;
  const screen = screenEl();
  const sq = g.squads[g.userTeamId];
  const wages = sq.starters.concat(sq.bench || [], sq.youth || []).reduce((s, id) => s + (g.players[id]?.wage || 0), 0);
  const share = leagueShareForRank(g.lastRank || 12);
  const sponsor = Math.round(FINANCE.sponsorBase + g.fame * FINANCE.sponsorPerFame);
  const projectedIncome = share + sponsor
    + Math.round(FINANCE.ticketBase * (1 + g.fame / 100))
    + Math.round(FINANCE.merchBase * (1 + g.fame / 60));
  const projectedExpense = wages + FINANCE.baseCost;

  screen.append(
    h('h1', { text: '财务' }),
    h('div', { class: 'card hi' }, [
      h('div', { class: 'row between' }, [
        h('div', {}, [h('div', { class: 'mute', text: '当前现金' }), h('div', { class: `big ${g.cash < 0 ? 'red' : 'gold'}`, text: `${Math.round(g.cash)} 万` })]),
        h('div', { style: { textAlign: 'right' } }, [
          h('div', { class: 'mute', text: '按当前声望的赛季预估净收支' }),
          h('div', { class: `big ${projectedIncome - projectedExpense < 0 ? 'red' : 'green'}`, text: `${projectedIncome - projectedExpense > 0 ? '+' : ''}${projectedIncome - projectedExpense} 万` }),
        ]),
      ]),
      g.cash < 0 ? h('div', { class: 'peak-banner mt', style: { borderColor: 'var(--red)', color: 'var(--red)' }, text: `⚠ 已连续 ${g.bankruptSeasons} 个赛季现金为负。再拖一个赛季就会被联盟接管。` }) : null,
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '预估赛季收入' }),
      h('div', { class: 'ledger' }, [
        h('div', { class: 'li' }, [h('span', { text: `联盟分成（按上季第 ${g.lastRank || '—'} 名）` }), h('span', { text: `${share} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: `赞助（声望 ${Math.round(g.fame)}）` }), h('span', { text: `${sponsor} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '门票 / 主场' }), h('span', { text: `${Math.round(FINANCE.ticketBase * (1 + g.fame / 100))} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '周边电商' }), h('span', { text: `${Math.round(FINANCE.merchBase * (1 + g.fame / 60))} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '赛事奖金' }), h('span', { class: 'mute', text: '按最终名次结算' })]),
        h('div', { class: 'li total' }, [h('span', { text: '固定收入合计' }), h('span', { class: 'gold', text: `${projectedIncome} 万` })]),
      ]),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '预估赛季支出' }),
      h('div', { class: 'ledger' }, [
        h('div', { class: 'li' }, [h('span', { text: `选手薪酬（${sq.starters.length + (sq.bench?.length || 0) + (sq.youth?.length || 0)} 人）` }), h('span', { text: `${wages} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '基地与运营' }), h('span', { text: `${FINANCE.baseCost} 万` })]),
        h('div', { class: 'li total' }, [h('span', { text: '支出合计' }), h('span', { class: 'gold', text: `${projectedExpense} 万` })]),
      ]),
      h('p', { class: 'mute mt', text: '赢一场常规赛另有 ' + FINANCE.winBonus + ' 万赢球奖金。夺冠奖金远高于联赛分成，是扭亏的主要路径。' }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title' }, [
        '商务运营',
        h('span', { class: 'tag pill', text: `本赛季已入账 ${businessIncome(g)} 万` }),
      ]),
      h('p', { class: 'mute', text: '打比赛之外，还能靠商务创收：报价随声望水涨船高（声望 50 → 报价翻倍）。代价是疲劳 —— 每 1 点疲劳直接扣 0.2 战力，AI 战队不会这么做，这是你独有的财路。' }),
      h('div', { class: 'row between mt' }, [
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '当前疲劳' }), h('div', { class: `v ${(g.fatigue?.[g.userTeamId] || 0) > 0 ? 'red' : ''}`, text: `${g.fatigue?.[g.userTeamId] || 0} / ${FATIGUE.cap}` })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '战力惩罚' }), h('div', { class: 'v red', text: String(fatiguePenalty(g)) })]),
        h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '剩余机会' }), h('div', { class: 'v', text: String(remainingBusiness(g)) })]),
      ]),
      ...ACTIVITIES.map((a) => activityRow(a)),
      h('p', { class: 'mute mt', text: `疲劳不随开季清零：休赛期接的商务会把状态代价带进下个赛季。每个比赛日自动恢复 ${FATIGUE.recoverPerDay} 点，也可以在「训练 → 体能恢复」花钱快速调理。` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '本赛季已发生的资金流动' }),
      h('div', { class: 'ledger' }, [
        h('div', { class: 'li' }, [h('span', { text: '常规营收（每轮比赛后进账）' }), h('span', { class: 'green', text: `+${g.flags?.matchIncome || 0} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '商务运营收入' }), h('span', { class: 'green', text: `+${businessIncome(g)} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '球员特训 / 团队投入（已扣）' }), h('span', { text: `${seasonTrainingSpend(g)} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '已挂账的转会费（结算时扣）' }), h('span', { text: `${g.flags?.pendingTransferCost || 0} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '卖人回血（结算时到账）' }), h('span', { class: 'green', text: `+${g.flags?.pendingTransferIncome || 0} 万` })]),
      ]),
      h('p', { class: 'mute mt', text: '商务收入与训练/团队投入在点击时立刻结算；转会费与卖人收入在赛季结算时统一结算。' }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'card-title', text: '风险提示' }),
      h('p', { class: 'mute', text: `· 现金为负连续 ${FAILURE_RULES.bankruptSeasons} 个赛季 → 资金断裂，强制结束` }),
      h('p', { class: 'mute', text: `· 连续 ${FAILURE_RULES.bottomSeasons} 个赛季排名倒数三 → 董事会被解雇，强制结束` }),
      h('p', { class: 'mute', text: `· 当前：资金危机计数 ${g.bankruptSeasons}，倒数三计数 ${g.bottomSeasons}` }),
    ]),
  );
}

/* ══════════════════════════ 生涯 ══════════════════════════ */
function renderCareer() {
  const g = state.game;
  const screen = screenEl();
  screen.append(h('h1', { text: '生涯' }));

  if (g.gameOver) {
    screen.append(h('div', { class: `card ${g.gameOver.reason === 'complete' ? 'gold' : 'danger'}` }, [
      h('div', { class: 'card-title', text: g.gameOver.title }),
      h('p', { class: 'dim', text: g.gameOver.detail }),
      h('div', { class: 'mt' }, [h('span', { class: 'pill gold', text: `评分 ${careerGrade(g).grade}` }), h('span', { class: 'pill', text: careerGrade(g).reason })]),
    ]));
  }

  const totalTitles = g.history.filter((s) => s.champion).length;
  screen.append(h('div', { class: 'card' }, [
    h('div', { class: 'card-title', text: '生涯数据' }),
    h('div', { class: 'split wrap' }, [
      h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '赛季数' }), h('div', { class: 'v', text: String(g.history.length) })]),
      h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '总冠军' }), h('div', { class: 'v gold', text: String(totalTitles) })]),
      h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '期末现金' }), h('div', { class: 'v', text: `${Math.round(g.cash)} 万` })]),
      h('div', { class: 'stat-box' }, [h('div', { class: 'k', text: '声望' }), h('div', { class: 'v', text: String(Math.round(g.fame)) })]),
    ]),
  ]));

  if (!g.history.length) {
    screen.append(h('p', { class: 'dim', text: '还没有完成任何赛季。' }));
  }
  for (const s of g.history) {
    const card = h('div', { class: `card ${s.champion ? 'gold' : ''}` }, [
      h('div', { class: 'card-title' }, [
        `第 ${s.season} 赛季`,
        h('span', { class: 'tag pill', text: `最终第 ${s.rank} 名 · ${s.div} 组` }),
      ]),
      h('div', { class: 'honor-wall' }, s.awards.map((a) => h('span', {
        class: `pill ${a.placement === 1 ? 'gold' : a.placement && a.placement <= 4 ? 'green' : ''}`,
        text: `${({ spring: '春', challenger: '挑杯', summer: '夏', finals: '年总' })[a.eventId]}${a.placement ? '第' + a.placement : '未参赛'}`,
      }))),
      h('div', { class: 'ledger mt' }, [
        h('div', { class: 'li' }, [h('span', { text: '净收支' }), h('span', { class: s.net >= 0 ? 'green' : 'red', text: `${s.net > 0 ? '+' : ''}${s.net} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '期末现金' }), h('span', { text: `${s.cashAfter} 万` })]),
        h('div', { class: 'li' }, [h('span', { text: '声望' }), h('span', { text: String(s.fameAfter) })]),
      ]),
    ]);
    screen.append(card);
  }

  screen.append(h('div', { class: 'mt' }, [
    h('button', {
      class: 'ghost block',
      text: '放弃当前存档，重新开始',
      onClick: () => modal({
        title: '确认重开？',
        body: '<p class="dim">当前存档会被删除，无法恢复。</p>',
        actions: [
          { label: '取消', cls: 'ghost' },
          { label: '删除并重开', cls: 'gold', onClick: () => { clearSave(); state.game = null; renderStart(); } },
        ],
      }),
    }),
  ]));
}

export function careerGrade(g) {
  const titles = g.history.filter((s) => s.champion).length;
  const best = Math.min(...g.history.map((s) => s.rank), 18);
  const finalCash = g.cash;
  if (titles >= 3 && finalCash > 0) return { grade: 'S', reason: '王朝缔造者' };
  if (titles >= 2) return { grade: 'A', reason: '多冠豪门' };
  if (titles >= 1 || best <= 3) return { grade: 'B', reason: '一冠功勋' };
  if (g.gameOver?.reason === 'bankrupt') return { grade: 'D', reason: '资金断裂' };
  if (g.gameOver?.reason === 'fired') return { grade: 'D', reason: '中途解雇' };
  if (best <= 8) return { grade: 'C', reason: '稳定中游' };
  return { grade: 'D', reason: '未能突破' };
}

/* ══════════════════════════ 休赛期 ══════════════════════════ */
function startOffseason() {
  const g = state.game;
  const data = beginOffseason(g, g.__rng);
  state.offseason = data;
  state.offseasonStage = 'develop';
  state.log = [];
  state.cursor = 0;
  saveGame(g);
  renderOffseason();
}

function renderOffseason() {
  const g = state.game;
  const screen = document.getElementById('screen');
  clear(screen);
  screen.classList.remove('locked');   // 休赛期是多步表单，保持可滚动
  renderTopbar();
  const data = state.offseason;
  if (!data) return renderShell();

  const stepBar = h('div', { class: 'stage-strip' }, ['develop', 'youth', 'market']
    .map((s) => h('div', { class: `seg ${state.offseasonStage === s ? 'now' : ''}` })));

  if (state.offseasonStage === 'develop') {
    const my = data.mine || [];
    screen.append(
      stepBar,
      h('h1', { text: `休赛期 · 第 ${g.season} 赛季结束` }),
      h('div', { class: 'card hi' }, [
        h('div', { class: 'card-title', text: '球员成长与老化' }),
        h('p', { class: 'mute', text: '全体球员年龄 +1。年轻球员涨球，老将开始下滑——不换血就会被版本淘汰。' }),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-title', text: '你的球员变化' }),
        my.length ? h('table', {}, [
          h('tr', {}, [h('th', { text: '选手' }), h('th', { class: 'num', text: '位置' }), h('th', { class: 'num', text: '年龄' }), h('th', { class: 'num', text: '变化' })]),
          ...my.map((d) => h('tr', {}, [
            h('td', { text: d.name }),
            h('td', { class: 'num', text: ROLE_NAME[g.players[d.id]?.role] || '-' }),
            h('td', { class: 'num', text: String(d.age) }),
            h('td', { class: 'num', class: d.to >= d.from ? 'green' : 'red', text: `${d.from} → ${d.to} (${d.to - d.from > 0 ? '+' : ''}${d.to - d.from})` }),
          ])),
        ]) : h('p', { class: 'dim', text: '没有球员数据' }),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-title', text: '联盟动向' }),
        h('h3', { text: '涨球最快' }),
        h('div', {}, data.risers.map((d) => h('span', { class: 'pill green', text: `${d.name} ${d.from}→${d.to}` }))),
        h('h3', { class: 'mt', text: '下滑最明显' }),
        h('div', {}, data.fallers.map((d) => h('span', { class: 'pill red', text: `${d.name} ${d.from}→${d.to}` }))),
      ]),
      data.forced?.length ? h('div', { class: 'card danger' }, [
        h('div', { class: 'card-title', text: '离队条款被触发' }),
        h('p', { class: 'dim', text: `${data.forced.map((f) => f.name).join('、')} 因上赛季的加薪纠纷，身价上浮并明确要求挂牌。转会窗里会有球队报价。` }),
      ]) : null,
      (data.focus?.length || data.quotes?.length) ? h('div', { class: 'card' }, [
        h('div', { class: 'card-title', text: '焦点故事' }),
        ...(data.focus || []).map((f) => {
          const p = g.players[f.id];
          return h('div', { class: 'locker-row', onClick: () => openPlayerModal(f.id) }, [
            h('div', { class: 'row between' }, [
              h('b', { text: f.name }),
              h('span', { class: 'mute', text: `${ROLE_NAME[p?.role] || ''} ${f.from} → ${f.to}` }),
            ]),
            h('div', { class: 'row wrap', style: { gap: '4px' } }, [traitPill(TRAIT_BY_ID[f.trait]), arcPill(f.arc)]),
          ]);
        }),
        ...(data.quotes || []).map((q) => h('p', { class: 'quote', text: q.text })),
      ]) : null,
      h('button', { class: 'primary block mt', text: '下一步：青训营', onClick: () => { state.offseasonStage = 'youth'; renderOffseason(); } }),
    );
    return;
  }

  if (state.offseasonStage === 'youth') {
    const sq = g.squads[g.userTeamId];
    const list = h('div', { class: 'p-grid' });
    for (const id of sq.youth || []) {
      const p = g.players[id];
      if (!p) continue;
      list.append(h('div', { class: 'p-card' }, [
        h('div', { class: 'row between' }, [
          h('div', {}, [h('div', { class: 'nm', text: p.name }), h('div', { class: 'role', text: `${ROLE_ICON[p.role]} ${ROLE_NAME[p.role]} · ${p.age} 岁` })]),
          h('div', { class: 'ovr', text: String(p.overall) }),
        ]),
        h('div', { class: 'mute', style: { fontSize: '11px' }, text: `潜力 ${p.potential} · 身价 ${p.value} 万 · 年薪 ${p.wage} 万` }),
      ]));
    }
    screen.append(
      stepBar,
      h('h1', { text: '青训营' }),
      h('div', { class: 'card hi' }, [
        h('div', { class: 'card-title', text: '本赛季新秀' }),
        h('p', { class: 'mute', text: '每支队伍每年自动补充一名青训新人。额外投入可以再抽一名，投入越高天赋越好，但立刻扣现金。' }),
        h('div', {}, (data.rookies || []).map((p) => h('span', { class: 'pill gold', text: `${p.name}（潜力 ${p.potential}）` }))),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-title', text: `青训名单（${(sq.youth || []).length} 人）` }),
        (sq.youth || []).length ? list : h('p', { class: 'dim', text: '暂无青训球员' }),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-title', text: '追加投入' }),
        h('p', { class: 'mute', text: `当前现金 ${Math.round(g.cash)} 万。投入在赛季结算时从现金扣除。` }),
        h('div', { class: 'btn-row' }, FINANCE.youthTiers.map((cost, i) => h('button', {
          text: `${cost} 万`,
          onClick: () => {
            const r = investYouth(g, g.__rng, i);
            if (!r.ok) return toast(r.reason);
            saveGame(g);
            toast(`签下 ${r.player.name}（潜力 ${r.player.potential}）`);
            renderOffseason();
          },
        }))),
      ]),
      h('div', { class: 'btn-row mt' }, [
        h('button', { class: 'ghost', text: '上一步', onClick: () => { state.offseasonStage = 'develop'; renderOffseason(); } }),
        h('button', { class: 'primary', text: '下一步：转会市场', onClick: () => { state.offseasonStage = 'market'; renderOffseason(); } }),
      ]),
    );
    return;
  }

  // 转会市场
  const market = data.market || { listings: [], offers: [] };
  const bill = teamWageBill(g, g.userTeamId);
  const cap = wageCap(g);
  const pending = (g.flags?.pendingTransferCost || 0);
  const pendingIn = (g.flags?.pendingTransferIncome || 0);

  const offerBox = h('div', { class: 'card danger' }, [
    h('div', { class: 'card-title', text: `其他战队的报价（${market.offers.length}）` }),
  ]);
  if (!market.offers.length) offerBox.append(h('p', { class: 'dim', text: '没有球队对你的球员感兴趣。' }));
  for (const o of market.offers) {
    offerBox.append(h('div', { class: 'card', style: { marginTop: '8px' } }, [
      h('div', { class: 'row between' }, [
        h('div', {}, [
          h('div', { style: { fontWeight: 700 }, text: `${o.playerName}（${ROLE_NAME[o.role]} · ${o.overall} · ${o.age} 岁）` }),
          h('div', { class: 'mute', text: `${TEAM_BY_ID[o.buyerId].name} 报价 ${o.fee} 万${o.aggressive ? ' · 强硬' : ' · 试探性'}` }),
        ]),
        h('div', { class: 'row' }, [
          h('button', {
            class: 'small gold',
            text: '接受',
            onClick: () => {
              const r = acceptOffer(g, o);
              if (!r.ok) return toast(r.reason);
              saveGame(g);
              toast(`卖出完成，到账 ${r.fee} 万（结算时入账）`);
              startOffseasonRefresh();
            },
          }),
          h('button', {
            class: 'small',
            text: '拒绝',
            onClick: () => {
              rejectOffer(g, o);
              saveGame(g);
              toast('已拒绝报价，队内士气受到影响');
              startOffseasonRefresh();
            },
          }),
        ]),
      ]),
    ]));
  }

  const listingBox = h('div', { class: 'card hi' }, [
    h('div', { class: 'card-title' }, [
      '转会市场',
      h('span', {
        class: `tag pill ${bill + 0 > cap ? 'red' : ''}`,
        text: `工资帽 ${bill} / ${cap} 万`,
      }),
    ]),
    h('p', { class: 'mute', text: `现金 ${Math.round(g.cash)} 万 · 已承诺买人 ${pending} 万 · 预计到账 ${pendingIn} 万。费用在赛季结算时统一扣除。` }),
  ]);
  if (!market.listings.length) listingBox.append(h('p', { class: 'dim', text: '市场上没有可交易的球员。' }));
  for (const l of market.listings) {
    const needWage = wageForTeam(l.value, g.userTeamId, g.players[l.playerId]);
    const overCap = bill + needWage > cap;
    const noCash = g.cash - pending < l.price;
    listingBox.append(h('div', { class: 'card', style: { marginTop: '8px' } }, [
      h('div', { class: 'row between' }, [
        h('div', {}, [
          h('div', { style: { fontWeight: 700 }, text: `${g.players[l.playerId]?.name || l.playerId}` }),
          h('div', { class: 'mute', text: `${ROLE_NAME[l.role]} · 实力 ${l.overall} · 潜力 ${l.potential} · ${l.age} 岁 · 原队 ${TEAM_BY_ID[l.sellerId].short}` }),
        ]),
        h('div', { style: { textAlign: 'right' } }, [
          h('div', { class: 'gold', style: { fontWeight: 700 }, text: `${l.price} 万` }),
          h('div', { class: 'mute', style: { fontSize: '11px' }, text: `年薪约 ${needWage} 万` }),
        ]),
      ]),
      h('button', {
        class: `small mt ${overCap || noCash ? '' : 'primary'}`,
        text: overCap ? '工资帽不足' : noCash ? '现金不足' : '签下他',
        disabled: overCap || noCash,
        onClick: () => {
          const r = signPlayer(g, l);
          if (!r.ok) return toast(r.reason);
          saveGame(g);
          toast(`签下 ${r.player.name}，费用 ${l.price} 万（结算时扣除）`);
          startOffseasonRefresh();
        },
      }),
    ]));
  }

  // 阵容调整
  const sq = g.squads[g.userTeamId];
  const lineup = h('div', { class: 'card' }, [h('div', { class: 'card-title', text: '首发调整' })]);
  for (const role of ROLE_ORDER) {
    const current = sq.starters.find((id) => g.players[id]?.role === role);
    const alts = (sq.bench || []).concat(sq.youth || []).filter((id) => g.players[id]?.role === role);
    lineup.append(h('div', { class: 'row wrap', style: { marginBottom: '8px' } }, [
      h('div', { style: { width: '58px', fontSize: '12px', color: 'var(--txt-dim)' }, text: ROLE_NAME[role] }),
      h('span', { class: 'pill gold', text: current ? `${g.players[current].name} ${g.players[current].overall}` : '空缺' }),
      ...alts.map((id) => h('button', {
        class: 'small',
        text: `${g.players[id].name} ${g.players[id].overall}`,
        onClick: () => {
          const r = setStarter(g, id, current);
          if (!r.ok) return toast(r.reason);
          saveGame(g);
          renderOffseason();
        },
      })),
    ]));
  }

  screen.append(
    stepBar,
    h('h1', { text: '转会市场' }),
    offerBox,
    listingBox,
    lineup,
    h('div', { class: 'btn-row mt' }, [
      h('button', { class: 'ghost', text: '上一步', onClick: () => { state.offseasonStage = 'youth'; renderOffseason(); } }),
      h('button', {
        class: 'gold',
        text: `结束休赛期，进入第 ${g.season + 1} 赛季`,
        onClick: () => {
          state.offseason = null;
          const nx = beginNextSeason(g);
          if (nx.type === 'gameOver') state.log = [{ kind: 'gameOver', gameOver: nx.gameOver }];
          else state.log = [newSeasonEvent(nx.season)];
          state.cursor = 0;
          saveGame(g);
          renderShell();
        },
      }),
    ]),
  );
}

/** 转会操作后重算一次市场与休赛期数据（保留成长报告） */
function startOffseasonRefresh() {
  const g = state.game;
  const keep = state.offseason;
  const data = beginOffseason(g, g.__rng);
  state.offseason = { ...data, mine: keep?.mine, risers: keep?.risers, fallers: keep?.fallers, rookies: keep?.rookies, forced: keep?.forced };
  state.offseasonStage = 'market';
  saveGame(g);
  renderOffseason();
}

/* ══════════════════════════ 测试出口（供 tools/ui-smoke.mjs 逐屏渲染验证） ══════════════════════════ */
export const __test = {
  state,
  renderStart,
  renderShell,
  renderOffice,
  renderRoster,
  renderLeague,
  renderFinance,
  renderCareer,
  renderEvent,
  renderOffseason,
  renderLockerRoom,
  renderTraining,
  renderMoneyDecision,
  openPlayerModal,
  progress,
  startOffseason,
  setGame(g) { state.game = g; },
  setTab(t) { state.tab = t; },
  /** 测试专用：固定抽卡随机种子，保证用例可复现 */
  setDraftSeed(n) { draftSeedOverride = n; },
  /** 测试专用：模拟窗口宽度（决定是分栏还是整页切换） */
  setViewportWidth(w) { viewportWidth = w; },
  useSplitLayout,
};

/* ══════════════════════════ 启动 ══════════════════════════ */
function boot() {
  if (hasSave()) {
    modal({
      title: '发现存档',
      body: '<p class="dim">要继续上一次的生涯吗？</p><p class="mute">若读取后界面异常，可随时在「生涯」页删除存档重开。</p>',
      dismissible: false,
      actions: [
        { label: '重新开始', cls: 'ghost', onClick: () => { clearSave(); renderStart(); } },
        {
          label: '继续生涯',
          cls: 'primary',
          onClick: () => {
            const g = loadGame();
            if (!g) { toast('存档已损坏且无法修复，请重新开始'); renderStart(); return; }
            state.game = g;
            state.pendingSeasonEnd = !currentStage(g) && !g.gameOver;
            state.offseason = null;
            state.log = [];
            state.cursor = 0;
            state.tab = 'office';
            renderShell();
            const fixed = g.__repair?.fixed || [];
            if (fixed.length) {
              console.warn('[存档已自动修复]', fixed);
              setTimeout(() => toast(`存档已自动修复 ${fixed.length} 处问题`), 400);
            }
          },
        },
      ],
    });
  }
  // 窗口尺寸跨过门槛时切换布局（分栏 <-> 整页）
  if (typeof window !== 'undefined' && window.addEventListener) {
    let last = null;
    window.addEventListener('resize', () => {
      const now = (window.innerWidth || 0) >= SPLIT_MIN_WIDTH;
      if (last === null) { last = now; return; }
      if (now !== last) { last = now; if (state.game) renderShell(); }
    });
  }
  renderStart();
}

boot();
