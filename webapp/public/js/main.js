/**
 * main.js — Khởi động ứng dụng và điều phối: tạo "app" (ngữ cảnh dùng chung), nối core với UI.
 */
import { openBestDB, requestPersistentStorage } from './core/db.js';
import { createLogger } from './core/logger.js';
import { createSettingsStore } from './core/settings.js';
import { createVault } from './core/vault.js';
import { createKeyring } from './core/keyring.js';
import { createBudget, formatUsd } from './core/budget.js';
import { createLLMClient } from './core/llmClient.js';
import { createProjectStore } from './core/projectStore.js';
import { PLATFORMS, IDEA_TEMPLATES, filePaths } from './core/platforms.js';
import { h, mount, $, selectOptions, rafThrottle, fmtBytes } from './ui/dom.js';
import { toast } from './ui/toast.js';
import { confirmDialog, closeAllModals } from './ui/modal.js';
import { callMeta, renderStats } from './ui/components.js';
import { renderProviders } from './features/providersPanel.js';
import { openVaultDialog } from './features/vaultUi.js';
import { openSettings, openLimitations } from './features/settingsView.js';
import { roleSelect } from './features/models.js';
import { createPipelineRunner, renderPipelinePanel } from './features/pipelineRunner.js';
import { renderWorkspace, paintLive, selectTab } from './features/workspace.js';
import { generateArchitecture } from './features/architect.js';
import { generateDiagram, openWorkflow } from './features/diagram.js';
import { openAnalyze, dropZone, readAttachments, attachmentChips, LIMITS } from './features/attachments.js';
import { openProjects } from './features/history.js';
import { openCost, openLogs } from './features/costView.js';
import { openExport, downloadContract } from './features/exportUi.js';

const app = {
  state: {
    health: null, healthError: null, providerMeta: {}, modelCache: {}, ping: {},
    project: null, files: {}, job: null, liveText: '', liveNote: '', projectUsage: null, busy: null
  },
  toast,
  ui: { callMeta }
};

/* ---------- Sự kiện nội bộ ---------- */
const listeners = new Map();
app.on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); };
app.emit = (name, data) => {
  for (const fn of listeners.get(name) || []) {
    try { fn(data); } catch (e) { console.error(e); app.logger?.error('ui', `Lỗi xử lý sự kiện "${name}": ${e.message}`); }
  }
};
const frameEmitters = {};
app.emitFrame = (name) => { (frameEmitters[name] ||= rafThrottle(() => app.emit(name)))(); };

/** Chạy 1 thao tác, ghi log + toast khi lỗi (không nuốt lỗi). Trả kết quả hoặc undefined. */
app.guard = async (fn, label = 'Thao tác') => {
  try {
    const r = await fn();
    return r === undefined ? true : r;
  } catch (e) {
    await app.logger?.error('ui', `${label}: ${e?.message || e}`, { code: e?.code, projectId: app.state.project?.id });
    toast(`${label} lỗi: ${e?.message || e}`, 'err');
    return undefined;
  }
};

/* ---------- Proxy access token: trong vault nếu mở, nếu không chỉ RAM ---------- */
let ramAccessToken = '';
app.getAccessToken = () => {
  if (app.vault?.isUnlocked) {
    const t = app.vault.getSecrets().accessToken;
    if (t) return t;
  }
  return ramAccessToken;
};
app.setAccessToken = async (t) => {
  ramAccessToken = t;
  if (app.vault.isUnlocked) {
    const s = app.vault.getSecrets();
    s.accessToken = t;
    await app.vault.setSecrets(s);
  }
};

/* ---------- Dự án ---------- */
app.reloadProject = async () => {
  if (!app.state.project) return;
  try {
    app.state.project = await app.projects.getProject(app.state.project.id);
  } catch (_e) {
    app.state.project = null;
  }
  app.state.files = app.state.project ? await app.projects.filesMap(app.state.project.id) : {};
  app.emit('project');
};

