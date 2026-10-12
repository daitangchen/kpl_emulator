/**
 * 浏览器脚本冒烟测试：用最小 DOM 桩在 Node 里加载并"真渲染" app.js
 * 覆盖：模块加载 → 建队 → 存读档 → 完整赛季事件流 → 每个界面渲染 → 下一赛季
 * 用法：node tools/ui-smoke.mjs
 */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined || n === false) continue;
      // 注意：h() 会先 createTextNode 再 append，这里必须原样保留 Text 节点，
      // 否则会被二次字符串化成 "[object Object]"（真实浏览器不会）
      const node = (n instanceof El || n instanceof Text) ? n : new Text(String(n));
      if (node instanceof El) node.__parent = this;
      this.children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
  remove() {
    // 让 clear()/removeChild 在桩里真的生效
    if (this.__parent) this.__parent.children = this.__parent.children.filter((c) => c !== this);
  }
  addEventListener(type, fn) {
    (this._listeners = this._listeners || {});
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** 派发点击：让"点了没反应"这类 bug 能在测试里暴露 */
  click() {
    const fns = (this._listeners && this._listeners.click) || [];
    if (!fns.length) return false;
    for (const f of fns) f({ target: this, stopPropagation() {} });
    return true;
  }
  /** 递归收集自身与所有后代 */
  all(out = []) {
    out.push(this);
    for (const c of this.children) if (c instanceof El) c.all(out);
    return out;
  }
  /** 按文本正则找可点元素 */
  findClickable(re) {
    return this.all().filter((e) => (e._listeners?.click || []).length && re.test(e.textContent || ''));
  }
}
class Text { constructor(t) { this._t = String(t); } get textContent() { return this._t; } }

const ids = ['app', 'topbar', 'screen', 'tabbar', 'modal-root', 'toast-root'];
const els = Object.fromEntries(ids.map((id) => [id, new El('div')]));
const store = new Map();

globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => new Text(t),
  createDocumentFragment: () => new El('fragment'),
  getElementById: (id) => els[id] || null,
  body: new El('body'),
  addEventListener() {},
};
globalThis.window = { addEventListener() {}, location: { href: 'http://127.0.0.1:8123/' } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.Node = El;
globalThis.setTimeout = (fn) => { try { fn(); } catch { /* 忽略延时回调异常 */ } return 0; };

let errors = 0;
const check = (label, fn) => {
  try {
    const r = fn();
    console.log(`  ✓ ${label}${r ? ' — ' + r : ''}`);
    return true;
  } catch (e) {
    errors += 1;
    console.error(`  ✗ ${label}: ${e.message}`);
    console.error('     ' + (e.stack || '').split('\n').slice(1, 3).join('\n     '));
    return false;
  }
};

console.log('① 加载 app.js …');
let app;
try {
  app = await import('../src/ui/app.js');
  console.log('  ✓ 模块加载成功（所有 import 解析通过）');
} catch (e) {
  console.error('  ✗ 模块加载失败:', e.message);
  console.error(e.stack);
  process.exit(1);
}

const stateMod = await import('../src/core/state.js');
const { createGame, advanceOnce, saveGame, loadGame, hasSave, matchdayIncome } = stateMod;
const seasonMod = await import('../src/sim/season.js');
const transferMod = await import('../src/sim/transfer.js');
const { currentStage, beginNextSeason } = seasonMod;
const { eventsFromResult } = await import('../src/ui/events.js');
const { rollEvent, resolveEvent, EVENTS } = await import('../src/sim/events.js');

console.log('② 选队界面 → 建队 …');
app.__test.setDraftSeed(20261009);   // 固定抽卡随机源，保证用例可复现
check('renderStart 渲染 18 支战队可选', () => {
  app.__test.renderStart();
  const n = els.screen.children.length;
  if (n === 0) throw new Error('screen 为空');
  return `${n} 个顶层节点`;
});

check('真点击：18 支战队选择按钮全部可用', () => {
  const teams = els.screen.all().filter((e) => e.classList.contains('team-opt'));
  if (teams.length !== 18) throw new Error(`可选战队数量错误：${teams.length}`);
  for (const t of teams) {
    if (!t.click()) throw new Error(`战队按钮没有绑定点击事件：${t.textContent}`);
  }
  // 选完战队后进入抽卡：此时开始按钮应禁用，并渲染出 5 个「抽卡」按钮
  const draws = els.screen.findClickable(/^抽卡$/);
  if (draws.length !== 5) throw new Error(`抽卡按钮数量错误：${draws.length}（应为 5）`);
  const startBtn = els.screen.findClickable(/赛季|还需抽|请选择战队/)[0];
  if (!startBtn) throw new Error('找不到开始按钮');
  if (!startBtn.attrs.disabled) throw new Error('抽卡未完成时开始按钮不应可用');
  return `18/18 可点；5 个位置待抽卡，开始按钮文案「${startBtn.textContent}」`;
});

check('抽卡建队：18 支战队都能抽满 5 个位置并解锁开始（历史 bug：位置行全空）', () => {
  const teams = els.screen.all().filter((e) => e.classList.contains('team-opt'));
  const report = [];
  for (const t of teams) {
    t.click();
    // 逐个位置点「抽卡」，抽满后应能解锁开始按钮
    for (let i = 0; i < 5; i += 1) {
      const btn = els.screen.findClickable(/^抽卡$/)[0];
      if (!btn) break;
      btn.click();
    }
    const txt = els.screen.textContent || '';
    const startBtn = els.screen.findClickable(/赛季/)[0];
    if (!startBtn) throw new Error(`战队 ${t.textContent.slice(0, 6)} 找不到开始按钮`);
    if (startBtn.attrs.disabled) throw new Error(`战队 ${t.textContent.slice(0, 6)} 抽满 5 人后开始按钮仍禁用`);
    // 5 个位置都应该有球员与稀有度标签
    if (!/SSR|SR|R|N/.test(txt)) throw new Error(`战队 ${t.textContent.slice(0, 6)} 没有渲染稀有度标签`);
    const rerolls = els.screen.findClickable(/重抽/);
    if (rerolls.length !== 5) throw new Error(`战队 ${t.textContent.slice(0, 6)} 重抽按钮数量错误：${rerolls.length}`);
    // 记下抽到的综合评分，验证抽卡确实产生了球员
    report.push(txt.match(/首发战力(\d+(\.\d+)?)/)?.[1]);
  }
  return `18 支战队抽卡流程正常，首发战力样本：${report.slice(0, 5).join(' / ')}`;
});

const rngRef = { value: null };
const { createRng } = await import('../src/core/rng.js');
rngRef.value = createRng(424242);

let game;
check('真点击：开始第 1 赛季（历史 bug 复现点）', () => {
  const startBtn = els.screen.findClickable(/赛季/)[0];
  if (!startBtn.click()) throw new Error('开始按钮没有绑定点击事件');
  const g = app.__test.state.game;
  if (!g) throw new Error('点击后 state.game 仍为空 —— 建队失败');
  game = g;
  game.__rng = rngRef.value;
  if (!game.squads[game.userTeamId]) throw new Error('新档没有该队名册');
  if (game.squads[game.userTeamId].starters.length !== 5) throw new Error('首发不是 5 人');
  // 顶栏与主界面必须已经渲染出来
  if (els.topbar.children.length === 0) throw new Error('顶栏没有渲染');
  if (els.tabbar.children.length === 0) throw new Error('底部导航没有渲染');
  if (els.screen.children.length === 0) throw new Error('主界面没有渲染');
  // 抽卡可能抽到别队球员：必须没有球员同时属于两支队伍
  const owner = {};
  for (const [tid, s] of Object.entries(game.squads)) {
    for (const k of ['starters', 'bench', 'youth']) for (const id of s[k] || []) (owner[id] = owner[id] || []).push(tid);
  }
  const dup = Object.entries(owner).filter(([, ts]) => ts.length > 1);
  if (dup.length) throw new Error(`有 ${dup.length} 名球员同时属于多支队伍`);
  // 全联盟每队首发都必须是 5 人（被抽走的队伍要自动补位）
  const broken = Object.entries(game.squads).filter(([, s]) => s.starters.length !== 5);
  if (broken.length) throw new Error(`${broken.length} 支队伍开季首发不足 5 人：${broken.map((b) => b[0]).join(',')}`);
  return `已就任 ${game.teams[game.userTeamId].name}，现金 ${game.cash} 万，首发 ${game.squads[game.userTeamId].starters.map((id) => game.players[id].name).join(' ')}`;
});

check('存档 / 读档', () => {
  saveGame(game);
  if (!hasSave()) throw new Error('写入失败');
  const g2 = loadGame();
  if (!g2) throw new Error('读档为空');
  if (g2.userTeamId !== game.userTeamId) throw new Error(`战队不一致：${g2.userTeamId} != ${game.userTeamId}`);
  if (g2.stages.length !== game.stages.length) throw new Error('赛程阶段数不一致');
  if (g2.squads[g2.userTeamId].starters.length !== 5) throw new Error('读档后首发不是 5 人');
  if (g2.__repair?.fixed?.length) throw new Error(`干净存档不该触发修复：${g2.__repair.fixed.join('；')}`);
  // 读档后必须还能继续推进（RNG 能恢复）
  const { advanceOnce: adv } = stateMod;
  const before = g2.stageIndex;
  const r = adv(g2, {});
  if (!r.type) throw new Error('读档后推进无返回');
  return `往返一致（${g2.userTeamId}），读档后可继续推进（stageIndex ${before} → ${g2.stageIndex}，返回 ${r.type}）`;
});

console.log('②b 坏档自检与修复（历史 bug 复现点）…');
const { squadOf } = await import('../src/data/players.js');
const corrupt = (mutate) => {
  saveGame(createGame({ userTeamId: 'ag', starterIds: squadOf('ag').starters.map((p) => p.id) }));
  const raw = JSON.parse(store.get('kpl_gm_save_v1'));
  mutate(raw);
  store.set('kpl_gm_save_v1', JSON.stringify(raw));
  return stateMod.loadGame();
};
const renderTabsOk = (g) => {
  app.__test.setGame(g);
  for (const tab of ['office', 'roster', 'training', 'league', 'finance', 'career']) {
    app.__test.setTab(tab);
    app.__test.state.cursor = 999;
    app.__test.renderShell();
    if (els.screen.children.length === 0) throw new Error(`${tab} 渲染为空`);
  }
};

check('坏档：userTeamId 丢失 → 回退到有效战队且五页全可渲染', () => {
  const g = corrupt((raw) => { delete raw.userTeamId; });
  if (!g) throw new Error('loadGame 返回 null');
  if (!g.teams[g.userTeamId]) throw new Error('修复后 userTeamId 仍无效');
  renderTabsOk(g);
  return `回退为 ${g.teams[g.userTeamId].name}，修复 ${g.__repair.fixed.length} 项`;
});

check('坏档：名册被清空 → 按 2026 真实名单重建', () => {
  const g = corrupt((raw) => { raw.squads[raw.userTeamId] = { starters: [], bench: [], youth: [] }; });
  const sq = g.squads[g.userTeamId];
  if (sq.starters.length !== 5) throw new Error(`重建后首发仍是 ${sq.starters.length} 人`);
  if (sq.starters.some((id) => !g.players[id]?.name)) throw new Error('重建后存在无名球员');
  renderTabsOk(g);
  return `首发 ${sq.starters.map((id) => g.players[id].name).join(' ')}`;
});

check('坏档：赛程丢失 → 重置本赛季赛程', () => {
  const g = corrupt((raw) => { raw.stages = []; });
  if (g.stages.length === 0) throw new Error('赛程未重建');
  renderTabsOk(g);
  return `重建 ${g.stages.length} 个阶段`;
});

check('坏档：非法 JSON → loadGame 返回 null（引导重新开始）', () => {
  store.set('kpl_gm_save_v1', '{not json');
  if (loadGame() !== null) throw new Error('非法 JSON 应返回 null');
  return '安全返回 null';
});

// 坏档测试污染了 localStorage，这里把主存档写回并把界面切回主 game，避免影响后续用例
saveGame(game);
app.__test.setGame(game);
app.__test.setTab('office');

console.log('③ 推进整个赛季，逐条渲染事件 …');
const seen = new Set();
let evCardsSeen = 0;

/** 快照/还原 game（JSON 会把 __rng 拍平成普通对象，必须还原成真 RNG 实例） */
const snapGame = () => JSON.stringify(game);
const restoreGame = (snap) => {
  Object.assign(game, JSON.parse(snap));
  game.__rng = rngRef.value;
};

check('完整赛季 + 每条事件都渲染', () => {
  let guard = 0;
  while (guard < 400) {
    guard += 1;
    const stage = currentStage(game);
    const r = advanceOnce(game, {});
    const evs = eventsFromResult(game, r, stage || {});
    for (const ev of evs) {
      seen.add(ev.kind);
      if (ev.kind === 'eventCard') {
        evCardsSeen += 1;
        // 每个选项都试一次（用快照还原，避免污染主存档）
        const snapshot = snapGame();
        for (const c of ev.card.choices) {
          const res = resolveEvent(game, ev.card.id, c.index);
          if (!res.ok) throw new Error(`事件 ${ev.card.id} 选项 ${c.index} 失败: ${res.reason}`);
        }
        restoreGame(snapshot);
      }
      app.__test.state.log = [ev];
      app.__test.state.cursor = 0;
      app.__test.renderEvent(ev);
    }
    if (r.type === 'seasonEnd') break;
  }
  return `事件类型：${[...seen].join(' / ')}（突发事件 ${evCardsSeen} 次）`;
});

check('全部突发事件模板都能实例化并结算', () => {
  let n = 0;
  const snapshot = snapGame();
  for (const ev of EVENTS) {
    if (!ev.when(game)) continue;
    for (let i = 0; i < ev.choices.length; i += 1) {
      const res = resolveEvent(game, ev.id, i);
      if (!res.ok) throw new Error(`${ev.id} 选项 ${i}: ${res.reason}`);
    }
    n += 1;
  }
  restoreGame(snapshot);
  return `${n} 个可触发模板 × 全部选项通过（共 ${EVENTS.length} 个模板）`;
});

console.log('④ 逐屏渲染 …');
for (const [tab, fn] of [['office', 'renderOffice'], ['roster', 'renderRoster'], ['training', 'renderTraining'], ['league', 'renderLeague'], ['finance', 'renderFinance'], ['career', 'renderCareer']]) {
  check(`渲染「${tab}」`, () => {
    app.__test.setTab(tab);
    app.__test[fn]();
    const n = els.screen.children.length;
    if (n === 0) throw new Error('screen 为空');
    return `${n} 个顶层节点`;
  });
}

check('顶栏与底部导航渲染', () => {
  app.__test.state.cursor = 999; // 跳过事件队列，回到 tab 页
  app.__test.renderShell();
  if (els.topbar.children.length === 0) throw new Error('顶栏为空');
  if (els.tabbar.children.length === 0) throw new Error('导航为空');
  return `${els.topbar.children.length} 顶栏节点 / ${els.tabbar.children.length} 个页签`;
});

console.log('⑤ 赛季结算 → 休赛期（成长 / 青训 / 转会）→ 下一赛季 …');
check('beginOffseason 成长结算', () => {
  const g = app.__test.state.game;
  const { beginOffseason } = seasonMod;
  const data = beginOffseason(g, g.__rng);
  if (!data.development?.length) throw new Error('没有成长数据');
  if (!data.market) throw new Error('没有生成转会市场');
  app.__test.state.offseason = data;
  const moved = data.development.filter((d) => d.to !== d.from).length;
  return `${data.development.length} 人结算，${moved} 人能力变化，市场 ${data.market.listings.length} 条挂牌 / ${data.market.offers.length} 条报价`;
});

for (const st of ['develop', 'youth', 'market']) {
  check(`渲染休赛期「${st}」`, () => {
    app.__test.state.offseasonStage = st;
    app.__test.renderOffseason();
    const n = els.screen.children.length;
    if (n === 0) throw new Error('screen 为空');
    return `${n} 个顶层节点`;
  });
}

check('青训投入 + 买人 + 卖人 + 首发调整', () => {
  const g = app.__test.state.game;
  const { investYouth, signPlayer, acceptOffer, setStarter, teamWageBill, wageCap, wageForTeam } = transferMod;
  const youth = investYouth(g, g.__rng, 1);
  if (!youth.ok) throw new Error('青训投入失败: ' + youth.reason);
  // 只挑"现金够 + 工资帽也放得下"的球员，否则会因工资帽被拒（这不是 bug）
  const bill = teamWageBill(g, g.userTeamId);
  const cap = wageCap(g);
  const listing = g.market.listings.find((l) => g.cash - (g.flags.pendingTransferCost || 0) >= l.price
    && bill + wageForTeam(l.value, g.userTeamId, g.players[l.playerId]) <= cap);
  let bought = '工资帽/现金下暂无可签球员';
  if (listing) {
    const r = signPlayer(g, listing);
    if (!r.ok) throw new Error('买人失败: ' + r.reason);
    bought = `买入 ${r.player.name}（${listing.price} 万）`;
  }
  const offer = g.market.offers[0];
  let sold = '无报价';
  if (offer) {
    const r = acceptOffer(g, offer);
    if (!r.ok) throw new Error('卖人失败: ' + r.reason);
    sold = `卖出 ${offer.playerName}（到账 ${r.fee} 万）`;
  }
  return `${youth.player.name}(潜力${youth.player.potential}) / ${bought} / ${sold} / 工资 ${teamWageBill(g, g.userTeamId)}-${wageCap(g)}`;
});

let nextSeasonOk = false;
check('beginNextSeason', () => {
  const g = app.__test.state.game;
  const nx = seasonMod.beginNextSeason(g);
  if (!nx.type) throw new Error('无返回类型');
  nextSeasonOk = nx.type === 'newSeason';
  if (nextSeasonOk && (g.squads[g.userTeamId].starters.length !== 5)) {
    throw new Error('新赛季首发不是 5 人');
  }
  return nx.type === 'newSeason' ? `进入第 ${nx.season} 赛季` : `${nx.type}（${nx.gameOver?.title || ''}）`;
});

if (nextSeasonOk) {
  check('第 2 赛季仍能推进与渲染', () => {
    let guard = 0;
    while (guard < 30) {
      guard += 1;
      const stage = currentStage(game);
      const r = advanceOnce(game, {});
      const evs = eventsFromResult(game, r, stage || {});
      app.__test.state.log = evs;
      app.__test.state.cursor = 0;
      app.__test.renderShell();
      if (r.type === 'seasonEnd') break;
    }
    return `推进 ${guard} 步无异常`;
  });
}

console.log('⑥ 选手个人剧情线（性格 / 成长弧 / 采访）…');
const storyMod = await import('../src/sim/story.js');
const { TRAITS, TRAIT_BY_ID, arcOf, matchQuote, ensureTraits } = storyMod;

check('新建档：全体球员都有性格与成长历史', () => {
  const g = app.__test.state.game;
  const players = Object.values(g.players);
  const noTrait = players.filter((p) => !p.trait);
  const badTrait = players.filter((p) => p.trait && !TRAIT_BY_ID[p.trait]);
  const noHist = players.filter((p) => !Array.isArray(p.history) || !p.history.length);
  if (noTrait.length) throw new Error(`${noTrait.length} 名球员没有性格`);
  if (badTrait.length) throw new Error(`${badTrait.length} 名球员性格非法`);
  if (noHist.length) throw new Error(`${noHist.length} 名球员没有成长历史`);
  const dist = {};
  for (const p of players) dist[p.trait] = (dist[p.trait] || 0) + 1;
  return `${players.length} 人，覆盖 ${Object.keys(dist).length}/${TRAITS.length} 种性格`;
});

check('性格分配是确定性的（同一 id 恒等）', () => {
  const a = storyMod.assignTrait({ id: 'xuanran', overall: 80, potential: 86 });
  const b = storyMod.assignTrait({ id: 'xuanran', overall: 80, potential: 86 });
  if (a.trait !== b.trait) throw new Error('同 id 两次分配不一致');
  const other = storyMod.assignTrait({ id: 'zhongyi', overall: 85, potential: 90 });
  return `轩染=${a.trait}，钟意=${other.trait}`;
});

check('老存档兼容：缺性格/成长历史可被补齐', () => {
  const g = app.__test.state.game;
  const id = g.squads[g.userTeamId].starters[0];
  delete g.players[id].trait;
  delete g.players[id].history;
  ensureTraits(g);
  const p = g.players[id];
  if (!p.trait) throw new Error('未补齐性格');
  if (!Array.isArray(p.history)) throw new Error('未补齐成长历史');
  return `${p.name} → ${p.trait}`;
});

check('成长弧推断：老将下滑 / 新星崛起各有归属', () => {
  const veteran = { id: 'v', age: 31, overall: 78, potential: 82, history: [{ s: 3, o: 84 }, { s: 4, o: 78 }] };
  const rising = { id: 'r', age: 19, overall: 65, potential: 88, history: [{ s: 3, o: 60 }, { s: 4, o: 65 }] };
  const av = arcOf(veteran); const ar = arcOf(rising);
  if (!['twilight', 'slump'].includes(av.key)) throw new Error('老将弧线异常: ' + av.key);
  if (!['rising', 'breakout'].includes(ar.key)) throw new Error('新星弧线异常: ' + ar.key);
  return `老将=${av.label} / 新星=${ar.label}`;
});

check('赛后采访：玩家比赛能生成符合性格的发言', () => {
  const g = app.__test.state.game;
  const pid = g.userTeamId;
  const opp = Object.keys(g.teams).find((x) => x !== pid);
  const q = matchQuote(g, { a: pid, b: opp, winnerId: pid });
  if (!q) throw new Error('未生成采访');
  if (!TRAIT_BY_ID[q.trait]) throw new Error('采访性格非法');
  if (!q.text.includes('「')) throw new Error('采访文本格式异常: ' + q.text);
  const q2 = matchQuote(g, { a: opp, b: 'ag', winnerId: opp });
  if (q2 !== null) throw new Error('非玩家比赛不应生成采访');
  return q.text;
});

check('球员档案弹窗能渲染（性格 / 成长弧 / 语录）', () => {
  const g = app.__test.state.game;
  const id = g.squads[g.userTeamId].starters[0];
  app.__test.openPlayerModal(id);
  const box = els['modal-root'];
  if (!box || box.children.length === 0) throw new Error('弹窗没有渲染');
  const txt = box.textContent || '';
  const p = g.players[id];
  const trait = TRAIT_BY_ID[p.trait];
  if (!txt.includes(trait.name)) throw new Error('弹窗缺少性格名');
  if (!txt.includes(arcOf(p).label)) throw new Error('弹窗缺少成长弧');
  if (!txt.includes('近期发言')) throw new Error('弹窗缺少语录');
  return `${p.name}: ${trait.name} / ${arcOf(p).label}`;
});

check('阵容页球员卡带性格标签且可点击', () => {
  app.__test.setTab('roster');
  app.__test.state.cursor = 999;
  app.__test.renderShell();
  const cards = els.screen.all().filter((e) => e.classList.contains('p-card'));
  if (!cards.length) throw new Error('没有球员卡');
  const clickable = cards.filter((e) => (e._listeners?.click || []).length);
  if (clickable.length < cards.length) throw new Error(`可点击球员卡过少: ${clickable.length}/${cards.length}`);
  const txt = els.screen.textContent || '';
  if (!TRAITS.some((t) => txt.includes(t.name))) throw new Error('阵容页没有渲染任何性格标签');
  // 真点击一张卡，应弹出档案
  cards[0].click();
  if ((els['modal-root'].children || []).length === 0) throw new Error('点击球员卡没有弹出档案');
  return `${cards.length} 张球员卡，全部可点`;
});

check('办公室渲染「更衣室动态」', () => {
  app.__test.setTab('office');
  app.__test.state.cursor = 999;
  app.__test.renderShell();
  const txt = els.screen.textContent || '';
  if (!txt.includes('更衣室动态')) throw new Error('办公室缺少更衣室动态');
  return '更衣室动态已渲染';
});

check('休赛期「焦点故事」渲染', () => {
  const g = app.__test.state.game;
  const { beginOffseason } = seasonMod;
  const data = beginOffseason(g, g.__rng);
  app.__test.state.offseason = data;
  app.__test.state.offseasonStage = 'develop';
  app.__test.renderOffseason();
  const txt = els.screen.textContent || '';
  if (!txt.includes('焦点故事')) throw new Error('休赛期缺少焦点故事');
  if (!data.quotes?.length) throw new Error('休赛期没有生成采访');
  if (!data.mine?.[0]?.arc) throw new Error('成长报告缺少成长弧字段');
  return `焦点 ${data.focus?.length || 0} 人 / 采访 ${data.quotes.length} 条`;
});

check('赛果界面渲染赛后采访', () => {
  const g = app.__test.state.game;
  const pid = g.userTeamId;
  const opp = Object.keys(g.teams).find((x) => x !== pid);
  const series = { a: pid, b: opp, scoreA: 3, scoreB: 1, winnerId: pid, isPlayer: true, finalScore: '3-1', games: [{ no: 1, winner: 'A', scoreAfter: '1-0' }] };
  const ev = {
    kind: 'matchday', stageName: 'KPL 春季赛', roundName: '第一轮', roundIndex: 1,
    day: 1, totalDays: 5, results: [series], groups: g.groupsByRound[1] || { S: [], A: [], B: [] },
    tables: {}, eliminated: [], playerResult: series, finished: false,
  };
  app.__test.state.log = [ev];
  app.__test.state.cursor = 0;
  app.__test.renderShell();
  const txt = els.screen.textContent || '';
  if (!txt.includes('赛后采访')) throw new Error('赛果界面没有赛后采访');
  return '赛后采访已渲染';
});

console.log('⑦ 本轮三项改动：分组重组 / 抽卡建队 / 资金决策 …');
const draftMod = await import('../src/sim/draft.js');
const trainMod = await import('../src/sim/training.js');
const groupsMod = await import('../src/sim/groups.js');

check('① 重组严格按第一轮组内名次（各组1-2→S，3-4→A，5-6→B）', () => {
  let bad = 0; let checked = 0;
  for (const tid of ['syg', 'ag', 'we', 'rngm']) {
    const g = createGame({ userTeamId: tid });
    g.__rng = createRng(2026 + tid.length * 7);
    let guard = 0;
    while (guard++ < 200) {
      const st = currentStage(g);
      if (st && st.kind === 'regroup') break;
      advanceOnce(g, {});
    }
    const g1 = g.groupsByRound[1];
    const t1 = g.tablesByRound[1];
    advanceOnce(g, {}); // 执行重组
    const g2 = g.groupsByRound[2];
    for (const d of ['S', 'A', 'B']) {
      const ranked = groupsMod.rankTeams(g1[d], t1[d]);
      const expect = { S: ranked.slice(0, 2), A: ranked.slice(2, 4), B: ranked.slice(4, 6) };
      for (const [nd, ids] of Object.entries(expect)) {
        for (const id of ids) {
          checked += 1;
          if (!g2[nd].includes(id)) bad += 1;
        }
      }
    }
  }
  if (bad) throw new Error(`${bad}/${checked} 个位置的重组结果与第一轮名次不符`);
  return `${checked} 个位置全部正确`;
});

check('② 抽卡：稀有度概率、保底、重抽计费、资金不足拦截', () => {
  const rng = createRng(20261009);
  const cnt = {};
  for (let i = 0; i < 12000; i += 1) {
    const d = draftMod.createDraft();
    const p = draftMod.drawRole(rng, d, 'mid');
    const k = draftMod.rarityOf(p).key;
    cnt[k] = (cnt[k] || 0) + 1;
  }
  const pct = (k) => ((cnt[k] || 0) / 120).toFixed(1);
  const ssr = (cnt.SSR || 0) / 12000;
  if (ssr < 0.04 || ssr > 0.13) throw new Error(`SSR 概率异常：${(ssr * 100).toFixed(1)}%`);
  if ((cnt.N || 0) / 12000 < 0.15) throw new Error('N 概率异常');
  // 保底：pity 到 2 时必出史诗及以上
  const dp = draftMod.createDraft();
  dp.pity.mid = 2;
  const pityDraw = draftMod.drawRole(rng, dp, 'mid');
  if (draftMod.rarityIndex(pityDraw) > 1) throw new Error('保底失效：未抽到史诗及以上');
  // 重抽计费
  const d2 = draftMod.createDraft();
  draftMod.drawRole(rng, d2, 'mid');
  if (draftMod.rerollCost(d2) !== 0) throw new Error('第 1 次重抽应免费');
  for (let i = 0; i < 4; i += 1) draftMod.reroll(rng, d2, 'mid', 99999);
  const paid = draftMod.rerollCost(d2);
  if (paid <= 0) throw new Error('免费次数用完后重抽应收费');
  const denied = draftMod.reroll(rng, d2, 'mid', 0);
  if (denied.ok) throw new Error('资金为 0 时不应允许付费重抽');
  // 抽满判定
  const d3 = draftMod.createDraft();
  for (const r of ['top', 'jungle', 'mid', 'adc', 'support']) draftMod.drawRole(rng, d3, r);
  if (!draftMod.draftReady(d3)) throw new Error('抽满 5 个位置后 draftReady 仍为 false');
  if (new Set(draftMod.draftStarters(d3)).size !== 5) throw new Error('抽卡出现重复球员');
  return `SSR ${pct('SSR')}% / SR ${pct('SR')}% / R ${pct('R')}% / N ${pct('N')}%；第 5 次重抽 ${paid} 万`;
});

check('③ 资金决策：特训加属性、扣现金、成本递增、有赛季上限', () => {
  const g = createGame({ userTeamId: 'ag' });
  const pid = g.userTeamId;
  const p = g.players[g.squads[pid].starters[0]];
  const cash0 = g.cash;
  const lane0 = p.laning;
  const r1 = trainMod.trainAttr(g, p.id, 'laning');
  if (!r1.ok) throw new Error('特训失败: ' + r1.reason);
  if (p.laning !== lane0 + 1) throw new Error('属性没有 +1');
  if (g.cash !== cash0 - r1.cost) throw new Error('现金扣除不正确');
  if (g.flags.trainingSpend !== r1.cost) throw new Error('训练投入没有累计到 flags');
  const c2 = trainMod.attrCost(g, p, 'laning');
  if (c2 <= r1.cost) throw new Error('边际成本没有递增');
  for (let i = 0; i < 10; i += 1) trainMod.trainAttr(g, p.id, 'laning');
  const used = g.training[p.id].laning;
  if (used > trainMod.SEASON_CAP_PER_ATTR) throw new Error(`超过单项上限：${used}`);
  if (trainMod.trainAttr(g, p.id, 'laning').ok) throw new Error('超过上限仍然成功');
  const m0 = g.morale[pid];
  const rt = trainMod.trainTeam(g, 'morale');
  if (!rt.ok) throw new Error('团队投入失败: ' + rt.reason);
  if (g.morale[pid] <= m0) throw new Error('士气没有提升');
  const g2 = createGame({ userTeamId: 'wst' });
  g2.cash = 10;
  const poor = trainMod.trainAttr(g2, g2.squads[g2.userTeamId].starters[0], 'laning');
  if (poor.ok) throw new Error('现金不足时仍允许特训');
  return `首次 ${r1.cost} 万 → 二级 ${c2} 万；单项上限 ${trainMod.SEASON_CAP_PER_ATTR}、总额上限 ${trainMod.SEASON_CAP_TOTAL}`;
});

check('④ 训练页渲染 + 真点击 +1 生效', () => {
  const g = createGame({ userTeamId: 'ag' });
  app.__test.setGame(g);
  app.__test.setTab('training');
  app.__test.state.cursor = 999;
  app.__test.renderShell();
  const txt = els.screen.textContent || '';
  if (!txt.includes('训练中心')) throw new Error('训练页没有渲染');
  if (!txt.includes('团队投入')) throw new Error('缺少团队投入区');
  const btn = els.screen.findClickable(/^\d+ \+1$/)[0];
  if (!btn) throw new Error('找不到 +1 按钮');
  const cash0 = g.cash;
  if (!btn.click()) throw new Error('+1 按钮没有绑定点击事件');
  if (!(g.cash < cash0)) throw new Error('点击 +1 没有扣钱');
  if (!(els.screen.textContent || '').includes('训练中心')) throw new Error('点击后页面异常');
  return `点击 +1 生效：现金 ${Math.round(cash0)} → ${Math.round(g.cash)} 万`;
});

check('⑤ 赛果页出现「本轮资金决策」并可一键特训', () => {
  const g = app.__test.state.game;
  const pid = g.userTeamId;
  const opp = Object.keys(g.teams).find((x) => x !== pid);
  const series = { a: pid, b: opp, scoreA: 3, scoreB: 1, winnerId: pid, isPlayer: true, finalScore: '3-1', games: [{ no: 1, winner: 'A', scoreAfter: '1-0' }] };
  const ev = {
    kind: 'matchday', stageName: 'KPL 春季赛', roundName: '第一轮', roundIndex: 1,
    day: 1, totalDays: 5, results: [series], groups: g.groupsByRound[1] || { S: [], A: [], B: [] },
    tables: {}, eliminated: [], playerResult: series, finished: false,
  };
  app.__test.state.log = [ev];
  app.__test.state.cursor = 0;
  app.__test.renderShell();
  const txt = els.screen.textContent || '';
  if (!txt.includes('本轮资金决策')) throw new Error('赛果页没有资金决策环节');
  const quick = els.screen.findClickable(/特训 .+「.+」\+1/)[0];
  if (!quick) throw new Error('缺少快捷特训按钮');
  const cash0 = g.cash;
  quick.click();
  if (!(g.cash < cash0)) throw new Error('快捷特训没有扣钱');
  return `资金决策已渲染，快捷特训生效（${Math.round(cash0)} → ${Math.round(g.cash)} 万）`;
});

console.log('⑧ 本轮三项改动：快速模拟比分 / 卡位赛配对 / BO7 分段与中场调整 …');
const { teamPower } = await import('../src/sim/team.js');

check('① 非玩家比赛不再清一色 3-0，且强者胜率更高', () => {
  const g = createGame({ userTeamId: 'syg' });
  g.__rng = createRng(31337);
  const dist = {};
  const powerRank = Object.keys(g.teams).sort((a, b) => teamPower(g, b) - teamPower(g, a));
  const strong = new Set(powerRank.slice(0, 6));
  const weak = new Set(powerRank.slice(12));
  let strongWins = 0; let weakWins = 0;
  let guard = 0;
  while (guard++ < 400) {
    const r = advanceOnce(g, {});
    if (r.type === 'matchday') {
      for (const m of r.results) {
        if (m.isPlayer) continue;
        const k = `${Math.max(m.scoreA, m.scoreB)}-${Math.min(m.scoreA, m.scoreB)}`;
        dist[k] = (dist[k] || 0) + 1;
        const w = m.winnerId;
        if (strong.has(w)) strongWins += 1;
        else if (weak.has(w)) weakWins += 1;
      }
    }
    if (r.type === 'seasonEnd') break;
  }
  const kinds = Object.keys(dist).sort();
  if (!dist['3-1'] || !dist['3-2']) throw new Error(`比分种类不足：${JSON.stringify(dist)}`);
  const zero = dist['3-0'] / (dist['3-0'] + dist['3-1'] + dist['3-2']);
  if (zero > 0.6) throw new Error(`3-0 占比过高：${(zero * 100).toFixed(0)}%`);
  if (!(strongWins > weakWins)) throw new Error(`强者没有赢更多：强 ${strongWins} vs 弱 ${weakWins}`);
  return `3-0 ${dist['3-0']} / 3-1 ${dist['3-1']} / 3-2 ${dist['3-2']}；强队胜 ${strongWins} 次 vs 弱队胜 ${weakWins} 次`;
});

check('② 卡位赛按第二轮名次配对，胜者进高组', () => {
  let bad = 0; let total = 0;
  for (let seed = 1; seed <= 12; seed += 1) {
    const g = createGame({ userTeamId: 'syg' });
    g.__rng = createRng(seed * 131);
    let cardResult = null; let guard = 0;
    while (guard++ < 400) { const r = advanceOnce(g, {}); if (r.type === 'card') { cardResult = r; break; } }
    const t2 = g.tablesByRound[2];
    const rank = {};
    for (const d of ['S', 'A', 'B']) rank[d] = groupsMod.rankTeams(g.groupsByRound[2][d], t2[d]);
    const div2 = (id) => ['S', 'A', 'B'].find((d) => g.groupsByRound[2][d].includes(id));
    const div3 = (id) => ['S', 'A', 'B'].find((d) => g.groupsByRound[3][d].includes(id));
    for (const c of cardResult.cards) {
      total += 1;
      const hd = div2(c.a); const ld = div2(c.b);
      const hi = rank[hd].indexOf(c.a); const li = rank[ld].indexOf(c.b);
      const okPair = ((hd === 'S' && ld === 'A') || (hd === 'A' && ld === 'B'))
        && ((hi === 4 && li === 1) || (hi === 5 && li === 0));
      if (!okPair) { bad += 1; continue; }
      if (div3(c.winnerId) !== hd || div3(c.loserId) !== ld) bad += 1;
    }
  }
  if (bad) throw new Error(`${bad}/${total} 场卡位赛配对或升降错误`);
  return `${total} 场卡位赛：配对按名次、胜者进高组、负者留低组，全部正确`;
});

check('③ BO7 分段：上半场 3 局 → 挂起 → 中场调整 → 下半场 → 巅峰对决', () => {
  const g = createGame({ userTeamId: 'ag' });
  g.__rng = createRng(4242);
  let pauses = 0; let sawDecider = false; let swapped = false; let boosted = false; let lineupPauses = 0;
  let guard = 0;
  while (guard++ < 900) {
    const r = advanceOnce(g, {});
    if (r.type !== 'seriesPause') { if (r.type === 'seasonEnd') break; continue; }
    pauses += 1;
    const s = r.series;
    const plan = s.bestOf === 9 ? [4, 7, 8, 9] : [3, 6, 7];
    const early = s.a === s.targetWins || s.b === s.targetWins;
    if (!early && s.games.length !== plan[0]) {
      throw new Error(`上半场不是 ${plan[0]} 局，而是 ${s.games.length} 局`);
    }
    if (![7, 9].includes(s.bestOf)) throw new Error(`分段只应发生在 BO7/BO9，实际 BO${s.bestOf}`);
    // 每 3 次挂起换一次调整方式；优先用"换人"验证阵容真的变了
    const sq = g.squads[g.userTeamId];
    let swap = null;
    for (const role of ['top', 'jungle', 'mid', 'adc', 'support']) {
      const sid = (sq.starters || []).find((id) => g.players[id]?.role === role);
      const bp = (sq.bench || []).concat(sq.youth || []).map((id) => g.players[id])
        .filter((p) => p && p.role === role).sort((a, b) => b.overall - a.overall)[0];
      if (sid && bp) { swap = { inId: bp.id, outId: sid }; break; }
    }
    let action;
    if (pauses % 3 === 1 && swap) { action = { series: { type: 'swap', ...swap } }; }
    else if (pauses % 3 === 2) action = { series: { type: 'boost' } };
    else action = { series: { type: 'none' } };

    const cash0 = g.cash;
    const beforeStarters = g.squads[g.userTeamId].starters.join(',');
    const r2 = advanceOnce(g, action);
    let r3 = r2;
    // 打完下半场如果打成平局，会再停一次做「巅峰对决阵容博弈」
    if (r2.type === 'seriesPause' && r2.phase === 'lineup') {
      lineupPauses += 1;
      const s2 = r2.series;
      const tw = Math.ceil(s2.bestOf / 2);
      if (!(s2.a === tw - 1 && s2.b === tw - 1)) {
        throw new Error(`进入阵容博弈时不是平局：${s2.a}-${s2.b}`);
      }
      if (![3, 3].includes(s2.games.length) && s2.games.length !== s2.bestOf - 1) {
        throw new Error(`进入阵容博弈时局数异常：${s2.games.length}`);
      }
      r3 = advanceOnce(g, { lineup: 'teamfight' });
      if (!r3.lineup) throw new Error('阵容博弈结果没有写回');
      if (r3.lineup.mine !== 'teamfight') throw new Error('玩家的阵容选择没有被采用');
      if (typeof r3.lineup.bonus !== 'number') throw new Error('阵容博弈缺少加成数值');
    }
    const res = r3.playerMatch?.result;
    if (!res) throw new Error(`恢复后没有最终结果（返回类型 ${r3.type}）`);
    if (res.scoreA + res.scoreB !== res.games.length) throw new Error('比分与局数不一致');
    if (Math.max(res.scoreA, res.scoreB) !== Math.ceil(s.bestOf / 2)) throw new Error(`胜者局数异常 ${res.scoreA}-${res.scoreB}`);
    if (res.wentDecider) {
      sawDecider = true;
      if (s.bestOf === 7 && !(res.scoreA === 4 && res.scoreB === 3) && !(res.scoreA === 3 && res.scoreB === 4)) {
        throw new Error(`BO7 巅峰对决比分应为 4-3，实际 ${res.scoreA}-${res.scoreB}`);
      }
    }
    if (action.series.type === 'boost') {
      if (g.cash < cash0) boosted = true; else throw new Error('临场布置没有扣钱');
    }
    if (action.series.type === 'swap') {
      if (g.squads[g.userTeamId].starters.join(',') !== beforeStarters) swapped = true;
      else throw new Error('换人后首发没有变化');
    }
  }
  if (pauses === 0) throw new Error('整个生涯没有触发过任何一次分段挂起');
  if (!boosted) throw new Error('没有验证到临场布置扣钱');
  if (!swapped) throw new Error('没有验证到中场换人');
  return `挂起 ${pauses} 次，上半场局数/比分一致性/巅峰对决/换人/临场布置均正确${sawDecider ? '（含巅峰对决）' : ''}`;
});

check('④ 抽卡建队后的工资总额不超过工资帽（否则整季签不了人）', () => {
  const { wageCap, teamWageBill } = transferMod;
  const rows = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    for (const tid of ['wst', 'syg', 'estar']) {
      const d = draftMod.createDraft();
      const rng = createRng(seed * 977 + tid.length * 31);
      for (const r of ['top', 'jungle', 'mid', 'adc', 'support']) draftMod.drawRole(rng, d, r);
      const g = createGame({ userTeamId: tid, starterIds: draftMod.draftStarters(d), draftSpend: 0 });
      const bill = teamWageBill(g, tid);
      const cap = wageCap(g);
      rows.push({ tid, bill, cap });
      if (bill > cap) throw new Error(`${tid} 工资 ${bill} 超过工资帽 ${cap}`);
    }
  }
  const squeezed = rows.filter((r) => r.bill > 0).length;
  return `${rows.length} 次抽卡建队，工资均 ≤ 工资帽（例：${rows[0].tid} ${rows[0].bill}/${rows[0].cap}）`;
});

