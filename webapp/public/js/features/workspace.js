/**
 * workspace.js — Khu kết quả: tab Claude.md / Skills / Diagram / Contract / từng file code /
 * README / Kiểm tra / Review & Fix / Dữ liệu mẫu. Nhãn trạng thái phản ánh BẰNG CHỨNG.
 */
import { h, mount, copyButton, emptyView } from '../ui/dom.js';
import { markdownView } from '../ui/markdownView.js';
import { createTabs } from '../ui/tabs.js';
import { STATE_LABELS } from '../core/projectStore.js';
import { downloadText } from '../core/exporter.js';
import { formatUsd } from '../core/budget.js';
import { diffLines, diffStats } from '../core/diff.js';
import { langOf } from '../core/platforms.js';
import { diagramView } from './diagram.js';
import { openPlayground } from './playground.js';
import { applyContractText } from './contractBuilder.js';
import { acceptFix, rejectFix, proposeFixes, runChecks, aiReview } from './review.js'; import { runTask } from '../ui/taskProgress.js';
import { downloadSeedJson, downloadSeedCsv } from './seed.js';
import { diffView } from './history.js';
import { upgradeBox, ledgerView } from './upgrade.js';

let tabs = null;

function toolbar(app, label, getText, filename, extra = []) {
  return h('div', { class: 'tab-toolbar' }, h('span', { class: 'tab-label' }, label),
    h('div', { class: 'row' }, copyButton(getText, app.toast), filename ? h('button', { class: 'btn btn-xs btn-out', onclick: () => downloadText(filename, getText()) }, '💾 Tải') : null, ...extra));
}

function stateBadge(state) {
  return h('span', { class: ['state', 'state-' + state] }, STATE_LABELS[state] || state);
}

/** Bảng kiểm tra trung thực cho 1 file. */
function checksTable(f) {
  const c = f.checks || {};
  const row = (name, v, notRun) => h('tr', null, h('td', null, name),
    h('td', null, !v ? h('span', { class: 'muted' }, notRun) : h('span', { class: v.status === 'pass' ? 'text-ok' : v.status === 'fail' ? 'text-err' : v.status === 'warn' ? 'text-warn' : 'muted' },
      { pass: '✔ đạt', fail: '✖ lỗi', warn: '⚠ cảnh báo', unchecked: '— chưa kiểm tra', 'not-applicable': '— không áp dụng' }[v.status] || v.status)),
    h('td', { class: 'small break' }, v ? (v.message || (v.errors !== undefined ? `${v.errors} lỗi, ${v.warnings} cảnh báo${v.method ? ` (${v.method === 'regex' ? 'heuristic regex' : 'AST'})` : ''}` : v.issues !== undefined ? `${v.issues} vấn đề` : '')) : ''));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
    h('tbody', null,
      row('Cú pháp', c.syntax, 'chưa chạy'),
      row('Nhất quán', c.consistency, 'chưa chạy'),
      row('AI review', c.review, 'chưa chạy'),
      h('tr', null, h('td', null, 'Chạy thử thật'), h('td', null, h('span', { class: 'muted' }, '— không làm được trong trình duyệt')), h('td', { class: 'small muted' }, 'Bạn cần tự build/chạy.')))));
}

function previewHtml(app, html) {
  const frame = h('iframe', { class: 'preview-frame', sandbox: 'allow-scripts', src: '/preview-frame.html', title: 'Xem trước HTML (sandbox)', referrerpolicy: 'no-referrer' });
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow || ev.data?.type !== 'ai-architect-preview-ready') return;
    frame.contentWindow.postMessage({ type: 'ai-architect-preview', html }, '*');
  };
  window.addEventListener('message', onMsg);
  const cleanup = new MutationObserver(() => { if (!frame.isConnected) { window.removeEventListener('message', onMsg); cleanup.disconnect(); } });
  cleanup.observe(document.body, { childList: true, subtree: true });
  return h('div', { class: 'col' },
    h('div', { class: 'small muted' }, 'Xem trước trong iframe sandbox (KHÔNG allow-same-origin, không mạng). File CSS/JS tách riêng và google.script.run không hoạt động ở đây — chỉ để xem bố cục.'),
    frame);
}

