/**
 * models.js — Danh sách model theo provider và bộ chọn model cho từng vai trò.
 * Giá trị chọn dạng "provider:model" — tách ở dấu ":" ĐẦU TIÊN (sửa lỗi bản GAS cắt mất
 * phần sau của model kiểu "x/y:free").
 */
import { h, selectOptions } from '../ui/dom.js';

export const ROLES = Object.freeze({
  architect: 'Orchestrator (kiến trúc)',
  diagram: 'Diagram',
  contract: 'Contract (nên dùng model mạnh)',
  code: 'Sinh code',
  review: 'Review & Fix',
  seed: 'Dữ liệu mẫu',
  readme: 'README',
  analyze: 'Phân tích ảnh/tệp',
  playground: 'Skill Playground'
});

export function splitModelRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}
export const joinModelRef = (provider, model) => `${provider}:${model}`;

/**
 * Model khả dụng của 1 provider.
 * @returns {Array<{id, verified:boolean, source:'remote'|'fallback'|'custom'}>}
 */
export function providerModels(app, pid) {
  const remote = app.state.modelCache[pid];
  const opt = app.settings.providerOpt(pid);
  const meta = app.state.providerMeta[pid];
  const out = [];
  const seen = new Set();
  if (remote?.models?.length) remote.models.forEach((id) => { out.push({ id, verified: true, source: 'remote' }); seen.add(id); });
  else (meta?.fallbackModels || []).forEach((id) => { out.push({ id, verified: false, source: 'fallback' }); seen.add(id); });
  (opt.extraModels || []).forEach((id) => { if (!seen.has(id)) { out.push({ id, verified: false, source: 'custom' }); seen.add(id); } });
  return out;
}

/** Provider được bật + có key (client hoặc server). */
export function usableProviders(app) {
  return Object.keys(app.state.providerMeta).filter((pid) => app.settings.get().activeProviders.includes(pid) && app.llm.hasKey(pid));
}

/** Đổ option vào <select> cho vai trò, có option "dùng model Orchestrator". */
export function fillModelSelect(app, sel, role, { allowInherit = true } = {}) {
  const roles = app.settings.get().roles || {};
  const current = roles[role] || '';
  const items = [];
  if (allowInherit && role !== 'architect') items.push({ value: '', label: '— Dùng model Orchestrator —' });
  else items.push({ value: '', label: '— Chọn model —' });
  for (const pid of usableProviders(app)) {
    const name = app.state.providerMeta[pid]?.name || pid;
    for (const m of providerModels(app, pid)) {
      items.push({ value: joinModelRef(pid, m.id), label: m.id + (m.verified ? '' : ' (chưa xác minh)'), group: name });
    }
  }
  if (current && !items.some((x) => x.value === current)) items.push({ value: current, label: current + ' (không khả dụng — kiểm tra key/model)', group: 'Đã chọn trước' });
  selectOptions(sel, items, current);
}

/** Model hiệu lực cho vai trò (kế thừa architect nếu để trống). Ném lỗi rõ ràng nếu chưa chọn. */
export function modelFor(app, role) {
  const roles = app.settings.get().roles || {};
  const ref = roles[role] || roles.architect;
  const r = splitModelRef(ref);
  if (!r) throw new Error(`Chưa chọn model cho "${ROLES[role] || role}". Hãy chọn model Orchestrator (hoặc model riêng cho bước này).`);
  if (!app.llm.hasKey(r.provider)) throw new Error(`Provider "${r.provider}" (model cho ${ROLES[role] || role}) chưa có API key.`);
  return r;
}

/** Ô chọn model nhỏ gọn cho 1 vai trò, tự lưu vào settings.roles. */
export function roleSelect(app, role, { label = ROLES[role], allowInherit = true } = {}) {
  const id = 'role-' + role;
  const sel = h('select', { class: 'sel', id, 'aria-label': label });
  fillModelSelect(app, sel, role, { allowInherit });
  sel.addEventListener('change', async () => {
    const roles = { ...(app.settings.get().roles || {}), [role]: sel.value };
    await app.settings.update({ roles });
    app.emit('roles');
  });
  // Tự hủy đăng ký khi phần tử đã bị gỡ khỏi trang
  const off = app.on('models', () => {
    if (!sel.isConnected) { off(); return; }
    fillModelSelect(app, sel, role, { allowInherit });
  });
  return h('div', { class: 'field' }, h('label', { for: id }, label), sel);
}
