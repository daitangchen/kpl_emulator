/**
 * 单文件离线版验收测试
 * 目标：不依赖浏览器，直接把 KPL战队经营模拟器.html 里内联的脚本抽出来，
 *       在最小 DOM 桩里真实执行一遍，验证"双击就能玩"这条路径是通的。
 *
 * 用法：node tools/build-standalone.mjs && node tools/test-standalone.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FILE = path.join(ROOT, 'KPL战队经营模拟器.html');

/* ── 最小 DOM 桩 ─────────────────────────────────────────── */
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
      const node = (n instanceof El || n instanceof Text) ? n : new Text(String(n));
      if (node instanceof El) node.__parent = this;
      this.children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
  remove() { if (this.__parent) this.__parent.children = this.__parent.children.filter((c) => c !== this); }
  addEventListener(type, fn) { (this._listeners = this._listeners || {}); (this._listeners[type] = this._listeners[type] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() {
    const fns = (this._listeners && this._listeners.click) || [];
    if (!fns.length) return false;
    for (const f of fns) f({ target: this, stopPropagation() {} });
    return true;
  }
  all(out = []) { out.push(this); for (const c of this.children) if (c instanceof El) c.all(out); return out; }
  findClickable(re) { return this.all().filter((e) => (e._listeners?.click || []).length && re.test(e.textContent || '')); }
}
class Text { constructor(t) { this._t = String(t); } get textContent() { return this._t; } }

const ids = ['app', 'topbar', 'screen', 'tabbar', 'modal-root', 'toast-root'];
const els = Object.fromEntries(ids.map((id) => [id, new El('div')]));
const store = new Map();
let runtimeErrors = [];

const sandbox = {
  document: {
    createElement: (t) => new El(t),
    createTextNode: (t) => new Text(t),
    createDocumentFragment: () => new El('fragment'),
    getElementById: (id) => els[id] || null,
    body: new El('body'),
    addEventListener() {},
  },
  window: { addEventListener() {}, location: { href: 'file:///KPL战队经营模拟器.html' } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  },
  setTimeout: (fn) => { try { fn(); } catch { /* 忽略延时回调异常 */ } return 0; },
  clearTimeout() {},
  console: {
    log() {}, warn() {}, error: (...a) => runtimeErrors.push(a.join(' ')),
  },
  Node: El,
};
sandbox.globalThis = sandbox;

let errors = 0;
const check = (label, fn) => {
  try {
    const r = fn();
    console_log(`  ✓ ${label}${r ? ' — ' + r : ''}`);
    return true;
  } catch (e) {
    errors += 1;
    console_log(`  ✗ ${label}: ${e.message}`);
    return false;
  }
};
const console_log = (s) => process.stdout.write(s + '\n');

/* ── 开始 ─────────────────────────────────────────────────── */
console_log('单文件离线版验收：KPL战队经营模拟器.html\n');

check('文件存在且为单文件（无任何外部请求）', () => {
  if (!fs.existsSync(FILE)) throw new Error('未找到产物，请先运行 node tools/build-standalone.mjs');
  const html = fs.readFileSync(FILE, 'utf8');
  if (/<script[^>]+\bsrc=/i.test(html)) throw new Error('存在外链 <script src>，file:// 下会失败');
  if (/<link[^>]+\bhref=/i.test(html)) throw new Error('存在外链 <link href>，file:// 下会失败');
  if (!/<style>/.test(html)) throw new Error('CSS 未内联');
  if (!/<script>/.test(html)) throw new Error('JS 未内联');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  return `${kb} KB，CSS/JS 全内联`;
});

let scriptCode = '';
check('抽取内联脚本', () => {
  const html = fs.readFileSync(FILE, 'utf8');
  const s = html.lastIndexOf('<script>');
  const e = html.lastIndexOf('</script>');
  if (s < 0 || e < 0) throw new Error('找不到内联 <script>');
  scriptCode = html.slice(s + '<script>'.length, e);
  if (scriptCode.length < 10000) throw new Error('内联脚本过短，疑似打包失败');
  return `${(scriptCode.length / 1024).toFixed(1)} KB`;
});

check('真实执行内联脚本（等价于浏览器双击打开）', () => {
  runtimeErrors = [];
  const ctx = vm.createContext(sandbox);
  vm.runInContext(scriptCode, ctx, { filename: 'KPL战队经营模拟器.html' });
  if (runtimeErrors.length) throw new Error('运行期报错: ' + runtimeErrors.join(' | '));
  return '无异常';
});

check('启动后渲染出选队页（18 支战队）', () => {
  const teams = els.screen.all().filter((e) => e.classList.contains('team-opt'));
  if (teams.length !== 18) throw new Error(`可选战队数量为 ${teams.length}，应为 18`);
  if (els.screen.textContent.length < 100) throw new Error('选队页内容过少');
  return `18 支战队可选`;
});

check('真点击：选队 → 抽卡建队 → 开始第 1 赛季 → 进入办公室', () => {
  const teams = els.screen.all().filter((e) => e.classList.contains('team-opt'));
  if (!teams[0].click()) throw new Error('战队按钮没有绑定点击事件');
  // 抽卡建队：先一键抽满
  const fill = els.screen.all().find((e) => (e._listeners?.click || []).length && /一键抽满/.test(e.textContent || ''));
  if (!fill) throw new Error('找不到「一键抽满」按钮（抽卡建队未打包进去）');
  fill.click();
  const start = els.screen.findClickable(/赛季/)[0];
  if (!start) throw new Error('找不到开始按钮');
  if (start.attrs.disabled) throw new Error('抽满 5 人后开始按钮仍禁用');
  if (!start.click()) throw new Error('开始按钮没有绑定点击事件');
  if (els.topbar.children.length === 0) throw new Error('顶栏未渲染（建队失败）');
  if (els.tabbar.children.length === 0) throw new Error('底部导航未渲染');
  const txt = els.screen.textContent || '';
  if (!txt.includes('现金')) throw new Error('办公室未渲染');
  if (!txt.includes('更衣室动态')) throw new Error('办公室缺少更衣室动态（剧情线未打包进去）');
  if (runtimeErrors.length) throw new Error('交互过程报错: ' + runtimeErrors.join(' | '));
  return '顶栏 / 导航 / 办公室（含更衣室动态）均已渲染';
});

check('推进 20 步不报错（引擎可正常跑）', () => {
  const btnRe = /推进|模拟|查看|继续|开始|下半场|重组|卡位赛/;
  let steps = 0;
  for (let i = 0; i < 20; i += 1) {
    const btn = els.screen.findClickable(btnRe).find((b) => !b.attrs.disabled);
    if (!btn) break;
    btn.click();
    steps += 1;
  }
  if (steps === 0) throw new Error('一步都推不动');
  if (runtimeErrors.length) throw new Error('推进过程报错: ' + runtimeErrors.join(' | '));
  return `推进 ${steps} 步无异常`;
});

console_log(errors === 0 ? '\n单文件版验收通过 ✓' : `\n有 ${errors} 项失败 ✗`);
process.exit(errors === 0 ? 0 : 1);