function codeTab(app, path, f) {
  const lang = langOf(path);
  const showPreview = { on: false };
  const body = h('div');
  const draw = () => mount(body, showPreview.on && lang === 'html' ? previewHtml(app, f.content) : h('pre', { class: 'code-block nowrap', tabindex: '0' }, f.content || ''));
  draw();
  const meta = f.meta || {};
  return h('div', { class: 'col' },
    toolbar(app, path, () => f.content || '', path.split('/').pop(), [
      lang === 'html' ? h('button', { class: 'btn btn-xs btn-out', onclick: () => { showPreview.on = !showPreview.on; draw(); } }, '👁 Xem trước / mã') : null,
      h('button', { class: 'btn btn-xs btn-pri', disabled: !!app.runner.running, onclick: () => app.runner.retryFile(path) }, '🔁 Sinh lại file này')
    ]),
    h('div', { class: 'row' }, stateBadge(f.state), f.truncated ? h('span', { class: 'badge badge-err' }, 'TRUNCATED — không dùng được như bản hoàn tất') : null,
      f.stale ? h('span', { class: 'badge badge-warn', title: f.staleReason || '' }, 'Cũ so với contract/kiến trúc') : null,
      meta.model ? h('span', { class: 'small muted' }, `${meta.provider}/${meta.model} · ${meta.rounds || 1} vòng · ${formatUsd(meta.cost)}${meta.cached ? ' · Cached' : ''}${meta.contractSliced ? ' · contract rút gọn' : ''}`) : null),
    f.origin === 'stub' ? h('div', { class: 'warn-box small' }, 'Đây là BẢN NHÁP do app tạo, chưa phải code. Chạy pipeline hoặc bấm "Sinh lại file này".') : checksTable(f),
    body);
}

function contractTab(app, w) {
  const v = w.contractValidation;
  const ta = h('textarea', { class: 'ta mono', rows: '22', 'aria-label': 'Contract JSON', spellcheck: 'false' });
  ta.value = w.contractText || '';
  return h('div', { class: 'col' },
    toolbar(app, 'Project Contract (nguồn sự thật chung)', () => ta.value, 'contract.json'),
    !v ? h('div', { class: 'small muted' }, 'Chưa kiểm tra.') : v.valid
      ? h('div', { class: 'ok-box small' }, `✔ Đạt schema (schemaVersion 1). ${v.warnings.length} cảnh báo.`, v.warnings.length ? h('ul', null, ...v.warnings.slice(0, 30).map((x) => h('li', null, `${x.path}: ${x.message}`))) : null)
      : h('div', { class: 'error-box small' }, `✖ KHÔNG đạt schema — pipeline sẽ DỪNG ở bước Contract. ${v.errors.length} lỗi:`, h('ul', null, ...v.errors.slice(0, 50).map((x) => h('li', null, `${x.path}: ${x.message}`)))),
    w.contractStale ? h('div', { class: 'warn-box small' }, 'Kiến trúc đã đổi sau khi tạo Contract — nên sinh lại Contract.') : null,
    ta,
    h('div', { class: 'row' },
      h('button', {
        class: 'btn btn-sm btn-pri',
        onclick: async () => {
          const r = await app.guard(() => applyContractText(app, app.state.project.id, ta.value, { source: 'user' }), 'Kiểm tra contract');
          if (r) app.toast(r.valid ? 'Contract hợp lệ — đã lưu.' : `Contract còn ${r.errors.length} lỗi (đã lưu bản nháp).`, r.valid ? 'ok' : 'err');
        }
      }, '✔ Kiểm tra & lưu bản sửa tay'),
      h('button', { class: 'btn btn-sm btn-out', disabled: !!app.runner.running, onclick: () => app.runner.runSingle('contract') }, '🔁 Sinh lại Contract bằng AI')));
}