console.log('⑨ 常规赛 BO5 / 商务运营 …');
const businessMod = await import('../src/sim/business.js');
const { FATIGUE } = await import('../src/core/constants.js');

check('① 玩家自己的常规赛必须是 BO5（胜者 3 局，比分 3-0/3-1/3-2）', () => {
  const dist = {};
  let n = 0;
  for (const tid of ['syg', 'ag']) {
    const g = createGame({ userTeamId: tid });
    g.__rng = createRng(777);
    let guard = 0;
    while (guard++ < 400) {
      const r = advanceOnce(g, {});
      if (r.type === 'matchday' && r.playerResult) {
        const m = r.playerResult;
        const hi = Math.max(m.scoreA, m.scoreB);
        const lo = Math.min(m.scoreA, m.scoreB);
        dist[`${hi}-${lo}`] = (dist[`${hi}-${lo}`] || 0) + 1;
        n += 1;
        if (hi !== 3) throw new Error(`出现非 BO5 比分 ${hi}-${lo}（BO7 改成 BO3 的历史 bug）`);
        if (m.games && m.games.length !== m.scoreA + m.scoreB) throw new Error('比分与局数不一致');
      }
      if (r.type === 'seasonEnd') break;
    }
  }
  if (!dist['3-1'] && !dist['3-2']) throw new Error(`比分过于单一：${JSON.stringify(dist)}`);
  return `${n} 场全部为 BO5：${Object.entries(dist).sort().map(([k, v]) => `${k}×${v}`).join(' ')}`;
});

