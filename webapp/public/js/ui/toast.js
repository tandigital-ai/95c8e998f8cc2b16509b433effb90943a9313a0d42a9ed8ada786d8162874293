/** toast.js — Thông báo ngắn. Lỗi ở lâu hơn và có nút đóng. */
import { h } from './dom.js';

let wrap = null;

export function toast(message, type = 'info', { timeout } = {}) {
  if (!wrap) wrap = document.getElementById('toasts');
  if (!wrap) { console.warn('[toast]', type, message); return; }
  const ms = timeout ?? (type === 'err' ? 9000 : type === 'warn' ? 6000 : 3500);
  const icon = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
  const el = h('div', { class: `toast ${type}`, role: type === 'err' ? 'alert' : 'status' },
    h('span', { 'aria-hidden': 'true' }, icon),
    h('span', { class: 'grow' }, String(message)),
    h('button', { class: 'icon-btn', 'aria-label': 'Đóng thông báo', onclick: () => el.remove() }, '✕'));
  wrap.appendChild(el);
  while (wrap.children.length > 6) wrap.firstChild.remove();
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 300); }, ms);
}
