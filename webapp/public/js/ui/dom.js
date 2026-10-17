/**
 * dom.js — Dựng DOM an toàn. KHÔNG dùng innerHTML cho dữ liệu: mọi chuỗi đi qua textContent.
 * (Riêng markdown đã làm sạch bằng DOMPurify đi qua markdownView.js.)
 *
 *   h('button', {class:'btn', onclick: fn, 'aria-label': 'Lưu'}, 'Lưu')
 */

export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') throw new Error('Không dùng style inline (CSP). Dùng class.');
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  return append(el, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Định dạng số */
export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('vi-VN') : '—');
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('vi-VN') : '—');
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

/** Khối trạng thái chuẩn: loading / empty / error */
export function loadingView(text = 'Đang tải...') {
  return h('div', { class: 'loading-line', role: 'status' }, h('span', { class: 'spinner' }), text);
}
export function emptyView(icon, title, desc = '') {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon), h('h3', null, title), desc ? h('p', { class: 'small' }, desc) : null);
}
export function errorView(message, retry = null) {
  return h('div', { class: 'error-box', role: 'alert' }, h('b', null, '❌ Lỗi: '), message, retry ? h('div', { class: 'mt-8' }, h('button', { class: 'btn btn-sm btn-out', onclick: retry }, '🔁 Thử lại')) : null);
}

/** Nút sao chép */
export function copyButton(getText, toast, label = '📋 Copy') {
  return h('button', {
    class: 'btn btn-xs btn-out',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
        toast?.('Đã sao chép', 'ok');
      } catch (e) {
        toast?.('Không sao chép được: ' + e.message, 'err');
      }
    }
  }, label);
}

/** Gom cập nhật DOM theo khung hình (dùng khi stream) */
export function rafThrottle(fn) {
  let pending = null;
  let scheduled = false;
  return (...args) => {
    pending = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const a = pending;
      pending = null;
      fn(...a);
    });
  };
}

/** select options từ mảng {value,label,group?} */
export function selectOptions(sel, items, current) {
  clear(sel);
  const groups = new Map();
  for (const it of items) {
    const o = h('option', { value: it.value }, it.label);
    if (it.value === current) o.selected = true;
    if (it.disabled) o.disabled = true;
    if (it.group) {
      if (!groups.has(it.group)) { const g = h('optgroup', { label: it.group }); groups.set(it.group, g); sel.appendChild(g); }
      groups.get(it.group).appendChild(o);
    } else sel.appendChild(o);
  }
}
