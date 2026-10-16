/**
 * providersPanel.js — Panel Providers: thêm/xóa key (che), Test Ping, Load Models, chọn model, Activate.
 * Key KHÔNG BAO GIỜ được đưa vào DOM — chỉ bản che abcd••••wxyz.
 */
import { h, mount, fmtTime, loadingView } from '../ui/dom.js';
import { confirmDialog } from '../ui/modal.js';
import { providerModels } from './models.js';
import { openVaultDialog } from './vaultUi.js';

const expanded = new Set();

export function renderProviders(app, container) {
  const metas = Object.values(app.state.providerMeta);
  if (!app.state.health) {
    mount(container, app.state.healthError
      ? h('div', { class: 'error-box', role: 'alert' }, '❌ Không kết nối được proxy: ', app.state.healthError, h('div', { class: 'small mt-8' }, 'Hãy chạy "npm start" trong thư mục dự án rồi tải lại trang.'))
      : loadingView('Đang kết nối proxy...'));
    return;
  }
  if (!metas.length) { mount(container, h('div', { class: 'empty' }, 'Proxy không khai báo provider nào.')); return; }
  mount(container, ...metas.map((m) => providerCard(app, m)));
}

function keyModeLabel(app, pid) {
  const plan = app.llm.keyPlan(pid);
  if (plan === 'client') return 'key trình duyệt';
  if (plan === 'server') return 'key server (.env)';
  return 'chưa có key';
}

