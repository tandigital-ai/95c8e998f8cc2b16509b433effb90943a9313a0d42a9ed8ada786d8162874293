/**
 * settingsView.js — Màn hình Cài đặt: gọi AI, cache, fallback chain, ngân sách, giá, banner,
 * proxy access token, sao lưu/khôi phục DB, trang Giới hạn.
 */
import { h, mount, fmtTime, fmtBytes } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { markdownView } from '../ui/markdownView.js';
import { downloadText } from '../core/exporter.js';
import { providerModels, usableProviders } from './models.js';

function num(app, key, label, { min = 0, max = 1e9, step = 'any', hint = '' } = {}) {
  const id = 'set-' + key;
  const inp = h('input', { class: 'inp', type: 'number', id, min: String(min), max: String(max), step: String(step), value: String(app.settings.get()[key]) });
  inp.addEventListener('change', async () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v < min || v > max) { app.toast(`${label}: giá trị không hợp lệ`, 'err'); inp.value = String(app.settings.get()[key]); return; }
    await app.settings.update({ [key]: v });
    app.emit('settings');
    app.toast(`Đã lưu: ${label}`, 'ok');
  });
  return h('div', { class: 'field' }, h('label', { for: id }, label), inp, hint ? h('div', { class: 'field-hint' }, hint) : null);
}

function check(app, key, label, hint = '') {
  const inp = h('input', { type: 'checkbox', checked: !!app.settings.get()[key] });
  inp.addEventListener('change', async () => { await app.settings.update({ [key]: inp.checked }); app.emit('settings'); });
  return h('div', { class: 'field' }, h('label', { class: 'check' }, inp, label), hint ? h('div', { class: 'field-hint' }, hint) : null);
}

function section(title, ...children) {
  return h('section', { class: 'card' }, h('h3', { class: 'section-title' }, title), ...children);
}

/* ---------- Fallback chain editor ---------- */
function fallbackEditor(app) {
  const box = h('div', { class: 'col' });
  const render = () => {
    const chain = app.settings.get().fallbackChain || [];
    const rows = chain.map((f, i) => h('div', { class: 'row' },
      h('span', { class: 'badge badge-outline' }, String(i + 1)),
      h('span', { class: 'mono small grow' }, `${f.provider}:${f.model}`),
      app.llm.hasKey(f.provider) ? h('span', { class: 'badge badge-on' }, 'có key') : h('span', { class: 'badge badge-warn' }, 'chưa có key — sẽ bỏ qua'),
      h('button', { class: 'btn btn-xs btn-out', disabled: i === 0, 'aria-label': 'Lên', onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'btn btn-xs btn-out', disabled: i === chain.length - 1, 'aria-label': 'Xuống', onclick: () => move(i, 1) }, '↓'),
      h('button', { class: 'btn btn-xs btn-danger', 'aria-label': 'Xóa', onclick: () => save(chain.filter((_, k) => k !== i)) }, '✕')));
    const sel = h('select', { class: 'sel', 'aria-label': 'Thêm model dự phòng' }, h('option', { value: '' }, '— thêm provider:model —'));
    for (const pid of usableProviders(app)) for (const m of providerModels(app, pid)) sel.appendChild(h('option', { value: `${pid}:${m.id}` }, `${pid}:${m.id}${m.verified ? '' : ' (chưa xác minh)'}`));
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const i = sel.value.indexOf(':');
      save([...chain, { provider: sel.value.slice(0, i), model: sel.value.slice(i + 1) }]);
    });
    mount(box, ...(rows.length ? rows : [h('div', { class: 'small muted' }, 'Chưa có model dự phòng.')]), sel);
  };
  const move = (i, d) => { const c = [...app.settings.get().fallbackChain]; [c[i], c[i + d]] = [c[i + d], c[i]]; save(c); };
  const save = async (c) => { await app.settings.replace('fallbackChain', c); render(); };
  render();
  return box;
}

