/**
 * models.js — Danh sách model theo provider và bộ chọn model cho từng vai trò.
 * Giá trị chọn dạng "provider:model" — tách ở dấu ":" ĐẦU TIÊN (sửa lỗi bản GAS cắt mất
 * phần sau của model kiểu "x/y:free").
 */
import { h, selectOptions } from '../ui/dom.js';
import { confirmDialog } from '../ui/modal.js';
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

/* ------------------------------------------------------------------ */
/* ✨ Tự chọn model phù hợp cho từng bước (chấm điểm theo tên model)    */
/* ------------------------------------------------------------------ */
const NOT_CHAT = /embed|tts|whisper|audio|speech|transcri|image|imagen|dall-e|veo|video|moderation|guard|rerank|ocr|realtime|lyria|clip|safety/i;
const STRONG = /opus|sonnet|gpt-5|gpt-4\.1|\bo3\b|\bo4\b|-pro\b|-pro-|large|max|deepseek-(v3|chat)|glm-4\.[5-9]|glm-5|kimi|qwen3-(max|235)|grok-4|magistral|mistral-medium|gpt-oss-120b/i;
const CODER = /codestral|devstral|coder|codex|sonnet|gpt-5|kimi/i;
const FAST = /flash|mini|small|haiku|nano|lite|instant|8b|scout|20b|tiny/i;
const SLOW_REASON = /\br1\b|reasoner|thinking|think/i;
const UNSTABLE = /preview|exp|beta|alpha/i;
const ROLE_WEIGHTS = {
  architect: { strong: 40, coder: 5, fast: -10, slow: -5 },
  contract: { strong: 40, coder: 15, fast: -15, slow: -25 },
  code: { strong: 20, coder: 40, fast: -5, slow: -20 },
  review: { strong: 30, coder: 20, fast: -5, slow: -10 },
  seed: { strong: 5, coder: 0, fast: 30, slow: -25 },
  readme: { strong: 5, coder: 0, fast: 30, slow: -25 },
  diagram: { strong: 10, coder: 0, fast: 25, slow: -25 }
};

/** Điểm của 1 model cho 1 vai trò. Hàm thuần. */
export function scoreModel(id, role) {
  const w = ROLE_WEIGHTS[role] || ROLE_WEIGHTS.code;
  let s = 0;
  if (STRONG.test(id)) s += w.strong;
  if (CODER.test(id)) s += w.coder;
  if (FAST.test(id)) s += w.fast;
  if (SLOW_REASON.test(id)) s += w.slow;
  if (UNSTABLE.test(id)) s -= 8;
  if (/:free\b/i.test(id)) s -= 3;
  const nums = (String(id).match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0 && n < 20);
  if (nums.length) s += Math.min(Math.max(...nums), 10) * 0.5; // ưu tiên phiên bản mới hơn
  return s;
}

export async function autoAssignModels(app) {
  const cands = [];
  for (const pid of usableProviders(app)) for (const m of providerModels(app, pid)) if (!NOT_CHAT.test(m.id)) cands.push({ pid, id: m.id, verified: m.verified });
  if (!cands.length) { app.toast('Chưa có model nào. Bấm "🔄 Tải models" ở panel Providers trước.', 'warn'); return; }
  const order = ['architect', 'contract', 'code', 'review', 'seed', 'readme', 'diagram'];
  const pick = {};
  for (const role of order) {
    let best = null;
    for (const c of cands) {
      let s = scoreModel(c.id, role) + (c.verified ? 5 : -20);
      // QC độc lập: model review nên KHÁC model viết code (ưu tiên khác cả nhà cung cấp)
      if (role === 'review' && pick.code) s += c.pid !== pick.code.pid ? 25 : c.id !== pick.code.id ? 10 : -30;
      if (!best || s > best.s) best = { ...c, s };
    }
    pick[role] = best;
  }
  const rows = order.map((r) => h('tr', null, h('td', null, ROLES[r] || r), h('td', { class: 'mono small' }, `${pick[r].pid} : ${pick[r].id}`)));
  const ok = await confirmDialog({
    title: '✨ Đề xuất model cho từng bước',
    message: h('div', { class: 'col' },
      h('div', { class: 'small muted' }, 'Chấm điểm theo loại model: bước Contract/Kiến trúc dùng model mạnh, Sinh code ưu tiên model chuyên code, Review dùng model KHÁC model viết code, các bước phụ dùng model nhanh/rẻ. Đây là gợi ý; bạn vẫn đổi tay được.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, ...rows)))),
    okText: 'Áp dụng', cancelText: 'Để tôi tự chọn'
  });
  if (!ok) return;
  const roles = { ...(app.settings.get().roles || {}) };
  for (const r of order) roles[r] = joinModelRef(pick[r].pid, pick[r].id);
  await app.settings.update({ roles });
  app.emit('roles');
  app.toast('Đã áp dụng model đề xuất cho 7 bước.', 'ok');
}
