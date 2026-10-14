/**
 * costView.js — Chi phí theo ngày / dự án / provider / model / bước (từ Logs), nhãn rõ
 * "thực tế (từ usage)" và "ước lượng", biểu đồ cột đơn giản (CSS), xuất CSV. Trang Logs có lọc.
 */
import { h, mount, fmtInt, fmtTime, loadingView, emptyView, errorView } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { formatUsd } from '../core/budget.js';
import { toCsv, downloadText } from '../core/exporter.js';

/** Gom log LLM thành các bảng tổng hợp. Hàm thuần (có test). */
export function aggregateLlmLogs(rows) {
  const by = { provider: {}, model: {}, step: {}, project: {}, day: {} };
  for (const r of rows) {
    const c = r.context || {};
    if (r.kind !== 'llm') continue;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const step = String(c.step || 'chat').split(':')[0];
    const keys = { provider: c.provider || '?', model: `${c.provider}:${c.model}`, step, project: c.projectId || '(không dự án)', day };
    for (const [dim, key] of Object.entries(keys)) {
      const t = by[dim][key] || (by[dim][key] = { key, calls: 0, errors: 0, cached: 0, inTokens: 0, outTokens: 0, providerTokenCalls: 0, estimatedTokenCalls: 0, knownCost: 0, unknownPriceCalls: 0, latencyMs: 0 });
      t.calls++;
      if (c.status === 'error') { t.errors++; continue; }
      if (c.cached) { t.cached++; continue; }
      t.inTokens += c.inTokens || 0;
      t.outTokens += c.outTokens || 0;
      if (c.tokenSource === 'provider') t.providerTokenCalls++; else t.estimatedTokenCalls++;
      if (c.cost === null || c.cost === undefined) t.unknownPriceCalls++; else t.knownCost += c.cost;
      t.latencyMs += c.latencyMs || 0;
    }
  }
  const out = {};
  for (const [dim, map] of Object.entries(by)) out[dim] = Object.values(map).sort((a, b) => b.knownCost - a.knownCost || b.calls - a.calls);
  return out;
}

function tokenLabel(t) {
  const n = t.providerTokenCalls + t.estimatedTokenCalls;
  if (!n) return '—';
  if (!t.estimatedTokenCalls) return 'thực tế (từ usage)';
  if (!t.providerTokenCalls) return 'ước lượng';
  return `hỗn hợp: ${t.estimatedTokenCalls}/${n} ước lượng`;
}

function table(rows, dimLabel) {
  if (!rows.length) return emptyView('📊', 'Chưa có dữ liệu');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ...[dimLabel, 'Lượt', 'Lỗi', 'Cache', 'Token vào', 'Token ra', 'Nguồn token', 'Chi phí đã biết', 'Không rõ giá'].map((x, i) => h('th', { class: i && i !== 6 ? 'num' : '' }, x)))),
    h('tbody', null, ...rows.map((t) => h('tr', null,
      h('td', { class: 'mono break' }, t.key), h('td', { class: 'num' }, fmtInt(t.calls)), h('td', { class: 'num' }, fmtInt(t.errors)), h('td', { class: 'num' }, fmtInt(t.cached)),
      h('td', { class: 'num' }, fmtInt(t.inTokens)), h('td', { class: 'num' }, fmtInt(t.outTokens)), h('td', null, tokenLabel(t)),
      h('td', { class: 'num' }, formatUsd(t.knownCost, { unknownLabel: '—' })), h('td', { class: 'num' }, t.unknownPriceCalls ? `${t.unknownPriceCalls} lượt` : '0'))))));
}