/* ---------- Bảng giá ---------- */
function pricingEditor(app) {
  const box = h('div', { class: 'col' });
  const render = () => {
    const pricing = app.settings.get().pricing || {};
    const rows = Object.entries(pricing).map(([k, v]) => h('tr', null,
      h('td', { class: 'mono' }, k), h('td', { class: 'num' }, String(v.in)), h('td', { class: 'num' }, String(v.out)),
      h('td', null, h('button', { class: 'btn btn-xs btn-danger', onclick: async () => { const p = { ...pricing }; delete p[k]; await app.settings.replace('pricing', p); render(); } }, '✕'))));
    const refSel = h('select', { class: 'sel', 'aria-label': 'Model' }, h('option', { value: '' }, '— chọn provider:model —'));
    for (const pid of Object.keys(app.state.providerMeta)) for (const m of providerModels(app, pid)) refSel.appendChild(h('option', { value: `${pid}:${m.id}` }, `${pid}:${m.id}`));
    const pin = h('input', { class: 'inp', type: 'number', min: '0', step: 'any', placeholder: 'Vào ($/1M)', 'aria-label': 'Giá token vào' });
    const pout = h('input', { class: 'inp', type: 'number', min: '0', step: 'any', placeholder: 'Ra ($/1M)', 'aria-label': 'Giá token ra' });
    const add = h('button', {
      class: 'btn btn-sm btn-pri',
      onclick: async () => {
        const a = Number(pin.value);
        const b = Number(pout.value);
        if (!refSel.value || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || pin.value === '' || pout.value === '') { app.toast('Nhập đủ model và 2 giá (≥ 0)', 'err'); return; }
        await app.settings.update({ pricing: { ...pricing, [refSel.value]: { in: a, out: b } } });
        render();
      }
    }, 'Thêm giá');
    const dyn = Object.entries(app.llm.getProviderPricing()).filter(([, v]) => Object.keys(v || {}).length);
    mount(box,
      h('div', { class: 'small muted' }, 'Giá tính theo USD / 1 triệu token. Model không có giá ⇒ hiển thị "không rõ giá" và KHÔNG cộng vào ngân sách.'),
      dyn.length ? h('div', { class: 'small text-info' }, '✔ Có giá động từ API: ' + dyn.map(([p, v]) => `${p} (${Object.keys(v).length} model)`).join(', ') + '. Giá bạn nhập ở dưới được ưu tiên.') : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Model'), h('th', { class: 'num' }, 'Vào'), h('th', { class: 'num' }, 'Ra'), h('th', null, ''))), h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '4', class: 'muted' }, 'Chưa nhập giá nào.'))))),
      h('div', { class: 'form-grid' }, refSel, pin, pout, add));
  };
  render();
  return box;
}

/* ---------- Banner ---------- */
function bannerEditor(app) {
  const b = app.settings.get().authorBanner;
  const en = h('input', { type: 'checkbox', checked: !!b.enabled });
  const author = h('input', { class: 'inp', value: b.author || '', placeholder: 'Tên tác giả', 'aria-label': 'Tác giả' });
  const contact = h('input', { class: 'inp', value: b.contact || '', placeholder: 'Liên hệ/website', 'aria-label': 'Liên hệ' });
  const tagline = h('input', { class: 'inp', value: b.tagline || '', placeholder: 'Khẩu hiệu (tùy chọn)', 'aria-label': 'Khẩu hiệu' });
  const save = async () => { await app.settings.update({ authorBanner: { enabled: en.checked, author: author.value.trim(), contact: contact.value.trim(), tagline: tagline.value.trim() } }); app.toast('Đã lưu banner', 'ok'); };
  [en, author, contact, tagline].forEach((x) => x.addEventListener('change', save));
  return h('div', { class: 'col' },
    h('label', { class: 'check' }, en, 'Chèn banner tác giả vào đầu file khi xuất (mặc định TẮT)'),
    h('div', { class: 'form-grid' }, author, contact, tagline),
    h('div', { class: 'field-hint' }, 'Chỉ chèn lúc Export, không sửa dữ liệu đã lưu. Không chèn vào .json/.md/.txt/.env; giữ dòng shebang; không chèn 2 lần.'));
}