app.actions = {
  async newProject() {
    const platform = $('#platform-select').value || 'gas';
    const p = await app.guard(() => app.projects.create({ name: 'Dự án mới ' + new Date().toLocaleDateString('vi-VN'), platform, outputLang: $('#lang-select').value || 'vi' }), 'Tạo dự án');
    if (!p) return null;
    await app.actions.openProject(p.id);
    toast('Đã tạo dự án mới', 'ok');
    return p;
  },
  async openProject(id) {
    if (app.runner?.running) { toast('Đang chạy pipeline — hãy Hủy trước khi đổi dự án.', 'warn'); return; }
    if (!id) {
      const list = await app.projects.list({ limit: 1 });
      if (list.items[0]) id = list.items[0].id;
      else id = (await app.projects.create({ name: 'Dự án mới', platform: 'gas' })).id;
    }
    app.state.project = await app.projects.getProject(id);
    app.state.files = await app.projects.filesMap(id);
    app.state.liveText = '';
    await app.settings.update({ currentProjectId: id });
    await app.runner.currentJob();
    app.emit('project');
    app.emit('pipeline');
    app.emit('stats');
  },
  async ping(pid) {
    app.state.ping[pid] = { loading: true };
    app.emit('providers');
    const r = await app.llm.ping(pid);
    app.state.ping[pid] = r;
    app.emit('providers');
    toast(`${app.state.providerMeta[pid]?.name || pid}: ${r.message}`, r.ok ? 'ok' : 'err');
    return r;
  },
  async loadModels(pid) {
    const row = await app.guard(() => app.llm.loadModels(pid), `Tải models ${pid}`);
    if (!row) return;
    app.state.modelCache[pid] = row;
    toast(`${app.state.providerMeta[pid]?.name || pid}: ${row.models.length} model`, 'ok');
    app.emit('providers'); app.emit('models'); app.emit('stats');
  }
};

/* ---------- Xác nhận ngân sách / fallback ---------- */
async function confirmBudget({ warnings, label, estimateUnknown }) {
  const lines = warnings.map((w) => `${w.scope === 'day' ? 'Ngân sách NGÀY' : 'Ngân sách DỰ ÁN'}: đã dùng ${formatUsd(w.used)} / ${formatUsd(w.limit)}${w.estimate ? ` (lần này ước tính tối đa +${formatUsd(w.estimate)})` : ''}`);
  return confirmDialog({
    title: '⚠ Sắp vượt ngân sách cảnh báo',
    message: h('div', { class: 'col' }, h('div', null, `Bước: ${label}`), ...lines.map((l) => h('div', null, l)),
      estimateUnknown ? h('div', { class: 'small muted' }, 'Model này không rõ giá — chi phí thật có thể cao hơn.') : null,
      h('div', { class: 'small muted' }, 'Đây chỉ là cảnh báo mềm. Bạn có thể tiếp tục.')),
    okText: 'Vẫn tiếp tục', cancelText: 'Dừng'
  });
}
async function confirmFallback({ from, to, error, step }) {
  return confirmDialog({
    title: '🔄 Dùng provider dự phòng?',
    message: `Bước "${step}" lỗi trên ${from.provider}/${from.model}: ${error}\n\nGửi CÙNG dữ liệu (kể cả ảnh/tệp đính kèm) sang ${to.provider}/${to.model}?`,
    okText: 'Gửi sang dự phòng', cancelText: 'Không'
  });
}

/* ---------- Render ---------- */
function renderConfig() {
  const p = app.state.project;
  const name = $('#project-name');
  if (document.activeElement !== name) name.value = p?.name || '';
  selectOptions($('#platform-select'), Object.values(PLATFORMS).map((x) => ({ value: x.id, label: x.name })), p?.platform || 'gas');
  $('#lang-select').value = p?.outputLang || 'vi';
  selectOptions($('#template-select'), [{ value: '', label: '— Tự nhập —' }, ...Object.entries(IDEA_TEMPLATES).map(([k, v]) => ({ value: k, label: v.name }))], '');
  const idea = $('#idea-input');
  if (document.activeElement !== idea) idea.value = p?.workspace?.idea || '';
  $('#stream-toggle').checked = !!app.settings.get().streamByDefault;
  renderRefs();
}

function renderModelRow() {
  mount($('#model-row'), roleSelect(app, 'architect', { label: '🧠 Model Orchestrator', allowInherit: false }),
    h('details', { class: 'grow' }, h('summary', { class: 'small' }, 'Model riêng cho từng bước (tùy chọn)'),
      h('div', { class: 'model-row mt-8' }, ...['contract', 'code', 'review', 'seed', 'readme', 'diagram'].map((r) => roleSelect(app, r)))));
}