function barChart(days) {
  const data = [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-31);
  if (!data.length) return emptyView('📈', 'Chưa có dữ liệu chi phí');
  const max = Math.max(...data.map((d) => d.knownCostUsd), 0.000001);
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Biểu đồ chi phí đã biết theo ngày' });
  const labels = h('div', { class: 'bar-labels', 'aria-hidden': 'true' });
  for (const d of data) {
    // Chiều cao bằng thuộc tính height của SVG (không dùng style inline để giữ CSP chặt)
    const pct = Math.max(2, Math.round((d.knownCostUsd / max) * 100));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'bar-svg');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0'); rect.setAttribute('width', '10'); rect.setAttribute('y', String(100 - pct)); rect.setAttribute('height', String(pct));
    rect.setAttribute('class', d.unknownPriceCalls && !d.knownCostUsd ? 'bar-rect unknown' : 'bar-rect');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${d.date}: ${formatUsd(d.knownCostUsd)}${d.unknownPriceCalls ? ` + ${d.unknownPriceCalls} lượt không rõ giá` : ''}`;
    svg.append(title, rect);
    bars.appendChild(svg);
    labels.appendChild(h('span', null, d.date.slice(8)));
  }
  return h('div', null, bars, labels, h('div', { class: 'small muted' }, `Cao nhất: ${formatUsd(max)}/ngày. Cột gạch = chỉ có lượt không rõ giá.`));
}

export function openCost(app) {
  const body = h('div', { class: 'col' }, loadingView());
  openModal({ title: '💰 Chi phí & token', body, size: 'wide' });
  (async () => {
    try {
      const days = await app.budget.listDays(31);
      const logs = await app.logger.list({ kind: 'llm', limit: 5000 });
      const agg = aggregateLlmLogs(logs);
      const today = await app.budget.getDay();
      const dimSel = h('select', { class: 'sel inp-sm', 'aria-label': 'Nhóm theo' },
        ...[['provider', 'Provider'], ['model', 'Model'], ['step', 'Bước'], ['project', 'Dự án'], ['day', 'Ngày']].map(([v, l]) => h('option', { value: v }, l)));
      const tblBox = h('div');
      const draw = () => mount(tblBox, table(agg[dimSel.value], dimSel.selectedOptions[0].textContent));
      dimSel.addEventListener('change', draw);
      draw();
      const s = app.settings.get();
      mount(body,
        h('div', { class: 'info-box small' }, 'Chi phí chỉ tính cho model ĐÃ BIẾT GIÁ (bạn nhập trong Cài đặt hoặc provider công bố). Lượt "không rõ giá" được đếm riêng và KHÔNG cộng vào ngân sách. Token "ước lượng" = số ký tự/4.'),
        h('div', { class: 'stats' },
          stat('Hôm nay', formatUsd(today.knownCostUsd), `ngân sách ${formatUsd(s.dailyBudgetUsd)}`),
          stat('Lượt gọi hôm nay', fmtInt(today.calls), `${today.cachedCalls} từ cache`),
          stat('Không rõ giá', fmtInt(today.unknownPriceCalls), 'lượt hôm nay'),
          stat('Token ước lượng', fmtInt(today.estimatedTokenCalls), 'lượt hôm nay')),
        h('h3', { class: 'section-title' }, 'Chi phí đã biết theo ngày (31 ngày)'), barChart(days),
        h('div', { class: 'row-between' }, h('h3', { class: 'section-title' }, 'Tổng hợp từ Logs'),
          h('div', { class: 'row' }, h('label', { class: 'small' }, 'Nhóm theo: '), dimSel,
            h('button', {
              class: 'btn btn-xs btn-out',
              onclick: () => {
                const rows = logs.map((r) => ({ ts: new Date(r.ts).toISOString(), ...r.context }));
                downloadText(`ai-architect-cost_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, ['ts', 'step', 'projectId', 'provider', 'model', 'status', 'cached', 'stream', 'round', 'latencyMs', 'inTokens', 'outTokens', 'tokenSource', 'cost', 'priceSource', 'finishReason', 'keySource', 'errorCode', 'error'].map((k) => ({ key: k }))), 'text/csv;charset=utf-8');
              }
            }, '⬇ CSV chi tiết'))),
        tblBox);
    } catch (e) {
      await app.logger.error('cost', e.message);
      mount(body, errorView(e.message));
    }
  })();
}

function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, value), h('div', { class: 'stat-l' }, label), sub ? h('div', { class: 'stat-sub' }, sub) : null);
}

export function openLogs(app) {
  const body = h('div', { class: 'col' });
  const levelSel = h('select', { class: 'sel inp-sm', 'aria-label': 'Mức' }, h('option', { value: '' }, 'Mọi mức'), h('option', { value: 'error' }, 'Chỉ lỗi'), h('option', { value: 'warn' }, 'Cảnh báo'), h('option', { value: 'info' }, 'Thông tin'));
  const kindInp = h('input', { class: 'inp inp-sm', placeholder: 'loại (llm, pipeline, vault…)', 'aria-label': 'Loại log' });
  const list = h('div', { class: 'col' });
  let rows = [];
  async function load() {
    mount(list, loadingView());
    try {
      rows = await app.logger.list({ limit: 500, level: levelSel.value || undefined, kind: kindInp.value.trim() || undefined });
      if (!rows.length) { mount(list, emptyView('🧾', 'Không có log phù hợp')); return; }
      mount(list, h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Thời gian'), h('th', null, 'Mức'), h('th', null, 'Loại'), h('th', null, 'Nội dung'))),
        h('tbody', null, ...rows.map((r) => h('tr', null,
          h('td', { class: 'nowrap small' }, fmtTime(r.ts)),
          h('td', null, h('span', { class: ['badge', r.level === 'error' ? 'badge-err' : r.level === 'warn' ? 'badge-warn' : 'badge-info'] }, r.level)),
          h('td', { class: 'mono small' }, r.kind),
          h('td', { class: 'break small' }, r.message, h('details', null, h('summary', { class: 'muted' }, 'ngữ cảnh'), h('pre', { class: 'code-block' }, JSON.stringify(r.context, null, 2))))))))));
    } catch (e) {
      mount(list, errorView(e.message, load));
    }
  }
  levelSel.addEventListener('change', load);
  kindInp.addEventListener('change', load);
  mount(body,
    h('div', { class: 'row' }, levelSel, kindInp,
      h('button', { class: 'btn btn-xs btn-out', onclick: load }, '🔄'),
      h('button', { class: 'btn btn-xs btn-out', onclick: () => downloadText('ai-architect-logs.json', JSON.stringify(rows, null, 2), 'application/json') }, '⬇ JSON'),
      h('button', { class: 'btn btn-xs btn-danger', onclick: async () => { if (await confirmDialog({ title: 'Xóa log', message: 'Xóa toàn bộ log? (Thống kê chi phí theo ngày vẫn giữ.)', danger: true, okText: 'Xóa' })) { await app.logger.clear(); load(); } } }, '🗑️ Xóa log')),
    h('div', { class: 'small muted' }, 'Log không bao giờ chứa API key (các trường key/token/password bị che).'),
    list);
  openModal({ title: '🧾 Logs', body, size: 'wide' });
  load();
}