function checksTab(app, w, files) {
  const v = w.validation;
  if (!v) return h('div', { class: 'col' }, emptyView('🔍', 'Chưa chạy kiểm tra'), h('button', { class: 'btn btn-pri', onclick: () => app.guard(() => runChecks(app), 'Kiểm tra') }, '▶ Chạy kiểm tra cú pháp + nhất quán'));
  const issues = v.issues || [];
  return h('div', { class: 'col' },
    h('div', { class: 'row-between' }, h('b', null, `Kiểm tra lúc ${new Date(v.at).toLocaleString('vi-VN')}`), h('button', { class: 'btn btn-sm btn-out', onclick: () => app.guard(() => runChecks(app), 'Kiểm tra') }, '🔁 Chạy lại')),
    h('div', { class: v.ok ? 'ok-box small' : 'error-box small' }, v.ok ? `Không phát hiện lỗi mức "error" trong các kiểm tra ĐÃ CHẠY. Cú pháp: ${v.syntaxSummary}. ${v.stats.warnings} cảnh báo.` : `${v.stats.errors} lỗi nhất quán · cú pháp: ${v.syntaxSummary} · ${v.stats.warnings} cảnh báo.`),
    h('div', { class: 'small muted' }, 'Phạm vi kiểm tra: ', Object.entries(v.coverage || {}).map(([k, c]) => `${k}: ${{ ast: 'AST', regex: 'regex (heuristic)', skipped: 'bỏ qua', failed: 'không phân tích được' }[c] || c}`).join(' · ')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Mức'), h('th', null, 'Loại'), h('th', null, 'File:dòng'), h('th', null, 'Mô tả'))),
      h('tbody', null, ...(issues.length ? issues.map((i) => h('tr', null,
        h('td', null, h('span', { class: ['badge', i.level === 'error' ? 'badge-err' : 'badge-warn'] }, i.level)),
        h('td', { class: 'mono small' }, i.type), h('td', { class: 'mono small' }, i.file ? `${i.file}${i.line ? ':' + i.line : ''}` : '—'), h('td', { class: 'small break' }, i.message)))
        : [h('tr', null, h('td', { colspan: '4', class: 'muted' }, 'Không có phát hiện.'))])))),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Cú pháp'), h('th', null, 'Chi tiết'))),
      h('tbody', null, ...Object.entries(v.syntax || {}).map(([p, s]) => h('tr', null, h('td', { class: 'mono small' }, p),
        h('td', null, h('span', { class: s.status === 'pass' ? 'text-ok' : s.status === 'fail' ? 'text-err' : 'muted' }, { pass: '✔ đạt', fail: '✖ lỗi', unchecked: '— chưa kiểm tra' }[s.status])),
        h('td', { class: 'small break' }, s.message)))))));
}