check('② 商务运营：进账、涨声望、累积疲劳并实打实降低战力', () => {
  const g = createGame({ userTeamId: 'ag' });
  const pid = g.userTeamId;
  const cash0 = g.cash;
  const fame0 = g.fame;
  const power0 = teamPower(g, pid);
  const r = businessMod.doBusiness(g, 'show');
  if (!r.ok) throw new Error('综艺录制失败: ' + r.reason);
  if (!(g.cash > cash0)) throw new Error('现金没有增加');
  if (!(g.fame > fame0)) throw new Error('声望没有增加');
  if (!(g.fatigue[pid] > 0)) throw new Error('疲劳没有增加');
  const power1 = teamPower(g, pid);
  if (!(power1 < power0)) throw new Error(`疲劳没有降低战力：${power0} → ${power1}`);
  // 战力下降 = 疲劳惩罚(0.2/点) + 士气下降(0.1/点)，这里校验疲劳那一份确实生效
  const perPower = (power0 - power1) / g.fatigue[pid];
  if (perPower < FATIGUE.perPower - 0.02 || perPower > 0.5) throw new Error(`疲劳系数异常：${perPower}`);
  if (businessMod.businessIncome(g) !== r.cash) throw new Error('商务收入没有累计');
  return `+${r.cash} 万 / 声望 +${r.fame} / 疲劳 ${r.fatigue}，战力 ${power0.toFixed(1)} → ${power1.toFixed(1)}`;
});

