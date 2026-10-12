/**
 * 单文件打包器（零依赖）
 *
 * 背景：项目源码是 ES Module，浏览器在 file:// 下会因安全策略拒绝加载相对模块，
 *       必须跑本地服务器。为了让玩家能「双击直接玩」，这里把整个模块图打包成
 *       一个自包含的 HTML（CSS 与 JS 全部内联，无任何外部请求）。
 *
 * 做法：不引入任何打包工具，自己做一个极简模块加载器：
 *   - 每个模块被包进一个函数作用域，天然避免不同模块间的顶层变量重名
 *   - import  → const { ... } = __req('模块id')
 *   - export  → 在模块函数末尾挂到 __exp 上
 *
 * 用法：node tools/build-standalone.mjs
 * 产物：KPL战队经营模拟器.html（项目根目录）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = 'src/ui/app.js';
const OUT = 'KPL战队经营模拟器.html';

/* ───────────────────────── 模块解析与转译 ───────────────────────── */

const posix = path.posix;
const norm = (p) => p.split(path.sep).join('/');

/** 把 './x.js' 这类相对路径解析成以项目根为基准的 id */
function resolveId(fromId, spec) {
  const dir = posix.dirname(fromId);
  return norm(posix.normalize(posix.join(dir, spec)));
}

const NAMED_IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
const SIDE_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/gm;
const REEXPORT_RE = /^[ \t]*export\s*\{([^}]*)\}\s*;?/gm;
const EXPORT_DECL_RE = /^([ \t]*)export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm;

/** `{ A, B as C }` → `{ A, B: C }` */
function parseClause(clause) {
  const c = clause.trim();
  if (c.startsWith('{')) {
    const inner = c.replace(/^\{/, '').replace(/\}$/, '').trim();
    if (!inner) return '';
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = s.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      return m ? (m[2] ? `${m[1]}: ${m[2]}` : m[1]) : s;
    });
    return `{ ${parts.join(', ')} }`;
  }
  const ns = c.match(/^\*\s+as\s+([A-Za-z0-9_$]+)$/);
  if (ns) return `{ default: ${ns[1]} }`;
  return c;
}

/** 收集一个模块直接依赖的模块 id */
function collectDeps(fromId, raw) {
  const deps = new Set();
  let m;
  NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = NAMED_IMPORT_RE.exec(raw))) deps.add(resolveId(fromId, m[2]));
  SIDE_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_IMPORT_RE.exec(raw))) deps.add(resolveId(fromId, m[1]));
  return [...deps];
}

/** 把 ES Module 源码转成"模块函数"体，并返回导出名清单 */
function transform(fromId, raw) {
  // 代码里存在 `/** 注释 */export function ...` 这种同行写法，先补一个换行，
  // 让后面的行首正则能命中
  let code = raw.replace(/\*\/(?=(export|import)\s)/g, '*/\n');
  const exported = [];

  code = code.replace(SIDE_IMPORT_RE, (_m, spec) => `__req(${JSON.stringify(resolveId(fromId, spec))});`);
  code = code.replace(NAMED_IMPORT_RE, (_m, clause, spec) => {
    const id = resolveId(fromId, spec);
    const binding = parseClause(clause);
    return binding
      ? `const ${binding} = __req(${JSON.stringify(id)});`
      : `__req(${JSON.stringify(id)});`;
  });

  code = code.replace(REEXPORT_RE, (_m, list) => {
    for (const item of list.split(',')) {
      const t = item.trim();
      if (!t) continue;
      const mm = t.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
      if (mm) exported.push([mm[2] || mm[1], mm[1]]);
      else throw new Error(`${fromId}: 无法解析 re-export 项 "${t}"`);
    }
    return '';
  });

  code = code.replace(EXPORT_DECL_RE, (_m, ws, kind, name) => {
    exported.push([name, name]);
    return `${ws}${kind} ${name}`;
  });

  if (/^[ \t]*export[\s{]/.test(code)) {
    throw new Error(`${fromId}: 仍有未处理的 export 语句，需要扩展打包器`);
  }
  if (/^[ \t]*import[\s'"]/.test(code)) {
    throw new Error(`${fromId}: 仍有未处理的 import 语句，需要扩展打包器`);
  }
  return { code, exported };
}

/* ───────────────────────── 打包 ───────────────────────── */

const mods = new Map(); // id -> { code, exported }（插入顺序 = 依赖优先）

function load(id) {
  if (mods.has(id)) return;
  const abs = path.join(ROOT, id);
  if (!fs.existsSync(abs)) throw new Error(`找不到模块 ${id}`);
  const raw = fs.readFileSync(abs, 'utf8');
  for (const dep of collectDeps(id, raw)) load(dep);
  mods.set(id, transform(id, raw));
}

load(ENTRY);

const moduleDefs = [];
for (const [id, { code, exported }] of mods) {
  const tail = exported.map(([exp, local]) => `__exp[${JSON.stringify(exp)}] = ${local};`).join('\n');
  moduleDefs.push(`__mods[${JSON.stringify(id)}] = function (__exp, __req) {\n'use strict';\n${code}\n${tail}\n};`);
}

const bundle = `(function () {
'use strict';
var __mods = {};
var __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id].exports;
  var m = { id: id, exports: {} };
  __cache[id] = m;
  __mods[id](m.exports, __req);
  return m.exports;
}
${moduleDefs.join('\n')}
__req(${JSON.stringify(ENTRY)});
})();`;

if (bundle.includes('</script')) {
  console.warn('⚠ bundle 里出现 </script 序列，已转义');
}

const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<title>KPL 战队经营模拟器</title>
<!--
  单文件离线版 · 由 tools/build-standalone.mjs 自动生成，请勿手改。
  重新生成：node tools/build-standalone.mjs
  源码（ES Module）位于 src/ 目录，开发时用 node tools/serve.mjs 启动本地服务器。
-->
<style>
${css}
</style>
</head>
<body>
  <div id="app">
    <header id="topbar"></header>
    <main id="screen" aria-live="polite"></main>
    <nav id="tabbar"></nav>
  </div>
  <div id="modal-root"></div>
  <div id="toast-root"></div>
  <script>
${bundle.replace(/<\/script/g, '<\\/script')}
  </script>
</body>
</html>
`;

const outPath = path.join(ROOT, OUT);
fs.writeFileSync(outPath, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✓ 已生成 ${OUT}`);
console.log(`  打包模块 ${mods.size} 个，其中入口 ${ENTRY}`);
console.log(`  产物大小 ${kb} KB（CSS 与 JS 全部内联，无外部请求）`);