/* ---------- Proxy token ---------- */
function proxyTokenEditor(app) {
  const box = h('div', { class: 'col' });
  const need = app.state.health?.accessTokenRequired;
  const has = !!app.getAccessToken();
  const inp = h('input', { class: 'inp', type: 'password', autocomplete: 'off', placeholder: has ? '•••••• (đã lưu)' : 'Nhập ACCESS_TOKEN của proxy', 'aria-label': 'Access token' });
  mount(box,
    h('div', { class: need ? 'warn-box small' : 'small muted' }, need ? '🔒 Proxy đang BẬT ACCESS_TOKEN — cần nhập đúng mới gọi được API.' : 'Proxy không yêu cầu ACCESS_TOKEN (chỉ an toàn khi HOST=127.0.0.1).'),
    h('div', { class: 'row' }, inp, h('button', {
      class: 'btn btn-sm btn-pri',
      onclick: async () => {
        const v = inp.value.trim();
        inp.value = '';
        const ok = await app.guard(() => app.setAccessToken(v), 'Lưu access token');
        if (ok !== undefined) app.toast(v ? `Đã lưu token (${app.vault.isUnlocked ? (app.vault.mode === 'memory' ? 'chỉ RAM' : 'trong vault') : 'chỉ RAM phiên này'})` : 'Đã xóa token', 'ok');
      }
    }, 'Lưu')),
    h('div', { class: 'field-hint' }, 'Token được giữ trong vault (mã hóa) nếu vault đang mở; nếu không chỉ giữ trong RAM.'));
  return box;
}

/* ---------- Sao lưu ---------- */
function backupEditor(app) {
  const box = h('div', { class: 'col' });
  const fileInp = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', 'aria-label': 'Chọn file sao lưu' });
  const incVault = h('input', { type: 'checkbox' });
  const last = app.settings.get().lastBackupAt;
  fileInp.addEventListener('change', async () => {
    const f = fileInp.files?.[0];
    fileInp.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (e) { app.toast('File không phải JSON hợp lệ: ' + e.message, 'err'); return; }
    const replace = await confirmDialog({ title: 'Khôi phục dữ liệu', message: 'Chọn cách khôi phục: "Thay thế" sẽ XÓA dữ liệu hiện tại của các mục có trong file sao lưu. "Gộp" giữ dữ liệu hiện có, ghi đè bản trùng khóa (version không bao giờ bị ghi đè).', okText: 'Thay thế', cancelText: 'Gộp' });
    const r = await app.guard(() => app.db.importAll(data, { mode: replace ? 'replace' : 'merge' }), 'Khôi phục');
    if (r) { app.toast('Đã khôi phục: ' + Object.entries(r.imported).map(([k, v]) => `${k} ${v}`).join(', ') + '. Trang sẽ tải lại.', 'ok'); setTimeout(() => location.reload(), 1500); }
  });
  mount(box,
    h('div', { class: 'small' }, 'Sao lưu toàn bộ dự án, version, lịch sử chi phí, log và cài đặt ra 1 file JSON. ', h('b', null, 'Mặc định KHÔNG kèm khóa API.')),
    h('div', { class: last && Date.now() - last < 7 * 864e5 ? 'small muted' : 'small text-warn' }, last ? `Lần sao lưu gần nhất: ${fmtTime(last)}` : '⚠ Bạn chưa sao lưu lần nào.'),
    h('label', { class: 'check' }, incVault, 'Kèm vault (vẫn ở dạng MÃ HÓA, cần mật khẩu để mở) — dùng khi chuyển máy'),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn btn-pri',
        onclick: async () => {
          const data = await app.guard(() => app.db.exportAll({ includeVault: incVault.checked }), 'Sao lưu');
          if (!data) return;
          const text = JSON.stringify(data);
          downloadText(`ai-architect-backup_${new Date().toISOString().slice(0, 10)}.json`, text, 'application/json');
          await app.settings.update({ lastBackupAt: Date.now() });
          app.toast(`Đã xuất sao lưu (${fmtBytes(text.length)})`, 'ok');
        }
      }, '💾 Xuất sao lưu JSON'),
      h('button', { class: 'btn btn-out', onclick: () => fileInp.click() }, '📂 Khôi phục từ file'),
      fileInp));
  return box;
}