function renderRefs() {
  const w = app.state.project?.workspace;
  const body = $('#refs-body');
  if (!w) { mount(body); return; }
  const images = w.images || [];
  const refFiles = w.refFiles || [];
  $('#refs-count').textContent = String(images.length + refFiles.length);
  const save = (patch) => app.guard(async () => { await app.projects.updateWorkspace(app.state.project.id, patch); await app.reloadProject(); }, 'Lưu tệp đính kèm');
  const thumbs = h('div', { class: 'thumbs' }, ...images.map((im, i) => h('div', { class: 'thumb' }, h('img', { src: im.dataUrl, alt: im.name }),
    h('button', { class: 'icon-btn', 'aria-label': 'Xóa ảnh ' + im.name, onclick: () => save({ images: images.filter((_, k) => k !== i) }) }, '✕'))));
  mount(body,
    h('div', { class: 'small muted' }, `Ảnh tự thu nhỏ (cạnh dài ≤ ${LIMITS.maxImageSide}px), tối đa ${LIMITS.maxImages} ảnh; cần model có "vision". Tệp văn bản/PDF/DOCX ≤ ${LIMITS.maxTextChars.toLocaleString('vi-VN')} ký tự/tệp — phần vượt sẽ bị cắt và có cảnh báo. Ảnh/tệp gửi kèm MỌI vòng nối.`),
    dropZone({
      label: '🖼️ Ảnh giao diện mẫu hoặc 📎 tệp tham chiếu',
      onFiles: async (files) => {
        const r = await readAttachments(files, app.logger);
        const newImgs = r.ok.filter((a) => a.kind === 'image').map((a) => ({ name: a.name, dataUrl: a.dataUrl }));
        const newTxt = r.ok.filter((a) => a.kind === 'text').map((a) => ({ name: a.name, content: a.content, truncated: a.truncated }));
        if (images.length + newImgs.length > LIMITS.maxImages) { toast(`Tối đa ${LIMITS.maxImages} ảnh.`, 'err'); return; }
        await save({ images: [...images, ...newImgs], refFiles: [...refFiles, ...newTxt] });
        for (const a of r.ok) for (const n of a.notes || []) toast(n, 'warn');
        for (const e of r.errors) toast(e, 'err');
        const size = newImgs.reduce((s, x) => s + x.dataUrl.length, 0);
        if (size) toast(`Đã thêm ${newImgs.length} ảnh (~${fmtBytes(size)} base64)`, 'ok');
      }
    }),
    thumbs,
    attachmentChips(refFiles.map((f) => ({ kind: 'text', ...f })), (i) => save({ refFiles: refFiles.filter((_, k) => k !== i) })),
    images.length || refFiles.length ? h('button', { class: 'btn btn-xs btn-out', onclick: () => save({ images: [], refFiles: [] }) }, '🗑️ Xóa hết đính kèm') : null);
}

function renderNotices() {
  const box = $('#notice-area');
  const items = [];
  const st = app.state;
  if (st.dbFallback) items.push(h('div', { class: 'error-box small' }, '❌ Không mở được IndexedDB (', st.dbFallback, '). Đang dùng bộ nhớ tạm — MỌI dữ liệu sẽ mất khi tải lại trang.'));
  if (st.persist && !st.persist.persisted) items.push(h('div', { class: 'warn-box small' }, '⚠ Trình duyệt CHƯA cấp quyền "lưu trữ bền" — dữ liệu có thể bị xóa khi máy thiếu dung lượng. Hãy sao lưu định kỳ.'));
  if (st.healthError) items.push(h('div', { class: 'error-box small' }, '❌ Không kết nối được proxy (/api/health): ', st.healthError));
  if (st.health?.accessTokenRequired && !app.getAccessToken()) items.push(h('div', { class: 'warn-box small' }, '🔒 Proxy yêu cầu ACCESS_TOKEN. ', h('button', { class: 'btn btn-xs btn-out', onclick: () => openSettings(app) }, 'Nhập trong Cài đặt')));
  if (st.vaultExists && !app.vault.isUnlocked) items.push(h('div', { class: 'info-box small' }, '🔐 Vault đang khóa — key trong trình duyệt chưa dùng được. ', h('button', { class: 'btn btn-xs btn-pri', onclick: () => openVaultDialog(app) }, 'Mở khóa')));
  if (app.vault.mode === 'memory') items.push(h('div', { class: 'warn-box small' }, '🧠 Key đang ở chế độ CHỈ RAM — tải lại trang là mất.'));
  const last = app.settings.get().lastBackupAt;
  if (st.project && (!last || Date.now() - last > 7 * 864e5)) items.push(h('div', { class: 'info-box small' }, `💾 ${last ? 'Đã hơn 7 ngày chưa sao lưu.' : 'Bạn chưa sao lưu dữ liệu lần nào.'} `, h('button', { class: 'btn btn-xs btn-out', onclick: () => openSettings(app) }, 'Sao lưu')));
  if (st.job?.status === 'interrupted') items.push(h('div', { class: 'warn-box small' }, '⚠ Pipeline trước bị gián đoạn (tab đã đóng). ', h('button', { class: 'btn btn-xs btn-pri', onclick: () => app.runner.resume() }, '▶ Tiếp tục')));
  mount(box, ...items);
}

