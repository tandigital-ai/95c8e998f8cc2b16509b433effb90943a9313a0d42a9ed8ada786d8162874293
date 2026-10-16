/**
 * components.js — Thành phần dùng chung: chip meta của 1 lần gọi AI, thanh thống kê.
 */
import { h, mount, fmtInt } from './dom.js';
import { formatUsd } from '../core/budget.js';

/** Chip trung thực cho kết quả 1 lần gọi AI. */
export function callMeta(r) {
  if (!r) return null;
  const chips = [];
  const chip = (cls, text, title = '') => chips.push(h('span', { class: ['badge', cls], title }, text));
  if (r.cached) chip('badge-info', '⚡ Cached', 'Kết quả lấy từ cache (không gọi AI, không tốn phí)');
  if (r.truncated) chip('badge-err', `✂ BỊ CẮT sau ${r.rounds} vòng`, 'finish_reason=length');
  else if (r.rounds > 1) chip('badge-warn', `↪ tự nối ${r.rounds} vòng`);
  if (r.fallbackFrom) chip('badge-warn', `🔄 fallback từ ${r.fallbackFrom.provider || r.fallbackFrom}`);
  if (r.provider) chip('badge-outline', `${r.provider}/${r.model}`);
  const u = r.usage;
  if (u) chip('badge-outline', `${fmtInt((u.inTokens || 0) + (u.outTokens || 0))} token${u.tokenSource === 'provider' ? '' : ' (ước lượng)'}`, `vào ${fmtInt(u.inTokens)} · ra ${fmtInt(u.outTokens)} · nguồn: ${u.tokenSource === 'provider' ? 'usage của provider' : u.tokenSource === 'mixed' ? 'một phần ước lượng' : 'ước lượng ký tự/4'}`);
  if (!r.cached) chip(r.cost === null || r.cost === undefined ? 'badge-off' : 'badge-on', r.cost === null || r.cost === undefined ? (r.costKnownPart ? `💰 ≥ ${formatUsd(r.costKnownPart)} (một phần không rõ giá)` : '💰 không rõ giá') : '💰 ' + formatUsd(r.cost));
  if (r.error) chip('badge-err', 'lỗi vòng nối', r.error);
  return h('div', { class: 'row' }, ...chips);
}

function stat(id, label, value, sub = '') {
  return h('div', { class: 'stat', id }, h('div', { class: 'stat-v' }, value), h('div', { class: 'stat-l' }, label), sub ? (typeof sub === 'string' ? h('div', { class: 'stat-sub' }, sub) : sub) : null);
}

/** Thanh thống kê đầu trang. */
export async function renderStats(app, container) {
  const s = app.settings.get();
  const metas = Object.keys(app.state.providerMeta);
  const active = metas.filter((pid) => s.activeProviders.includes(pid) && app.llm.hasKey(pid)).length;
  const clientKeys = metas.reduce((n, pid) => n + (app.keyring.available ? app.keyring.count(pid) : 0), 0);
  const serverKeys = metas.reduce((n, pid) => n + (app.state.providerMeta[pid]?.serverKeyCount || 0), 0);
  const models = metas.reduce((n, pid) => n + (app.state.modelCache[pid]?.models?.length || 0), 0);
  const day = await app.budget.getDay();
  const proj = app.state.project ? await app.budget.getProject(app.state.project.id) : null;
  app.state.projectUsage = proj;
  const pct = s.dailyBudgetUsd > 0 ? Math.min(100, (day.knownCostUsd / s.dailyBudgetUsd) * 100) : 0;
  const meter = h('meter', { class: 'budget-meter', min: '0', max: '100', low: '70', high: '90', optimum: '0', value: String(pct), 'aria-label': 'Mức dùng ngân sách ngày' });
  mount(container,
    stat('st-prov', 'Provider bật', String(active), `${metas.length} khả dụng`),
    stat('st-keys', 'API keys', String(clientKeys + serverKeys), `${clientKeys} trình duyệt · ${serverKeys} server`),
    stat('st-models', 'Models', String(models), models ? 'từ API' : 'chưa tải'),
    stat('st-skills', 'Skills', String(app.state.project?.workspace?.skills?.length || 0)),
    stat('st-tokens', 'Token hôm nay', fmtInt(day.inTokens + day.outTokens), day.estimatedTokenCalls ? `${day.estimatedTokenCalls} lượt ước lượng` : 'từ usage'),
    stat('st-cost', 'Chi phí hôm nay', formatUsd(day.knownCostUsd, { unknownLabel: '$0' }),
      h('div', null, meter, h('div', { class: 'stat-sub' }, `/${formatUsd(s.dailyBudgetUsd)}${day.unknownPriceCalls ? ` · +${day.unknownPriceCalls} không rõ giá` : ''}`))));
}