check('③ 商务：赛季次数上限、疲劳上限、体能恢复、跨赛季不清零', () => {
  const g = createGame({ userTeamId: 'ag' });
  const pid = g.userTeamId;
  // 赛季次数上限
  const cap = businessMod.ACTIVITY_BY_ID.show.cap;
  for (let i = 0; i < cap + 3; i += 1) businessMod.doBusiness(g, 'show');
  if (g.business.show !== cap) throw new Error(`超额执行：${g.business.show} > ${cap}`);
  if (businessMod.doBusiness(g, 'show').ok) throw new Error('超过赛季上限仍然成功');
  // 疲劳上限
  for (let i = 0; i < 20; i += 1) businessMod.doBusiness(g, 'stream');
  if (g.fatigue[pid] > FATIGUE.cap) throw new Error(`疲劳超过上限：${g.fatigue[pid]} > ${FATIGUE.cap}`);
  const blocked = businessMod.doBusiness(g, 'endorse');
  if (blocked.ok) throw new Error('疲劳到顶时仍允许继续接商务');
  // 体能恢复
  const before = g.fatigue[pid];
  const rec = trainMod.trainTeam(g, 'recover');
  if (!rec.ok) throw new Error('体能恢复失败: ' + rec.reason);
  if (!(g.fatigue[pid] < before)) throw new Error('体能恢复没有降低疲劳');
  // 每日自然恢复
  const f2 = g.fatigue[pid];
  businessMod.recoverFatigue(g);
  if (g.fatigue[pid] !== Math.max(0, f2 - FATIGUE.recoverPerDay)) throw new Error('每日恢复量不正确');
  // 跨赛季不清零
  const f3 = g.fatigue[pid];
  if (f3 <= 0) throw new Error('测试前提不成立：疲劳已为 0');
  seasonMod.beginNextSeason(g);
  if (g.fatigue[pid] <= 0) throw new Error('开季把疲劳清零了（休赛期狂接商务会变成白拿钱）');
  return `上限 ${cap} 次 / 疲劳封顶 ${FATIGUE.cap} / 恢复 ${rec.cost} 万降 ${before - rec.value} 点 / 开季保留 ${g.fatigue[pid]} 点`;
});