function setBusy(label) {
  app.state.busy = label;
  const busy = !!label || !!app.runner?.running;
  $('#btn-generate').disabled = busy;
  $('#btn-diagram').disabled = busy;
  $('#btn-cancel').disabled = !busy;
  $('#btn-generate').textContent = label === 'architecture' ? '⏳ Đang tạo…' : '⚡ Tạo kiến trúc';
}

/* ---------- Thao tác riêng lẻ (ngoài pipeline) ---------- */
let soloCtl = null;
async function runArchitectureOnly() {
  if (app.runner.running || app.state.busy) return;
  const idea = $('#idea-input').value.trim();
  if (!idea) { toast('Vui lòng nhập ý tưởng!', 'err'); $('#idea-input').focus(); return; }
  await app.projects.updateWorkspace(app.state.project.id, { idea });
  soloCtl = new AbortController();
  setBusy('architecture');
  app.state.liveText = '';
  app.emit('project');
  window.addEventListener('beforeunload', onBeforeUnload);
  try {
    const r = await app.guard(() => generateArchitecture(app, {
      signal: soloCtl.signal,
      onDelta: (_d, full) => { app.state.liveText = full; app.emitFrame('stream'); },
      onEvent: (ev) => { if (ev.type === 'continue') toast(`Bị cắt — đang tự nối vòng ${ev.round + 1}/${ev.maxRounds}`, 'info'); if (ev.type === 'retry') toast(`Thử lại sau ${Math.round(ev.waitMs / 1000)}s: ${ev.reason}`, 'warn'); }
    }), 'Tạo kiến trúc');
    if (r && r !== true) {
      if (r.status === 'truncated') toast('Kiến trúc BỊ CẮT — chưa đầy đủ. Xem cảnh báo ở tab Claude.md.', 'err');
      else toast(`Đã tạo kiến trúc: ${r.parsed.skills.length} skill${r.warnings.length ? `, ${r.warnings.length} cảnh báo` : ''}.`, r.warnings.length ? 'warn' : 'ok');
    }
  } finally {
    window.removeEventListener('beforeunload', onBeforeUnload);
    soloCtl = null;
    app.state.liveText = '';
    setBusy(null);
    await app.reloadProject();
    selectTab('claude');
    app.emit('stats');
  }
}
async function runDiagramOnly() {
  if (app.runner.running || app.state.busy) return;
  await app.projects.updateWorkspace(app.state.project.id, { idea: $('#idea-input').value.trim() });
  soloCtl = new AbortController();
  setBusy('diagram');
  try {
    const r = await app.guard(() => generateDiagram(app, { signal: soloCtl.signal }), 'Tạo diagram');
    if (r && r !== true) { toast('Đã tạo diagram' + (r.warnings.length ? ` (${r.warnings.length} chỉnh sửa tự động)` : ''), 'ok'); selectTab('diagram'); }
  } finally { soloCtl = null; setBusy(null); app.emit('stats'); }
}
function onBeforeUnload(e) { e.preventDefault(); e.returnValue = 'Đang chạy — rời trang sẽ dừng.'; return e.returnValue; }

