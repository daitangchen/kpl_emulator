/** 界面通用组件：DOM 构造、弹窗、提示条 */
import { TEAMS } from '../data/teams.js';
import { ROLE_ORDER } from '../data/players.js';

/** 极简 h()：h('div', {class:'x'}, [children]) */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) if (c) f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return f;
};

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function toast(msg) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast', text: msg });
  root.append(t);
  setTimeout(() => t.remove(), 2200);
}

/** 弹窗：opts = { title, body(Node|string), actions:[{label, cls, onClick}], dismissible } */
export function modal(opts) {
  const root = document.getElementById('modal-root');
  clear(root);
  const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
  const actions = (opts.actions || []).map((a) => h('button', {
    class: a.cls || '',
    text: a.label,
    onClick: () => { if (a.onClick) a.onClick(); if (a.keepOpen !== true) closeModal(); },
  }));
  const box = h('div', { class: 'modal' }, [
    opts.title ? h('h2', { text: opts.title }) : null,
    body,
    actions.length ? h('div', { class: 'btn-row mt' }, actions) : null,
  ]);
  const bg = h('div', {
    class: 'modal-bg',
    onClick: (e) => { if (e.target === bg && opts.dismissible !== false) closeModal(); },
  }, [box]);
  root.append(bg);
  return bg;
}

export function closeModal() { clear(document.getElementById('modal-root')); }

export const teamName = (id) => TEAMS.find((t) => t.id === id)?.name || id;
export const teamShort = (id) => TEAMS.find((t) => t.id === id)?.short || id;

export const ROLE_LABEL = Object.fromEntries(ROLE_ORDER.map((r) => [r, { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' }[r]]));

/** 组别徽章 */
export const divBadge = (d) => h('span', { class: `badge ${d}`, text: d });

/** 队名（带短名） */
export const teamCell = (id, game) => {
  const t = TEAMS.find((x) => x.id === id);
  return h('span', {}, [t ? t.name : id]);
};