check('⑤ 常规营收：每打完一轮比赛就进账（与胜负无关，随声望浮动）', () => {
  const g = createGame({ userTeamId: 'syg' });
  g.__rng = createRng(777);
  const cash0 = g.cash;
  let days = 0;
  let guard = 0;
  while (guard++ < 300) {
    const r = advanceOnce(g, {});
    if (r.type === 'matchday') days += 1;
    if (r.type === 'seasonEnd') break;
  }
  const earned = g.cash - cash0;
  if (days <= 0) throw new Error('没有经过任何比赛日');
  if (!(earned > 0)) throw new Error('打完比赛后现金没有增加');
  if (!(g.flags.matchIncome > 0)) throw new Error('常规营收没有累计到 flags.matchIncome');
  // 营收随声望：把声望抬上去，单轮营收应更高
  const lo = matchdayIncome({ fame: 10 });
  const hi = matchdayIncome({ fame: 90 });
  if (!(hi > lo)) throw new Error('常规营收没有随声望增长');
  return `${days} 个比赛日累计常规营收 +${earned} 万（声望 10 → ${lo} 万/轮，声望 90 → ${hi} 万/轮）`;
});

check('⑥ 一键训练：花四项总价把球员全部属性各 +1', () => {
  const g = createGame({ userTeamId: 'ag' });
  const pid = g.userTeamId;
  const p = g.players[g.squads[pid].starters[0]];
  const before = { laning: p.laning, macro: p.macro, teamfight: p.teamfight, champPool: p.champPool };
  const cash0 = g.cash;
  const r = trainMod.trainAllAttrs(g, p.id);
  if (!r.ok) throw new Error('一键训练失败: ' + r.reason);
  if (!(r.gains.length >= 1)) throw new Error('没有任何属性被提升');
  for (const x of r.gains) {
    if (p[x.attr] !== before[x.attr] + 1) throw new Error(`属性 ${x.attr} 没有 +1`);
  }
  if (!(g.cash < cash0)) throw new Error('一键训练没有扣钱');
  if (!(g.flags.trainingSpend >= r.cost)) throw new Error('训练投入没有累计');
  // 单项 vs 一键等价：同一初始状态下，"逐个点击 +1"的累计 应等于"一键训练"的总价
  const gA = createGame({ userTeamId: 'ag' });
  const pA = gA.players[gA.squads[gA.userTeamId].starters[0]];
  let seqCost = 0;
  for (const a of ['laning', 'macro', 'teamfight', 'champPool']) {
    seqCost += trainMod.attrCost(gA, pA, a);   // 按当前状态报价
    trainMod.trainAttr(gA, pA.id, a);          // 实际 +1，抬高后续单价
  }
  const gB = createGame({ userTeamId: 'ag' });
  const pB = gB.players[gB.squads[gB.userTeamId].starters[0]];
  const all2 = trainMod.trainAllAttrs(gB, pB.id);
  if (all2.cost !== seqCost) throw new Error(`一键训练总价 ${all2.cost} 与逐项累加 ${seqCost} 不一致`);
  // 到上限后不能再练
  for (let i = 0; i < 30; i += 1) trainMod.trainAllAttrs(g, p.id);
  const fin = trainMod.trainAllAttrs(g, p.id);
  if (fin.ok) throw new Error('达到上限后一键训练仍成功');
  return `提升 ${r.gains.map((x) => x.name).join('/')} 各 +1，花费 ${r.cost} 万（= 逐项累加）`;
});

check('④ 财务页与训练页渲染商务运营 / 体能恢复，且真点击生效', () => {
  const g = createGame({ userTeamId: 'ag' });
  app.__test.setGame(g);
  // 财务页
  app.__test.setTab('finance');
  app.__test.state.cursor = 999;
  app.__test.renderShell();
  let txt = els.screen.textContent || '';
  if (!txt.includes('商务运营')) throw new Error('财务页缺少商务运营');
  const bizBtn = els.screen.findClickable(/^\+\d+ 万 · 疲劳\+\d+$/)[0];
  if (!bizBtn) throw new Error('找不到商务按钮');
  const cash0 = g.cash;
  bizBtn.click();
  const gain = g.cash - cash0;
  if (!(gain > 0)) throw new Error('点击商务没有进账');
  // 训练页的体能恢复
  app.__test.setTab('training');
  app.__test.renderShell();
  txt = els.screen.textContent || '';
  if (!txt.includes('体能恢复')) throw new Error('训练页缺少体能恢复');
  const recBtn = els.screen.findClickable(/-12 疲劳/)[0];
  if (!recBtn) throw new Error('找不到体能恢复按钮');
  const f0 = g.fatigue[g.userTeamId];
  recBtn.click();
  if (!(g.fatigue[g.userTeamId] < f0)) throw new Error('点击体能恢复没有降低疲劳');
  return `商务点击入账 ${gain} 万、体能恢复 ${f0} → ${g.fatigue[g.userTeamId]}`;
});

console.log('⑩ 官方双败赛制 / 二分布局 …');
const bracketMod = await import('../src/sim/bracket.js');