function providerCard(app, meta) {
  const pid = meta.id;
  const s = app.settings.get();
  const active = s.activeProviders.includes(pid);
  const clientKeys = app.keyring.available ? app.keyring.listMasked(pid) : [];
  const serverCount = meta.serverKeyCount || 0;
  const hasKey = app.llm.hasKey(pid);
  const ping = app.state.ping[pid];
  const models = providerModels(app, pid);
  const cache = app.state.modelCache[pid];
  const opt = app.settings.providerOpt(pid);

  const dot = h('span', { class: ['dot', ping?.loading ? 'loading' : ping ? (ping.ok ? 'ok' : 'err') : ''], title: ping ? ping.message : 'Chưa test' });
  const badge = hasKey
    ? h('span', { class: ['badge', active ? 'badge-on' : 'badge-off'] }, active ? `● Bật · ${keyModeLabel(app, pid)}` : `○ Tắt · ${keyModeLabel(app, pid)}`)
    : h('span', { class: 'badge badge-off' }, '○ Chưa có key');

  const card = h('section', { class: ['pv-card', active ? 'active' : '', expanded.has(pid) ? 'expanded' : ''], 'aria-label': meta.name });
  const top = h('button', {
    class: 'pv-top', 'aria-expanded': expanded.has(pid) ? 'true' : 'false',
    onclick: () => { if (expanded.has(pid)) expanded.delete(pid); else expanded.add(pid); app.emit('providers'); }
  }, h('span', { class: 'pv-info' }, h('span', { class: 'pv-icon', 'aria-hidden': 'true' }, pid.slice(0, 2).toUpperCase()), h('span', { class: 'pv-name' }, meta.name), dot), badge);

  // ---- Keys ----
  const keysBox = h('div', { class: 'col mt-8' });
  keysBox.appendChild(h('div', { class: 'field-label' }, 'API keys'));
  if (serverCount) keysBox.appendChild(h('div', { class: 'small muted' }, `🖥️ Proxy đang giữ ${serverCount} key trong server/.env (trình duyệt không thấy).`));
  if (!app.keyring.available) {
    keysBox.appendChild(h('div', { class: 'warn-box small' }, '🔐 Vault đang khóa/chưa tạo — key trong trình duyệt chưa dùng được. ', h('button', { class: 'btn btn-xs btn-out', onclick: () => openVaultDialog(app) }, 'Mở vault')));
  } else {
    if (!clientKeys.length) keysBox.appendChild(h('div', { class: 'small muted' }, 'Chưa có key trong trình duyệt.'));
    for (const k of clientKeys) {
      const statusBadge = k.status === 'cooldown'
        ? h('span', { class: 'badge badge-warn', title: 'Đến ' + fmtTime(k.cooldownUntil) }, 'cooldown')
        : k.status === 'invalid' ? h('span', { class: 'badge badge-err' }, 'không hợp lệ') : h('span', { class: 'badge badge-on' }, 'sẵn sàng');
      keysBox.appendChild(h('div', { class: 'key-row' },
        h('span', { class: 'key-mask', title: k.label || '' }, k.masked),
        h('span', { class: 'small muted nowrap', title: 'Số lần dùng trong 60s' }, `${k.usesLastMinute}/phút`),
        statusBadge,
        k.status !== 'ready' ? h('button', { class: 'btn btn-xs btn-out', title: 'Bỏ cooldown', onclick: () => { app.keyring.resetCooldown(k.id); app.emit('providers'); } }, '↺') : null,
        h('button', {
          class: 'btn btn-xs btn-danger', 'aria-label': 'Xóa key ' + k.masked,
          onclick: async () => {
            if (!(await confirmDialog({ title: 'Xóa key', message: `Xóa key ${k.masked} của ${meta.name}?`, okText: 'Xóa', danger: true }))) return;
            await app.guard(() => app.keyring.removeKey(pid, k.id), 'Xóa key');
            app.toast('Đã xóa key', 'warn');
            app.emit('providers');
          }
        }, '✕')));
    }
    const ta = h('textarea', { class: 'ta mono', rows: '2', placeholder: 'Dán API key, mỗi dòng 1 key (nhiều key ⇒ tự xoay vòng)', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Nhập API key cho ' + meta.name });
    keysBox.appendChild(ta);
    keysBox.appendChild(h('div', { class: 'row' },
      h('button', {
        class: 'btn btn-xs btn-suc',
        onclick: async () => {
          const v = ta.value;
          ta.value = ''; // xóa khỏi DOM ngay
          const r = await app.guard(() => app.keyring.addKeys(pid, v), 'Lưu key');
          if (!r) return;
          app.toast(`Đã lưu ${r.added} key${r.duplicates ? `, bỏ ${r.duplicates} trùng` : ''} (${app.vault.mode === 'memory' ? 'chỉ RAM' : 'vault mã hóa'})`, 'ok');
          if (!s.activeProviders.includes(pid)) await app.settings.update({ activeProviders: [...s.activeProviders, pid] });
          app.emit('providers');
          app.emit('models');
        }
      }, '💾 Lưu key'),
      clientKeys.length ? h('button', {
        class: 'btn btn-xs btn-out',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Xóa tất cả key', message: `Xóa toàn bộ key trình duyệt của ${meta.name}?`, okText: 'Xóa hết', danger: true }))) return;
          await app.guard(() => app.keyring.clearProvider(pid), 'Xóa key');
          app.emit('providers');
        }
      }, '🗑️ Xóa hết') : null));
  }

  // ---- Key mode ----
  const modeSel = h('select', { class: 'sel', 'aria-label': 'Nguồn key' },
    h('option', { value: 'auto', selected: opt.keyMode === 'auto' }, 'Tự động (trình duyệt → server)'),
    h('option', { value: 'client', selected: opt.keyMode === 'client' }, 'Chỉ key trình duyệt'),
    h('option', { value: 'server', selected: opt.keyMode === 'server' }, 'Chỉ key server (.env)'));
  modeSel.addEventListener('change', async () => {
    await app.settings.update({ providerOptions: { [pid]: { keyMode: modeSel.value } } });
    app.emit('providers'); app.emit('models');
  });

  // ---- Models ----
  const modelSel = h('select', { class: 'sel', 'aria-label': 'Model mặc định của ' + meta.name });
  modelSel.appendChild(h('option', { value: '' }, models.length ? '— model mặc định —' : 'Chưa có model — bấm "Tải models"'));
  for (const m of models) modelSel.appendChild(h('option', { value: m.id, selected: m.id === opt.selectedModel }, m.id + (m.verified ? '' : ' (chưa xác minh)')));
  modelSel.addEventListener('change', () => app.settings.update({ providerOptions: { [pid]: { selectedModel: modelSel.value } } }));

  const modelInfo = cache?.models?.length
    ? h('div', { class: 'small muted' }, `✔ ${cache.models.length} model lấy từ API lúc ${fmtTime(cache.fetchedAt)}${Object.keys(cache.pricing || {}).length ? ` · ${Object.keys(cache.pricing).length} có giá` : ''}`)
    : h('div', { class: 'small text-warn' }, meta.fallbackModels?.length ? '⚠ Đang dùng danh sách gợi ý CHƯA XÁC MINH. Bấm "Tải models" để lấy danh sách thật.' : '⚠ Chưa có danh sách model. Bấm "Tải models".');

  const customInp = h('input', { class: 'inp mono', placeholder: 'Thêm tên model thủ công', 'aria-label': 'Tên model thủ công' });
  const addCustom = h('button', {
    class: 'btn btn-xs btn-out',
    onclick: async () => {
      const v = customInp.value.trim();
      if (!v) return;
      const extra = [...new Set([...(opt.extraModels || []), v])];
      await app.settings.update({ providerOptions: { [pid]: { extraModels: extra } } });
      app.toast(`Đã thêm "${v}" (chưa xác minh)`, 'info');
      app.emit('providers'); app.emit('models');
    }
  }, '+');

  const actions = h('div', { class: 'row mt-8' },
    h('button', { class: 'btn btn-xs btn-out', disabled: !hasKey, onclick: () => app.actions.ping(pid) }, '📡 Test Ping'),
    h('button', { class: 'btn btn-xs btn-out', disabled: !hasKey, onclick: () => app.actions.loadModels(pid) }, '🔄 Tải models'),
    h('button', {
      class: ['btn btn-xs', active ? 'btn-out' : 'btn-pri'], disabled: !hasKey && !active,
      onclick: async () => {
        const list = s.activeProviders.includes(pid) ? s.activeProviders.filter((x) => x !== pid) : [...s.activeProviders, pid];
        await app.settings.update({ activeProviders: list });
        app.emit('providers'); app.emit('models');
      }
    }, active ? '⏸ Tắt' : '▶ Bật (Activate)'));

  const body = h('div', { class: 'pv-body' },
    meta.notes ? h('div', { class: 'small muted' }, meta.notes) : null,
    keysBox,
    h('div', { class: 'field mt-8' }, h('label', null, 'Nguồn key'), modeSel),
    h('div', { class: 'field mt-8' }, h('label', null, 'Model'), modelSel, modelInfo),
    h('div', { class: 'row mt-8' }, customInp, addCustom),
    ping && !ping.loading ? h('div', { class: ['small mt-8', ping.ok ? 'text-ok' : 'text-err'] }, (ping.ok ? '✅ ' : '❌ ') + ping.message) : null,
    actions);
  card.append(top, body);
  return card;
}