function reviewTab(app, w) {
  const r = w.review;
  const props = (w.fixProposals || []).filter((x) => x.status === 'pending');
  const done = (w.fixProposals || []).filter((x) => x.status !== 'pending');
  const parts = [];
  if (!r) parts.push(emptyView('🤖', 'Chưa có AI review', 'Chạy pipeline (bước AI Review) hoặc bấm nút bên dưới.'));
  else if (!r.ok) parts.push(h('div', { class: 'warn-box small' }, '⚠ Không đọc được kết quả review: ', r.parseError, ' — KHÔNG có nghĩa là "không có lỗi".', h('details', null, h('summary', null, 'Phản hồi thô'), h('pre', { class: 'code-block' }, r.raw || ''))));
  else parts.push(h('div', { class: 'small' }, `Review bởi ${r.model} lúc ${new Date(r.at).toLocaleString('vi-VN')}: ${r.issues.length} vấn đề.`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Mức'), h('th', null, 'Vấn đề'), h('th', null, 'Cách sửa'))),
      h('tbody', null, ...(r.issues.length ? r.issues.map((i) => h('tr', null, h('td', { class: 'mono small' }, i.file, i.known ? '' : ' (không có file này)'), h('td', null, h('span', { class: ['badge', i.severity === 'error' ? 'badge-err' : 'badge-warn'] }, i.severity)), h('td', { class: 'small break' }, i.problem), h('td', { class: 'small break' }, i.fix))) : [h('tr', null, h('td', { colspan: '4', class: 'muted' }, 'AI reviewer không báo vấn đề nào (đây là ý kiến của AI, không phải bằng chứng).'))])))));
  parts.push(h('div', { class: 'row' },
    h('button', { class: 'btn btn-sm btn-out', disabled: !!app.runner.running, onclick: () => runTask(app, '🤖 AI Review', (t) => aiReview(app, { signal: t.signal, track: t })).then(() => app.emit('workspace')) }, '🤖 Chạy AI review'),
    h('button', { class: 'btn btn-sm btn-out', disabled: !!app.runner.running, onclick: () => runTask(app, '🔧 Đề xuất sửa', (t) => proposeFixes(app, { signal: t.signal, track: t })).then(() => app.emit('workspace')) }, '🔧 Tạo đề xuất sửa')));
  parts.push(upgradeBox(app));
  if (props.length) {
    parts.push(h('h3', { class: 'section-title mt-12' }, `Đề xuất sửa chờ duyệt (${props.length}) — chỉ ghi đè khi bạn bấm "Chấp nhận"`));
    for (const p of props) {
      const ops = diffLines(p.before, p.after);
      const st = diffStats(ops);
      parts.push(h('div', { class: 'card' },
        h('div', { class: 'row-between' }, h('b', { class: 'mono' }, p.path, p.wo ? ' · ' + p.wo.id : ''), h('span', { class: 'small' }, `+${st.added} −${st.removed} · cú pháp sau sửa: ${{ pass: '✔ đạt', fail: '✖ LỖI', unchecked: 'chưa kiểm tra' }[p.syntax?.status] || '?'}`)),
        p.truncated ? h('div', { class: 'error-box small' }, 'Đề xuất BỊ CẮT — không thể chấp nhận.') : null,
        h('ul', { class: 'small' }, ...p.problems.map((x) => h('li', null, x))),
        diffView(ops),
        h('div', { class: 'row mt-8' },
          h('button', { class: 'btn btn-sm btn-suc', disabled: p.truncated, onclick: async () => { const ok = await app.guard(() => acceptFix(app, p.path), 'Chấp nhận sửa'); if (ok !== undefined) app.toast(`Đã áp dụng sửa cho ${p.path} và chạy lại kiểm tra`, 'ok'); } }, '✔ Chấp nhận'),
          h('button', { class: 'btn btn-sm btn-out', onclick: () => app.guard(() => rejectFix(app, p.path), 'Từ chối') }, '✖ Từ chối'))));
    }
  }
  if (done.length) parts.push(h('div', { class: 'small muted' }, `Đã xử lý: ${done.map((d) => `${d.path} (${d.status === 'accepted' ? 'chấp nhận' : 'từ chối'})`).join(', ')}`));
  return h('div', { class: 'col' }, ...parts);
}

function seedTab(app, w) {
  const v = w.seedValidation;
  return h('div', { class: 'col' },
    w.seed ? toolbar(app, 'Dữ liệu mẫu (theo dataSchema)', () => JSON.stringify(w.seed, null, 2), null, [
      h('button', { class: 'btn btn-xs btn-out', onclick: () => downloadSeedJson(w.seed, 'seed') }, '⬇ JSON'),
      h('button', { class: 'btn btn-xs btn-out', onclick: () => downloadSeedCsv(w.seed, w.contract, 'seed') }, '⬇ CSV (mỗi entity 1 file)')]) : emptyView('🌱', 'Chưa có dữ liệu mẫu'),
    v ? h('div', { class: v.valid ? 'ok-box small' : 'error-box small' }, v.valid ? '✔ Entity/field khớp Contract.' : '✖ Lệch Contract:', h('ul', null, ...[...(v.errors || []), ...(v.warnings || [])].slice(0, 40).map((x) => h('li', null, x)))) : null,
    w.seed?.note ? h('div', { class: 'info-box small' }, w.seed.note) : null,
    w.seed ? h('pre', { class: 'code-block' }, JSON.stringify(w.seed.seed, null, 2)) : null,
    h('button', { class: 'btn btn-sm btn-out', disabled: !w.contract || !!app.runner.running, onclick: () => app.runner.runSingle('seed') }, '🌱 Sinh dữ liệu mẫu'));
}

