class El {
  constructor(tag) { this.tagName=String(tag).toUpperCase(); this.children=[]; this.attrs={}; this.style={}; this.dataset={}; this._text=""; this._html=""; this._l={};
    this.classList={_s:new Set(),add:(...c)=>c.forEach(x=>this.classList._s.add(x)),remove:(...c)=>c.forEach(x=>this.classList._s.delete(x)),toggle:(c,on)=>on?this.classList._s.add(c):this.classList._s.delete(c),contains:c=>this.classList._s.has(c)}; }
  get className(){return [...this.classList._s].join(" ");} set className(v){this.classList._s=new Set(String(v).split(/\s+/).filter(Boolean));}
  get firstChild(){return this.children[0]||null;}
  get textContent(){return this._text||this.children.map(c=>c.textContent).join("");} set textContent(v){this._text=String(v);this.children=[];}
  get innerHTML(){return this._html;} set innerHTML(v){this._html=String(v);this.children=[];}
  append(...ns){for(const n of ns){if(n===null||n===undefined||n===false)continue;const x=(n instanceof El)?n:new Text(String(n));if(x instanceof El)x.__parent=this;this.children.push(x);}}
  appendChild(n){this.append(n);return n;}
  removeChild(n){this.children=this.children.filter(c=>c!==n);return n;}
  remove(){if(this.__parent)this.__parent.children=this.__parent.children.filter(c=>c!==this);}
  addEventListener(t,f,o){ (this._l[t]=this._l[t]||[]).push(f); }
  setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k];}
  querySelector(){return null;} querySelectorAll(){return [];}
  click(){ const fs=this._l.click||[]; fs.forEach(f=>f({target:this,stopPropagation(){}})); }
  /** 递归找所有可点元素 */
  all(out=[]){ out.push(this); this.children.forEach(c=>{ if(c instanceof El) c.all(out); }); return out; }
}
class Text{constructor(t){this._t=String(t);} get textContent(){return this._t;}}
const ids=["app","topbar","screen","tabbar","modal-root","toast-root"];
const els=Object.fromEntries(ids.map(i=>[i,new El("div")]));
const store=new Map();
globalThis.document={createElement:t=>new El(t),createTextNode:t=>new Text(t),createDocumentFragment:()=>new El("fragment"),getElementById:i=>els[i]||null,body:new El("body"),addEventListener(){}};
globalThis.window={addEventListener(){},location:{href:"http://127.0.0.1:8123/"}};
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear()};
globalThis.Node=El;
globalThis.setTimeout=fn=>{try{fn();}catch(e){console.log("  [setTimeout 异常]",e.message);}return 0;};

const app = await import("../src/ui/app.js");
app.__test.renderStart();

const all = els.screen.all();
const teamBtns = all.filter(e => e.classList.contains("team-opt"));
console.log("可选战队按钮:", teamBtns.length);
const startBtns = () => els.screen.all().filter(e => (e._l.click||[]).length && /赛季|位置|请选择战队/.test(e.textContent||""));
console.log("起始按钮:", startBtns().map(b=>`"${b.textContent}" disabled=${!!b.attrs.disabled}`).join(" | ") || "（无）");

let failed = 0;
console.log("\n-- 点选不同战队，检查按钮文案与禁用状态 --");
for (const i of [0, 4, 12, 17]) {
  try {
    teamBtns[i].click();
    const b = startBtns()[0];
    console.log(`  战队#${i}: "${b.textContent}" disabled=${!!b.attrs.disabled}`);
  } catch (e) { failed++; console.log(`  战队#${i}: ✗ ${e.message}`); }
}

console.log("\n-- 逐一点击全部 18 支战队的选择按钮 --");
for (let i = 0; i < teamBtns.length; i++) {
  try { teamBtns[i].click(); } catch (e) { failed++; console.log(`  team#${i} 选择失败: ${e.message}`); }
}
console.log("  完成，失败数:", failed);

console.log("\n-- 点击开始按钮（先一键抽满 5 个位置）--");
try {
  const fill = els.screen.all().find(e => (e._l.click||[]).length && /一键抽满/.test(e.textContent||""));
  if (fill) { fill.click(); console.log("  已点击「" + fill.textContent + "」"); }
  const btn = startBtns()[0];
  if (!btn) throw new Error("找不到开始按钮");
  if (btn.attrs.disabled) throw new Error("抽满 5 个位置后开始按钮仍处于禁用状态");
  btn.click();
  const g = app.__test.state.game;
  console.log("  state.game =", g ? g.userTeamId : "null");
  console.log("  顶栏子节点:", els.topbar.children.length, "| 屏幕子节点:", els.screen.children.length);
  console.log("  首发:", g.squads[g.userTeamId].starters.map(id => g.players[id].name).join(" "));
} catch (e) {
  failed++;
  console.log("  ✗ 抛出异常:", e.message);
  console.log(e.stack.split("\n").slice(0,6).join("\n"));
}

console.log("\n-- 建队后连续推进 40 步（检查主按钮链路）--");
try {
  for (let k = 0; k < 40; k++) {
    const btns = els.screen.all().filter(e => (e._l.click||[]).length);
    const next = btns.find(b => /推进|继续|开始新赛季|进入第|查看生涯|结束休赛期|下半场|重组|卡位赛/.test(b.textContent||""));
    if (!next) { console.log(`  第 ${k} 步找不到推进按钮，样本:`, btns.slice(0,8).map(b=>b.textContent).join(" | ")); break; }
    next.click();
  }
  console.log("  推进 40 步无异常，stageIndex =", app.__test.state.game.stageIndex, "| 现金", Math.round(app.__test.state.game.cash));
} catch (e) {
  failed++;
  console.log("  ✗ 推进异常:", e.message);
  console.log(e.stack.split("\n").slice(0,6).join("\n"));
}

console.log(failed === 0 ? "\n✓ 点击链路全部正常" : `\n✗ 共 ${failed} 处失败`);
process.exit(failed === 0 ? 0 : 1);