/* ---------- Theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#btn-theme');
  b.textContent = t === 'dark' ? '🌙 Dark' : '☀️ Light';
  b.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#09090d' : '#f4f4f8');
}

/* ---------- Wire DOM ---------- */
function wire() {
  $('#btn-projects').addEventListener('click', () => openProjects(app));
  $('#btn-vault').addEventListener('click', () => openVaultDialog(app));
  $('#btn-analyze').addEventListener('click', () => openAnalyze(app));
  $('#btn-workflow').addEventListener('click', () => openWorkflow(app));
  $('#btn-export').addEventListener('click', () => app.guard(() => openExport(app), 'Xuất'));
  $('#btn-contract-dl').addEventListener('click', () => downloadContract(app));
  $('#btn-cost').addEventListener('click', () => openCost(app));
  $('#btn-logs').addEventListener('click', () => openLogs(app));
  $('#btn-settings').addEventListener('click', () => openSettings(app));
  $('#btn-limits').addEventListener('click', () => openLimitations(app));
  $('#btn-limits-more').addEventListener('click', () => openLimitations(app));
  $('#btn-theme').addEventListener('click', async () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    await app.settings.update({ theme: t });
  });
  $('#btn-ping-all').addEventListener('click', async () => {
    const ids = Object.keys(app.state.providerMeta).filter((pid) => app.llm.hasKey(pid));
    if (!ids.length) { toast('Chưa có provider nào có key', 'err'); return; }
    for (const pid of ids) await app.actions.ping(pid);
  });
  $('#btn-models-all').addEventListener('click', async () => {
    const ids = Object.keys(app.state.providerMeta).filter((pid) => app.settings.get().activeProviders.includes(pid) && app.llm.hasKey(pid));
    if (!ids.length) { toast('Chưa có provider nào được bật và có key', 'warn'); return; }
    for (const pid of ids) await app.actions.loadModels(pid);
  });
  $('#btn-generate').addEventListener('click', runArchitectureOnly);
  $('#btn-diagram').addEventListener('click', runDiagramOnly);
  $('#btn-cancel').addEventListener('click', () => { if (soloCtl) soloCtl.abort(); if (app.runner.running) app.runner.cancel(); toast('Đã gửi yêu cầu hủy', 'info'); });
  $('#stream-toggle').addEventListener('change', (e) => app.settings.update({ streamByDefault: e.target.checked }));
  $('#btn-save-version').addEventListener('click', async () => {
    if (!app.state.project) return;
    const r = await app.guard(() => app.projects.createVersion(app.state.project.id, { reason: 'user' }), 'Lưu version');
    if (r && r !== true) toast(r.duplicate ? 'Không có thay đổi so với version gần nhất — không tạo bản trùng.' : 'Đã lưu version (bất biến).', r.duplicate ? 'info' : 'ok');
  });
  $('#btn-reset').addEventListener('click', async () => {
    if (!app.state.project) return;
    if (!(await confirmDialog({ title: 'Reset bản làm việc', message: 'Xóa kiến trúc, contract, file và kết quả của bản làm việc hiện tại? Các VERSION đã lưu và API key KHÔNG bị ảnh hưởng.', okText: 'Reset', danger: true }))) return;
    await app.guard(async () => {
      await app.projects.clearFiles(app.state.project.id);
      await app.projects.updateWorkspace(app.state.project.id, { claudeMd: '', diagram: '', diagramSvg: '', skills: [], contract: null, contractText: '', contractValidation: null, seed: null, seedValidation: null, readme: '', readmeState: null, review: null, validation: null, fixProposals: [], parseWarnings: [], archMeta: null });
      await app.db.deleteWhere('jobs', { index: 'projectId', query: app.state.project.id });
      app.state.job = null;
      await app.reloadProject();
      app.emit('pipeline');
    }, 'Reset');
    toast('Đã reset bản làm việc', 'ok');
  });

  const nameInp = $('#project-name');
  nameInp.addEventListener('change', async () => { if (app.state.project) { await app.projects.rename(app.state.project.id, nameInp.value); await app.reloadProject(); } });
  $('#platform-select').addEventListener('change', async (e) => {
    const p = app.state.project;
    if (!p) return;
    const hasCode = Object.values(app.state.files).some((f) => f.origin === 'ai');
    if (hasCode && !(await confirmDialog({ title: 'Đổi nền tảng', message: 'Đổi nền tảng sẽ đổi danh sách file cố định. File đã sinh sẽ bị đánh dấu "Cũ" và Contract cần sinh lại. Tiếp tục?', okText: 'Đổi' }))) { e.target.value = p.platform; return; }
    await app.projects.updateMeta(p.id, { platform: e.target.value, fileList: null });
    await app.projects.updateWorkspace(p.id, { contractStale: !!p.workspace.contract });
    await app.projects.markStale(p.id, 'Nền tảng đã đổi');
    // file không còn trong danh sách mới: xóa bản nháp
    for (const [path, f] of Object.entries(app.state.files)) if (!filePaths(e.target.value).includes(path) && f.origin === 'stub') await app.projects.deleteFile(p.id, path);
    await app.reloadProject();
  });
  $('#lang-select').addEventListener('change', async (e) => { if (app.state.project) { await app.projects.updateMeta(app.state.project.id, { outputLang: e.target.value }); await app.reloadProject(); } });
  $('#template-select').addEventListener('change', async (e) => {
    const t = IDEA_TEMPLATES[e.target.value];
    if (!t) return;
    $('#idea-input').value = t.text;
    await app.projects.updateWorkspace(app.state.project.id, { idea: t.text });
    toast('Đã nạp mẫu: ' + t.name, 'ok');
  });
  let ideaTimer = null;
  $('#idea-input').addEventListener('input', (e) => {
    clearTimeout(ideaTimer);
    ideaTimer = setTimeout(() => { if (app.state.project) app.projects.updateWorkspace(app.state.project.id, { idea: e.target.value }).catch((err) => app.logger.error('ui', 'Lưu ý tưởng lỗi: ' + err.message)); }, 600);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement?.id === 'idea-input') { e.preventDefault(); runArchitectureOnly(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); app.guard(() => openExport(app), 'Xuất'); }
  });
  // Gia hạn auto-lock vault khi người dùng thao tác
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => app.vault?.touch(), { passive: true });
}