check('① 签表严格按 KPL 官方 M1~M10：胜者组 4 队、败者组 4 队、共 10 场', () => {
  const seeds = ['ag', 'wolves', 'ksg', 'wb', 'ttg', 'estar', 'drg', 'jdg'];
  const b = bracketMod.doubleElimTemplate8(seeds);
  if (b.length !== 10) throw new Error(`场次应为 10，实际 ${b.length}`);
  const get = (id) => b.find((m) => m.id === id);
  const expect = {
    M1: [seeds[4], seeds[7]], M2: [seeds[5], seeds[6]],
    M3: [seeds[0], seeds[3]], M4: [seeds[1], seeds[2]],
  };
  for (const [id, [a, c]] of Object.entries(expect)) {
    const m = get(id);
    if (!m) throw new Error(`缺少 ${id}`);
    if (m.a !== a || m.b !== c) throw new Error(`${id} 首轮对阵与官方不符`);
  }
  // 逐个填结果，校验后续槽位（M5 起全部来自 M1~M4 的胜/负者）
  const res = (m, w, l) => bracketMod.applyMatchResult(b, get(m), { winnerId: w, loserId: l });
  res('M1', seeds[4], seeds[7]);
  res('M2', seeds[6], seeds[5]);
  res('M3', seeds[0], seeds[3]);
  res('M4', seeds[1], seeds[2]);
  const chk = (id, a, c, label) => {
    const m = get(id);
    if (m.a !== a || m.b !== c) throw new Error(`${id} 槽位错误（应为 ${label}）`);
  };
  chk('M5', seeds[4], seeds[2], 'M1胜者 vs M4败者');
  chk('M6', seeds[6], seeds[3], 'M2胜者 vs M3败者');
  chk('M7', seeds[0], seeds[1], 'M3胜者 vs M4胜者（胜者组决赛）');
  res('M5', seeds[4], seeds[2]);
  res('M6', seeds[6], seeds[3]);
  chk('M8', seeds[4], seeds[6], 'M5胜者 vs M6胜者（败者组第三轮）');
  res('M7', seeds[1], seeds[0]);
  res('M8', seeds[4], seeds[6]);
  chk('M9', seeds[4], seeds[0], 'M8胜者 vs M7败者（败者组决赛）');
  const finA = get('F');
  if (finA.a !== seeds[1] || finA.b) throw new Error('总决赛槽位错误（应只填好 M7 胜者）');
  res('M9', seeds[4], seeds[0]);
  const fin = get('F');
  if (fin.b !== seeds[4]) throw new Error('总决赛槽位错误（应为 M9 胜者）');
  return '10 场，M1~M9 + 总决赛的配对与传播全部符合官方口径';
});

check('② 名次口径：总决赛/败者组决赛/第三轮/第二轮/首轮的败者分别 2/3/4/5/7', () => {
  const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const b = bracketMod.doubleElimTemplate8(seeds);
  const get = (id) => b.find((m) => m.id === id);
  const res = (m, w, l) => bracketMod.applyMatchResult(b, get(m), { winnerId: w, loserId: l });
  res('M1', 'e', 'h'); res('M2', 'f', 'g');
  res('M3', 'a', 'd'); res('M4', 'b', 'c');
  res('M5', 'e', 'b'); res('M6', 'f', 'a');
  res('M7', 'c', 'd');   // 胜者组决赛：c 胜、d 败（d 进败者组决赛）
  res('M8', 'e', 'f');
  res('M9', 'e', 'd');
  res('F', 'c', 'e');
  const pm = bracketMod.placementMap(b);
  const want = { c: 1, e: 2, d: 3, f: 4, b: 5, a: 5, h: 7, g: 7 };
  for (const [id, r] of Object.entries(want)) {
    if (pm[id] !== r) throw new Error(`${id} 名次应为 ${r}，实际 ${pm[id]}`);
  }
  return '冠军1 亚军2 第三3 第四4 并列第五5 并列第七7，与官方一致';
});

check('③ 双败语义：每队最多输 2 次，胜者组首轮败者仍有下一场', () => {
  const seeds = ['ag', 'wolves', 'ksg', 'wb', 'ttg', 'estar', 'drg', 'jdg'];
  const g = createGame({ userTeamId: 'syg' });
  const b = bracketMod.doubleElimTemplate8(seeds);
  bracketMod.autoResolveRemaining(g, createRng(4242), b, { bestOf: 7, finalBestOf: 7 });
  const losses = {};
  for (const m of b) if (m.winnerId) losses[m.loserId] = (losses[m.loserId] || 0) + 1;
  const over = Object.entries(losses).filter(([, n]) => n > 2);
  if (over.length) throw new Error(`${over.map(([id, n]) => `${g.teams[id].short}输${n}次`).join(',')} 违反双败`);
  // 胜者组首轮的败者必须出现在后续场次里（掉进败者组继续打）
  const wbLosers = ['M3', 'M4'].map((id) => b.find((m) => m.id === id).loserId);
  for (const id of wbLosers) {
    const again = b.some((m) => m.a === id || m.b === id);
    const inLB = b.filter((m) => m.bracket === 'LB').some((m) => m.a === id || m.b === id);
    if (!again || !inLB) throw new Error(`${g.teams[id].short} 输掉胜者组首轮后没有掉入败者组`);
  }
  return `全部 8 队最多输 2 次；胜者组首轮败者均掉入败者组继续征战`;
});

check('④ 界面布局：宽屏 2×2 工作台（三角落常驻）、窄屏由底部页签切换整页', () => {
  const g = createGame({ userTeamId: 'syg' });
  app.__test.setGame(g);
  app.__test.setTab('office');
  app.__test.state.cursor = 999;

  // ── 宽屏：2×2 工作台 ──
  app.__test.setViewportWidth(1440);
  app.__test.renderShell();
  const wb = els.screen.all().find((e) => e.classList.contains('workbench'));
  if (!wb) throw new Error('宽屏下缺少 .workbench 工作台容器');
  if (wb.children.length !== 4) throw new Error(`工作台应有 4 个面板，实际 ${wb.children.length}`);
  const has = (cls) => wb.children.some((e) => e.classList && e.classList.contains(cls));
  if (!has('panel-workspace')) throw new Error('缺少工作台（页签切换区）');
  if (!has('panel-match')) throw new Error('缺少右上角战斗情况');
  if (!has('panel-board')) throw new Error('缺少左下角积分榜/对阵图');
  if (!has('panel-next')) throw new Error('缺少右下角推进按钮面板');
  if (!els.screen.classList.contains('locked')) throw new Error('宽屏没有锁定整页滚动');

  const wt = wb.textContent || '';
  if (!wt.includes('战斗情况')) throw new Error('缺少战斗情况');
  if (!wt.includes('积分榜 · 近五场')) throw new Error('左下角没有积分榜·近五场');
  if (!wt.includes('推进')) throw new Error('缺少常驻推进按钮');
  // 战队状态速览应附在战斗情况里
  if (!wt.includes('疲劳') || !wt.includes('现金') || !wt.includes('声望')) throw new Error('战斗情况缺少战队状态速览');

  // 左下角：积分榜（S/A/B 三组并排）+ 近五场战绩
  const board = els.screen.all().find((e) => e.classList.contains('panel-board'));
  if (!board) throw new Error('缺少左下角面板');
  const bt = board.textContent || '';
  if (!bt.includes('S 组') || !bt.includes('A 组') || !bt.includes('B 组')) throw new Error('积分榜缺少三组');
  if (!bt.includes('近五场')) throw new Error('缺少近五场战绩');

  // 页签切换应换掉工作台内容（训练页含一键训练按钮）
  app.__test.setTab('training');
  app.__test.renderShell();
  const wb2 = els.screen.all().find((e) => e.classList.contains('workbench'));
  const ws2 = wb2.children.find((e) => e.classList && e.classList.contains('panel-workspace'));
  if (!(ws2.textContent || '').includes('训练中心')) throw new Error('切到训练页签后工作台没显示训练中心');
  if (!(ws2.textContent || '').includes('全部 +1')) throw new Error('训练页缺少一键训练按钮');

  // ── 淘汰赛事件：左下切换成对阵图 ──
  const seeds = ['ag', 'wolves', 'ksg', 'wb', 'ttg', 'estar', 'drg', 'jdg'];
  const brk = bracketMod.doubleElimTemplate8(seeds);
  app.__test.state.log = [{ kind: 'bracket', stageName: 'KPL 春季赛', label: '季后赛', bracket: brk, day: 1, matches: [], finished: false }];
  app.__test.state.cursor = 0;
  app.__test.renderShell();
  const lt2 = els.screen.all().find((e) => e.classList.contains('panel-board'))?.textContent || '';
  if (!lt2.includes('淘汰赛对阵图')) throw new Error('淘汰赛时左下角没有切换成对阵图');
  if (!lt2.includes('胜者组') || !lt2.includes('败者组')) throw new Error('对阵图缺少胜者组/败者组分区');

  // ── 窄屏：不分栏，底部页签切换整页 ──
  app.__test.setViewportWidth(420);
  app.__test.state.log = [];
  app.__test.state.cursor = 999;
  app.__test.setTab('finance');
  app.__test.renderShell();
  if (els.screen.all().some((e) => e.classList && e.classList.contains('workbench'))) {
    throw new Error('窄屏不应出现工作台容器（应整页切换）');
  }
  if (els.screen.classList.contains('locked')) throw new Error('窄屏不应锁定滚动');
  const fullTxt = els.screen.textContent || '';
  if (!fullTxt.includes('商务运营')) throw new Error('窄屏下页签内容没有铺满整页');

  // ── 建队页与休赛期始终可滚动 ──
  app.__test.renderStart();
  if (els.screen.classList.contains('locked')) throw new Error('建队页不应锁定滚动');
  app.__test.setViewportWidth(1440);
  app.__test.setGame(g);
  app.__test.state.tab = 'office';
  app.__test.state.cursor = 999;
  app.__test.state.offseason = { mine: [], risers: [], fallers: [], rookies: [] };
  app.__test.state.offseasonStage = 'develop';
  app.__test.renderOffseason();
  if (els.screen.classList.contains('locked')) throw new Error('休赛期不应锁定滚动');
  app.__test.state.offseason = null;
  return '宽屏 2×2 工作台（工作台/战斗/历史战绩/推进四角常驻），窄屏页签切整页';
});

