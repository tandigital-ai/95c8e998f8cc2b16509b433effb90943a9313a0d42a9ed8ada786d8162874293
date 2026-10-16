/**
 * modal.js — Hộp thoại có bẫy focus, Esc để đóng, trả Promise.
 *   openModal({title, body, footer, size}) => {close, el}
 *   confirmDialog({title, message, okText, danger}) => Promise<boolean>
 *   promptDialog({title, label, type, value}) => Promise<string|null>
 */
import { h, append } from './dom.js';

const stack = [];

function focusables(el) {
  return [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
}

export function openModal({ title, body, footer = null, size = '', onClose = null, closable = true }) {
  const prevFocus = document.activeElement;
  const titleId = 'mdl-' + Math.random().toString(36).slice(2, 8);
  const closeBtn = closable ? h('button', { class: 'icon-btn', 'aria-label': 'Đóng', onclick: () => close() }, '✕') : null;
  const modal = h('div', { class: ['modal', size], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-hdr' }, h('h2', { class: 'modal-title', id: titleId }, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-ftr' }, footer) : null);
  const bg = h('div', { class: 'modal-bg' }, modal);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    bg.remove();
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    if (onClose) onClose(result);
  }
  function onKey(e) {
    if (stack[stack.length - 1] !== entry) return;
    if (e.key === 'Escape' && closable) { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const f = focusables(modal);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  bg.addEventListener('mousedown', (e) => { if (e.target === bg && closable) close(); });
  document.addEventListener('keydown', onKey, true);
  const entry = { close };
  stack.push(entry);
  document.body.appendChild(bg);
  requestAnimationFrame(() => {
    const f = focusables(modal);
    const target = f.find((x) => x.matches('input, textarea, select')) || f.find((x) => x !== closeBtn) || closeBtn;
    target?.focus();
  });
  return { close, el: modal, body: modal.querySelector('.modal-body') };
}

export function confirmDialog({ title = 'Xác nhận', message, okText = 'Đồng ý', cancelText = 'Hủy', danger = false, details = null }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: danger ? 'btn btn-danger' : 'btn btn-pri', onclick: () => { result = true; m.close(); } }, okText);
    const cancel = h('button', { class: 'btn btn-out', onclick: () => m.close() }, cancelText);
    const body = h('div', { class: 'col' }, typeof message === 'string' ? h('p', { class: 'break' }, message) : message, details);
    const m = openModal({ title, body, footer: [cancel, ok], size: 'narrow', onClose: () => resolve(result) });
  });
}

export function promptDialog({ title, label, type = 'text', value = '', okText = 'OK', hint = '', autocomplete = 'off' }) {
  return new Promise((resolve) => {
    let result = null;
    const inp = h('input', { class: 'inp', type, value, autocomplete, 'aria-label': label });
    const submit = () => { result = inp.value; m.close(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const body = h('div', { class: 'field' }, h('label', null, label), inp, hint ? h('div', { class: 'field-hint' }, hint) : null);
    const m = openModal({ title, body, footer: [h('button', { class: 'btn btn-out', onclick: () => m.close() }, 'Hủy'), h('button', { class: 'btn btn-pri', onclick: submit }, okText)], size: 'narrow', onClose: () => resolve(result) });
  });
}

export function closeAllModals() {
  while (stack.length) stack[stack.length - 1].close();
}

export { append };
