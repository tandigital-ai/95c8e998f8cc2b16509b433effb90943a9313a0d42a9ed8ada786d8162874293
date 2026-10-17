/**
 * tabs.js — Thanh tab theo chuẩn ARIA (role=tablist, phím ←/→/Home/End).
 *   const t = createTabs(container); t.set([{id,label,render:()=>Node}], activeId)
 */
import { h, mount, clear } from './dom.js';

export function createTabs(container, { onChange = null } = {}) {
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Kết quả' });
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel', tabindex: '0' });
  mount(container, list, panel);
  let items = [];
  let active = null;

  function select(id, focus = false) {
    const it = items.find((x) => x.id === id) || items[0];
    if (!it) { clear(panel); return; }
    active = it.id;
    for (const b of list.children) {
      const on = b.dataset.id === active;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    panel.setAttribute('aria-labelledby', 'tab-' + cssId(active));
    try {
      const node = it.render();
      mount(panel, node);
    } catch (e) {
      mount(panel, h('div', { class: 'error-box', role: 'alert' }, 'Lỗi hiển thị tab: ' + e.message));
      console.error(e);
    }
    if (onChange) onChange(active);
  }

  function cssId(s) { return String(s).replace(/[^\w-]/g, '_'); }

  list.addEventListener('keydown', (e) => {
    const idx = items.findIndex((x) => x.id === active);
    let next = null;
    if (e.key === 'ArrowRight') next = items[(idx + 1) % items.length];
    else if (e.key === 'ArrowLeft') next = items[(idx - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (next) { e.preventDefault(); select(next.id, true); }
  });

  return {
    set(newItems, activeId = active) {
      items = newItems;
      clear(list);
      for (const it of items) {
        list.appendChild(h('button', {
          class: 'tab', role: 'tab', id: 'tab-' + cssId(it.id), dataset: { id: it.id }, 'aria-selected': 'false', tabindex: '-1',
          title: it.title || null, onclick: () => select(it.id)
        }, it.label));
      }
      select(items.some((x) => x.id === activeId) ? activeId : items[0]?.id);
    },
    select,
    refresh() { if (active) select(active); },
    get active() { return active; },
    panel
  };
}