/* ---------- Cache ---------- */
function cacheEditor(app) {
  const info = h('span', { class: 'small muted' }, '…');
  const refresh = async () => { const s = await app.llm.cacheStats(); info.textContent = `${s.entries} mục (${s.expired} hết hạn)`; };
  refresh().catch((e) => { info.textContent = 'Lỗi: ' + e.message; });
  return h('div', { class: 'col' },
    check(app, 'cacheEnabled', 'Bật cache khớp tuyệt đối', 'Gọi lại y hệt (provider, model, nội dung, tham số) ⇒ dùng kết quả cũ, gắn nhãn "Cached". Chỉ cache kết quả hoàn tất (không bị cắt, không fallback).'),
    num(app, 'cacheTtlHours', 'Thời gian giữ cache (giờ)', { min: 0, max: 720 }),
    h('div', { class: 'row' }, info,
      h('button', { class: 'btn btn-xs btn-out', onclick: async () => { const n = await app.guard(() => app.llm.purgeExpiredCache(), 'Dọn cache'); await refresh(); if (n !== undefined) app.toast(`Đã dọn ${n} mục hết hạn`, 'ok'); } }, 'Dọn hết hạn'),
      h('button', { class: 'btn btn-xs btn-danger', onclick: async () => { await app.guard(() => app.llm.clearCache(), 'Xóa cache'); await refresh(); app.toast('Đã xóa cache', 'ok'); } }, '🗑️ Xóa cache')));
}