/* ---------- Khởi động ---------- */
async function init() {
  wire();
  const { db, fallback, error } = await openBestDB();
  app.db = db;
  if (fallback) app.state.dbFallback = error?.message || 'lỗi không rõ';
  app.logger = createLogger({ db });
  if (fallback) await app.logger.error('db', 'Không mở được IndexedDB, dùng bộ nhớ tạm: ' + app.state.dbFallback);
  window.addEventListener('error', (e) => app.logger.error('runtime', e.message || 'Lỗi JS', { file: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => app.logger.error('runtime', 'Promise lỗi không xử lý: ' + (e.reason?.message || e.reason)));

  app.settings = createSettingsStore({ db });
  await app.settings.load();
  applyTheme(app.settings.get().theme || 'dark');

  try {
    app.vault = createVault({ db });
  } catch (e) {
    await app.logger.error('vault', e.message);
    toast(e.message, 'err');
    app.vault = { isUnlocked: false, mode: 'none', touch() {}, onChange() { return () => {}; }, getSecrets() { throw e; }, status: async () => ({ exists: false, unlocked: false, mode: 'none' }), setAutoLockMinutes() {} };
  }
  app.vault.setAutoLockMinutes(app.settings.get().vaultAutoLockMinutes);
  app.vault.onChange((ev) => {
    if (ev.type === 'lock') { toast(ev.reason === 'auto' ? '🔒 Vault tự khóa do không thao tác' : '🔒 Đã khóa vault', 'info'); }
    app.vault.status().then((s) => { app.state.vaultExists = s.exists; app.emit('notices'); }).catch((err) => app.logger.error('vault', err.message));
    app.emit('providers'); app.emit('models'); app.emit('stats');
  });
  app.keyring = createKeyring({ vault: app.vault });

  app.llm = null;
  app.budget = createBudget({ db, getSettings: () => app.settings.get(), getProviderPricing: () => app.llm?.getProviderPricing() || {}, confirm: confirmBudget });
  app.llm = createLLMClient({
    db, settings: app.settings, keyring: app.keyring, budget: app.budget, logger: app.logger,
    getAccessToken: app.getAccessToken,
    getServerKeyCount: (pid) => app.state.providerMeta[pid]?.serverKeyCount || 0,
    confirmFallback
  });
  app.budget.onChange(() => app.emit('stats'));
  app.projects = createProjectStore({ db });
  app.runner = createPipelineRunner(app);

  // Lắng nghe render
  app.on('providers', () => renderProviders(app, $('#providers-list')));
  app.on('models', () => { renderProviders(app, $('#providers-list')); });
  app.on('stats', () => renderStats(app, $('#stats-bar')).catch((e) => app.logger.error('ui', 'Thống kê lỗi: ' + e.message)));
  app.on('notices', renderNotices);
  app.on('project', () => { renderConfig(); renderWorkspace(app, $('#workspace')); renderPipelinePanel(app, $('#pipeline-panel')); renderNotices(); app.emit('stats'); });
  app.on('pipeline', () => { renderPipelinePanel(app, $('#pipeline-panel')); setBusy(app.state.busy); renderNotices(); app.emitFrame('workspace'); });
  app.on('workspace', () => renderWorkspace(app, $('#workspace')));
  app.on('stream', () => { if (!paintLive(app)) renderWorkspace(app, $('#workspace')); });
  app.on('roles', () => app.emit('models'));
  app.on('settings', () => { app.vault.setAutoLockMinutes(app.settings.get().vaultAutoLockMinutes); app.emit('stats'); });

  mount($('#providers-list'), h('div', { class: 'loading-line' }, h('span', { class: 'spinner' }), 'Đang kết nối proxy…'));

  // Lưu trữ bền
  try {
    app.state.persist = await requestPersistentStorage();
    if (app.state.persist.supported) {
      await app.logger.info('storage', `navigator.storage.persist(): ${app.state.persist.persisted ? 'ĐƯỢC cấp' : 'BỊ TỪ CHỐI'}`, { usage: app.state.persist.usage, quota: app.state.persist.quota });
      toast(app.state.persist.persisted ? '💾 Trình duyệt đã cấp quyền lưu trữ bền.' : '⚠ Trình duyệt chưa cấp quyền lưu trữ bền — nhớ sao lưu định kỳ.', app.state.persist.persisted ? 'ok' : 'warn');
    } else {
      app.state.persist = { supported: false, persisted: false };
      toast('Trình duyệt không hỗ trợ yêu cầu lưu trữ bền — nhớ sao lưu định kỳ.', 'warn');
    }
  } catch (e) {
    await app.logger.error('storage', 'persist() lỗi: ' + e.message);
  }

  // Proxy health
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    app.state.health = await r.json();
    for (const m of app.state.health.providers) app.state.providerMeta[m.id] = m;
    $('#app-version').textContent = 'v' + app.state.health.version;
    // Lần đầu (chưa bật provider nào): tự bật provider đã có key trong server/.env.
    const withServerKey = app.state.health.providers.filter((m) => m.serverKeyCount > 0).map((m) => m.id);
    if (!app.settings.get().activeProviders.length && withServerKey.length) {
      await app.settings.update({ activeProviders: withServerKey });
      await app.logger.info('providers', 'Tự bật provider có key server: ' + withServerKey.join(', '));
    }
  } catch (e) {
    app.state.healthError = e.message;
    await app.logger.error('proxy', 'Không gọi được /api/health: ' + e.message);
  }

  for (const row of await app.llm.restoreModelCache()) app.state.modelCache[row.providerId] = row;
  app.state.vaultExists = (await app.vault.status()).exists;

  const interrupted = await app.runner.pipeline.markInterrupted();
  if (interrupted) toast(`${interrupted} pipeline bị gián đoạn lần trước (tab đã đóng). Mở dự án và bấm "Tiếp tục".`, 'warn');

  const cur = app.settings.get().currentProjectId;
  try { await app.actions.openProject(cur || null); } catch (_e) { await app.actions.openProject(null); }

  renderModelRow();
  app.emit('providers');
  app.emit('stats');
  renderNotices();

  if (app.state.vaultExists && !app.vault.isUnlocked) openVaultDialog(app);

  // Service worker (PWA) — chỉ cache tài nguyên tĩnh
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => app.logger.warn('pwa', 'Không đăng ký được service worker: ' + e.message));
  }
  window.__app = { closeAllModals };
}

init().catch((e) => {
  console.error(e);
  const box = document.getElementById('notice-area');
  if (box) mount(box, h('div', { class: 'error-box' }, '❌ Khởi động thất bại: ' + e.message));
});