export function renderWorkspace(app, container) {
  const p = app.state.project;
  if (!p) { mount(container, emptyView('🏗️', 'Chưa mở dự án', 'Bấm "📜 Dự án" để tạo hoặc mở dự án.')); tabs = null; return; }
  const w = p.workspace;
  const files = app.state.files || {};
  if (!w.claudeMd && !Object.keys(files).length && !app.state.liveText) {
    mount(container, emptyView('🏗️', 'Sẵn sàng tạo kiến trúc', '① Thêm key (panel Providers) → ② Test Ping → ③ Chọn model Orchestrator → ④ Nhập ý tưởng → ⑤ Ctrl+Enter.'));
    tabs = null;
    return;
  }
  if (!tabs || !container.contains(tabs.panel)) tabs = createTabs(container);
  const items = [];
  if (app.state.liveText && app.runner.running) {
    items.push({ id: 'live', label: '⏳ Đang sinh…', render: () => { const box = h('div', { class: 'stream-box', id: 'live-stream', 'aria-live': 'off' }); box.textContent = app.state.liveText; return box; } });
  }
  items.push({
    id: 'claude', label: '📄 Claude.md', render: () => h('div', { class: 'col' },
      toolbar(app, 'Claude.md', () => w.claudeMd, 'Claude.md'),
      (w.parseWarnings || []).length ? h('div', { class: 'warn-box small' }, h('b', null, 'Cảnh báo khi đọc đầu ra AI:'), h('ul', null, ...w.parseWarnings.map((x) => h('li', null, x.message)))) : null,
      w.archMeta ? app.ui.callMeta({ ...w.archMeta, complete: !w.archMeta.truncated }) : null,
      w.claudeMd ? markdownView(w.claudeMd) : emptyView('📄', 'Chưa có Claude.md'))
  });
  (w.skills || []).forEach((s, i) => items.push({
    id: 'skill-' + i, label: '🤖 ' + s.filename, title: s.name,
    render: () => h('div', { class: 'col' }, toolbar(app, `${s.filename}.md — ${s.name}`, () => s.content, s.filename + '.md', [h('button', { class: 'btn btn-xs btn-pri', onclick: () => openPlayground(app, i) }, '🧪 Test skill')]),
      s.closed === false ? h('div', { class: 'warn-box small' }, 'Skill này thiếu marker kết thúc — có thể bị cắt.') : null, markdownView(s.content))
  }));
  if (w.diagram) items.push({ id: 'diagram', label: '📊 Diagram', render: () => diagramView(app, { code: w.diagram, title: 'diagram', onSave: (code, svg) => app.projects.updateWorkspace(p.id, { diagram: code, diagramSvg: svg }) }) });
  if (w.contractText || w.contractValidation) items.push({ id: 'contract', label: (w.contractValidation?.valid ? '📐 ' : '⛔ ') + 'Contract', render: () => contractTab(app, w) });
  for (const [path, f] of Object.entries(files)) items.push({ id: 'code-' + path, label: (f.truncated ? '✂ ' : f.state === 'draft' ? '📝 ' : f.state === 'stale' ? '⚠ ' : '📁 ') + path, title: STATE_LABELS[f.state], render: () => codeTab(app, path, app.state.files[path] || f) });
  if (w.readme) items.push({ id: 'readme', label: (w.readmeState === 'truncated' ? '✂ ' : '📖 ') + 'README.md', render: () => h('div', { class: 'col' }, toolbar(app, 'README.md' + (w.readmeState === 'truncated' ? ' — BỊ CẮT' : ''), () => w.readme, 'README.md', [h('button', { class: 'btn btn-xs btn-pri', disabled: !!app.runner.running, onclick: () => app.runner.runSingle('readme') }, '🔁 Sinh lại')]), markdownView(w.readme)) });
  if (Object.values(files).some((f) => f.origin === 'ai')) {
    items.push({ id: 'checks', label: '🔍 Kiểm tra', render: () => checksTab(app, w, files) });
    items.push({ id: 'review', label: '🤖 Review & Fix' + ((w.fixProposals || []).some((x) => x.status === 'pending') ? ' •' : ''), render: () => reviewTab(app, w) });
  }
  if (w.contract) items.push({ id: 'seed', label: '🌱 Dữ liệu mẫu', render: () => seedTab(app, w) }); if ((w.ledger || []).length) items.push({ id: 'ledger', label: '📒 Sổ cái', render: () => ledgerView(w.ledger) });
  const keep = tabs.active && items.some((x) => x.id === tabs.active) ? tabs.active : app.state.liveText && app.runner.running ? 'live' : 'claude';
  tabs.set(items, keep);
}

/** Cập nhật tab "đang sinh" theo khung hình (không render lại toàn bộ). */
export function paintLive(app) {
  const box = document.getElementById('live-stream');
  if (!box) return false;
  box.textContent = app.state.liveText;
  box.scrollTop = box.scrollHeight;
  return true;
}

export function selectTab(id) { tabs?.select(id); }