export function openSettings(app) {
  const s = app.settings.get();
  const confirmSel = h('select', { class: 'sel', 'aria-label': 'Khi vượt ngân sách' },
    h('option', { value: 'once', selected: s.confirmOverBudget === 'once' }, 'Hỏi 1 lần cho mỗi phạm vi (ngày/dự án)'),
    h('option', { value: 'each', selected: s.confirmOverBudget === 'each' }, 'Hỏi MỖI lần gọi AI'),
    h('option', { value: 'never', selected: s.confirmOverBudget === 'never' }, 'Không hỏi (chỉ hiện cảnh báo)'));
  confirmSel.addEventListener('change', () => app.settings.update({ confirmOverBudget: confirmSel.value }));

  const filterInp = h('input', { class: 'inp mono', value: s.modelFilterRegex, 'aria-label': 'Regex lọc model' });
  filterInp.addEventListener('change', async () => {
    try { new RegExp(filterInp.value, 'i'); } catch (e) { app.toast('Regex không hợp lệ: ' + e.message, 'err'); return; }
    await app.settings.update({ modelFilterRegex: filterInp.value });
    app.toast('Đã lưu. Bấm "Tải models" lại để áp dụng.', 'ok');
  });

  const streamUsage = h('div', { class: 'col' }, ...Object.keys(app.state.providerMeta).map((pid) => {
    const c = h('input', { type: 'checkbox', checked: app.settings.providerOpt(pid).streamUsage !== false });
    c.addEventListener('change', () => app.settings.update({ providerOptions: { [pid]: { streamUsage: c.checked } } }));
    return h('label', { class: 'check' }, c, `${pid}: gửi stream_options.include_usage`);
  }));

  const body = h('div', { class: 'col' },
    section('🤖 Gọi AI',
      h('div', { class: 'form-grid' },
        num(app, 'temperature', 'Nhiệt độ (temperature)', { min: 0, max: 2 }),
        num(app, 'maxTokens', 'max_tokens mỗi lượt', { min: 256, max: 200000, step: 1, hint: 'Một số model có giới hạn thấp hơn — nếu provider báo lỗi 400, hãy giảm.' }),
        num(app, 'maxContinueRounds', 'Số vòng tự nối tối đa', { min: 1, max: 10, step: 1, hint: 'Vẫn bị cắt sau số vòng này ⇒ đánh dấu TRUNCATED.' }),
        num(app, 'maxRetries', 'Số lần thử lại', { min: 0, max: 6, step: 1 }),
        num(app, 'backoffBaseMs', 'Backoff gốc (ms)', { min: 100, max: 60000, step: 100 }),
        num(app, 'backoffMaxMs', 'Backoff tối đa (ms)', { min: 500, max: 120000, step: 100 })),
      check(app, 'streamByDefault', 'Streaming (hiện chữ dần) mặc định'),
      h('details', { class: 'mt-8' }, h('summary', { class: 'small' }, 'Tùy chọn kỹ thuật theo provider (CHƯA XÁC MINH — sửa nếu provider báo lỗi)'), streamUsage,
        h('div', { class: 'field mt-8' }, h('label', null, 'Regex lọc model không phải chat'), filterInp))),
    section('🗄️ Cache', cacheEditor(app)),
    section('🔄 Fallback chain',
      check(app, 'fallbackEnabled', 'Bật fallback khi provider chính lỗi (mặc định TẮT)', 'Khi bật, dữ liệu (kể cả ảnh/tệp) có thể được gửi sang provider dự phòng. App hỏi xác nhận và ghi log mỗi lần. Provider không có key sẽ bị bỏ qua.'),
      fallbackEditor(app)),
    section('💰 Ngân sách (CẢNH BÁO, không chặn cứng)',
      h('div', { class: 'form-grid' },
        num(app, 'dailyBudgetUsd', 'Ngân sách / ngày (USD)', { min: 0 }),
        num(app, 'projectBudgetUsd', 'Ngân sách / dự án (USD)', { min: 0 }),
        h('div', { class: 'field' }, h('label', null, 'Khi vượt ngân sách'), confirmSel)),
      h('div', { class: 'field-hint' }, 'Chỉ tính được chi phí khi biết giá. Lần gọi "không rõ giá" được đếm riêng.')),
    section('🏷️ Bảng giá model', pricingEditor(app)),
    section('🔐 Vault', num(app, 'vaultAutoLockMinutes', 'Tự khóa sau (phút, 0 = tắt)', { min: 0, max: 1440, step: 1 })),
    section('🔑 Access token của proxy', proxyTokenEditor(app)),
    section('📚 Lịch sử', num(app, 'maxVersionsPerProject', 'Giữ tối đa N version/dự án (không xóa bản ghim)', { min: 1, max: 500, step: 1 })),
    section('✍️ Banner tác giả', bannerEditor(app)),
    section('💾 Sao lưu & khôi phục', backupEditor(app)),
    section('♻️ Đặt lại', h('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        if (!(await confirmDialog({ title: 'Đặt lại cài đặt', message: 'Đưa toàn bộ cài đặt về mặc định? (Dự án, key và lịch sử KHÔNG bị xóa.)', okText: 'Đặt lại', danger: true }))) return;
        await app.settings.reset();
        app.toast('Đã đặt lại cài đặt', 'ok');
        location.reload();
      }
    }, 'Đặt lại cài đặt mặc định')));
  openModal({ title: '⚙️ Cài đặt', body, size: 'wide', onClose: () => { app.emit('settings'); app.emit('providers'); app.emit('models'); app.emit('stats'); } });
}

/** Trang "Giới hạn" — đọc docs/LIMITATIONS.md qua proxy. */
export async function openLimitations(app) {
  const body = h('div', null, h('div', { class: 'loading-line' }, h('span', { class: 'spinner' }), 'Đang tải...'));
  openModal({ title: '⚠️ Giới hạn của ứng dụng', body, size: 'wide' });
  try {
    const r = await fetch('/docs/LIMITATIONS.md', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    mount(body, markdownView(await r.text()));
  } catch (e) {
    await app.logger.error('ui', 'Không tải được LIMITATIONS.md: ' + e.message);
    mount(body, h('div', { class: 'error-box' }, 'Không tải được docs/LIMITATIONS.md: ' + e.message));
  }
}