check('⑤ 比赛后「继续」按钮可交互（右下角与事件流两处都能推进）', () => {
  const g = createGame({ userTeamId: 'syg' });
  g.__rng = createRng(777);
  app.__test.setGame(g);
  app.__test.setViewportWidth(1440);
  app.__test.setTab('office');
  app.__test.state.cursor = 999;
  app.__test.state.log = [];
  app.__test.renderShell();

  // 推进直到出现 matchday 事件（可能先经过 newSeason / 其他事件）
  let guard = 0;
  let event = null;
  while (guard++ < 80 && !event) {
    const st = app.__test.state;
    if (st.cursor < st.log.length) {
      // 当前有事件：点右下角「继续」往后走，直到遇到 matchday
      const ev = st.log[st.cursor];
      if (ev.kind === 'matchday') { event = ev; break; }
      const c = els.screen.all().find((e) => e.classList && e.classList.contains('panel-next'))?.findClickable(/^继续$/)[0];
      if (c) c.click(); else break;
    } else {
      // 无事件：点右下角「推进」
      const nextBtn = els.screen.all().find((e) => e.classList && e.classList.contains('panel-next'))?.findClickable(/推进|重组|卡位赛/)[0];
      if (!nextBtn) break;
      nextBtn.click();
    }
  }
  if (!event) throw new Error('未复现 matchday 事件');

  // 事件流期间：右下角的「继续」必须可点（不能是 disabled 占位符）
  const nextPanel = els.screen.all().find((e) => e.classList && e.classList.contains('panel-next'));
  if (!nextPanel) throw new Error('缺少右下角面板');
  const continueBtns = nextPanel.findClickable(/^继续$/);
  if (continueBtns.length !== 1) throw new Error(`右下角应有 1 个可点的「继续」，实际 ${continueBtns.length}`);
  const btn = continueBtns[0];
  if (btn.attrs.disabled) throw new Error('右下角的「继续」按钮是 disabled，无法交互');

  // 点击右下角「继续」应推进 cursor
  const cursor0 = app.__test.state.cursor;
  btn.click();
  const cursor1 = app.__test.state.cursor;
  if (cursor1 !== cursor0 + 1) throw new Error(`点击「继续」后 cursor 未推进（${cursor0} → ${cursor1}）`);

  // 一路点到事件流结束，右下角应恢复成「推进」按钮
  let steps = 0;
  while (steps++ < 10 && app.__test.state.cursor < app.__test.state.log.length) {
    const c = els.screen.all().find((e) => e.classList && e.classList.contains('panel-next'))?.findClickable(/^继续$/)[0];
    if (!c) break;
    c.click();
  }
  const finalNext = els.screen.all().find((e) => e.classList && e.classList.contains('panel-next'))?.findClickable(/推进|重组|卡位赛|进入休赛期|查看生涯/)[0];
  if (!finalNext) throw new Error('事件流结束后右下角没有恢复成推进/收尾按钮');
  return '比赛后右下角「继续」可点并推进，事件流结束后恢复推进按钮';
});

check('⑥ 交战记录与近五场累积，生涯页展示荣誉', () => {
  const g = createGame({ userTeamId: 'syg' });
  g.__rng = createRng(555);
  // 打一个完整赛季，累积 h2h
  let guard = 0;
  while (guard++ < 3000) {
    advanceOnce(g, {});
    if (g.history.length >= 1) break;
  }
  // 应有与若干对手的交战记录
  const h2h = g.h2h || {};
  const entries = Object.entries(h2h);
  if (entries.length === 0) throw new Error('打完一个赛季后没有任何交战记录');
  for (const [, rec] of entries) {
    if (typeof rec.wins !== 'number' || typeof rec.losses !== 'number') throw new Error('交战记录字段缺失');
    if (rec.wins + rec.losses < 1) throw new Error('交战记录次数异常');
  }
  // 近五场：最多 5 条，且字段完整
  if (!Array.isArray(g.recentResults) || g.recentResults.length === 0) throw new Error('近五场战绩为空');
  if (g.recentResults.length > 5) throw new Error(`近五场超过 5 条：${g.recentResults.length}`);
  for (const r of g.recentResults) {
    if (typeof r.win !== 'boolean' || !r.opp || typeof r.my !== 'number') throw new Error('近五场字段缺失');
  }
  // 左下角：积分榜 + 近五场
  app.__test.setGame(g);
  app.__test.setViewportWidth(1440);
  app.__test.setTab('office');
  app.__test.state.cursor = 999;
  app.__test.state.log = [];
  app.__test.renderShell();
  const board = els.screen.all().find((e) => e.classList && e.classList.contains('panel-board'));
  const bt = board?.textContent || '';
  if (!bt.includes('近五场')) throw new Error('左下角缺少近五场战绩');
  if (!bt.includes('S 组')) throw new Error('左下角缺少积分榜');
  // 生涯页展示荣誉
  app.__test.setTab('career');
  app.__test.renderShell();
  const ct = els.screen.textContent || '';
  if (!ct.includes('生涯数据')) throw new Error('生涯页没有渲染');
  return `${entries.length} 个对手的交战记录、近五场 ${g.recentResults.length} 条；积分榜+近五场与生涯荣誉齐备`;
});

check('⑦ 比分方向与官方树形对阵图', () => {
  // 构造一个"上队（teamA）输了"的淘汰赛结果：F 节点上队 3、下队 4
  const g = createGame({ userTeamId: 'syg' });
  app.__test.setGame(g);
  app.__test.setViewportWidth(1440);
  app.__test.setTab('office');
  const result = { scoreA: 3, scoreB: 4, finalScore: '4-3', winnerId: 'ag', loserId: 'wolves', games: [] };
  const bracket = bracketMod.doubleElimTemplate8(['ag', 'wolves', 'ksg', 'wb', 'ttg', 'estar', 'drg', 'jdg']);
  const F = bracket.find((m) => m.id === 'F');
  F.a = 'wolves'; F.b = 'ag';   // 正常流程由 SLOT_MAP 传播，这里手工填好
  bracketMod.applyMatchResult(bracket, F, result);
  app.__test.state.log = [{ kind: 'bracket', stageName: 'KPL 春季赛', label: '季后赛', bracket, day: 1, matches: [{ match: { a: 'wolves', b: 'ag', id: 'F', bracket: 'F' }, result }], finished: false }];
  app.__test.state.cursor = 0;
  app.__test.renderShell();

  // 树形结构：四列（首轮两组 / 决赛两档 / 败者组后两轮 / 总决赛）
  const grid = els.screen.all().find((e) => e.classList && e.classList.contains('bk2-grid'));
  if (!grid) throw new Error('缺少官方样式对阵图（bk2-grid）');
  const cols = grid.children.filter((e) => e.classList && (e.classList.contains('bk2-stack') || e.classList.contains('bk2-col')));
  if (cols.length !== 4) throw new Error(`对阵图应有 4 列，实际 ${cols.length}`);
  const titles = (grid.textContent || '');
  for (const t of ['胜者组首轮', '胜者组决赛', '败者组第一轮', '败者组第二轮', '败者组第三轮', '败者组决赛', '总决赛']) {
    if (!titles.includes(t)) throw new Error(`对阵图缺少「${t}」列标题`);
  }

  // F 节点：上队 3（输）、下队 4（赢）——分数必须按行对应，不能整体翻转
  const nodes = els.screen.all().filter((e) => e.classList && e.classList.contains('bk2-node'));
  const wShort = g.teams.wolves.short;
  const aShort = g.teams.ag.short;
  const target = nodes.filter((e) => {
    const t = e.textContent || '';
    return t.includes(wShort) && t.includes(aShort);
  });
  if (!target.length) throw new Error('找不到总决赛节点');
  const scores = target[target.length - 1].children
    .flatMap((r) => r.children.filter((c) => c.classList && c.classList.contains('bk2-score')).map((c) => c.textContent));
  if (scores[0] !== '3' || scores[1] !== '4') throw new Error(`总决赛比分方向反了：${scores.join('/')}`);
  return `官方树形对阵图（4 列 7 轮标题），总决赛按行显示 ${wShort} 3 / ${aShort} 4`;
});

console.log(errors === 0 ? '\n全部通过 ✓' : `\n有 ${errors} 项失败 ✗`);
process.exit(errors === 0 ? 0 : 1);
