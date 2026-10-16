/**
 * history.js — Danh sách dự án (phân trang, tìm kiếm, ghim, đổi tên, nhân bản, xóa) và
 * VERSION bất biến (xem, so sánh 2 version theo file, khôi phục NGUYÊN VẸN có kiểm tra băm, ghim, nhãn).
 */
import { h, mount, fmtTime, fmtInt, loadingView, emptyView, errorView } from '../ui/dom.js';
import { openModal, confirmDialog, promptDialog } from '../ui/modal.js';
import { diffFileSets, diffHunks } from '../core/diff.js';
import { formatUsd } from '../core/budget.js';
import { getPlatform } from '../core/platforms.js';

const PAGE = 15;

export function openProjects(app) {
  let offset = 0;
  let search = '';
  const listBox = h('div', { class: 'col' });
  const pager = h('div', { class: 'row-between mt-8' });
  const q = h('input', { class: 'inp', type: 'search', placeholder: 'Tìm theo tên/ý tưởng…', 'aria-label': 'Tìm dự án' });
  q.addEventListener('input', () => { search = q.value.trim(); offset = 0; load(); });

  async function load() {
    mount(listBox, loadingView());
    try {
      const { total, items } = await app.projects.list({ limit: PAGE, offset, search });
      if (!total) { mount(listBox, emptyView('📭', search ? 'Không tìm thấy dự án' : 'Chưa có dự án nào', 'Tạo dự án mới và chạy pipeline — version sẽ được lưu khi hoàn tất.')); mount(pager); return; }
      mount(listBox, ...items.map((p) => projectRow(app, p, load, m)));
      mount(pager,
        h('span', { class: 'small muted' }, `${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-xs btn-out', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); load(); } }, '← Trước'),
          h('button', { class: 'btn btn-xs btn-out', disabled: offset + PAGE >= total, onclick: () => { offset += PAGE; load(); } }, 'Sau →')));
    } catch (e) {
      await app.logger.error('history', e.message);
      mount(listBox, errorView(e.message, load));
    }
  }
  const m = openModal({
    title: '📜 Dự án & lịch sử', size: 'wide',
    body: h('div', { class: 'col' }, h('div', { class: 'row' }, q, h('button', { class: 'btn btn-pri', onclick: async () => { const p = await app.actions.newProject(); if (p) m.close(); } }, '➕ Dự án mới')), listBox, pager)
  });
  load();
}

function projectRow(app, p, reload, modal) {
  const isCurrent = app.state.project?.id === p.id;
  const nVer = Object.keys(p.versionMeta || {}).length;
  return h('article', { class: ['card', isCurrent ? 'pv-card active' : ''] },
    h('div', { class: 'row-between' },
      h('div', { class: 'grow' },
        h('div', { class: 'row' }, p.pinned ? h('span', { title: 'Đã ghim' }, '📌') : null, h('b', { class: 'break' }, p.name), isCurrent ? h('span', { class: 'badge badge-pri' }, 'đang mở') : null),
        h('div', { class: 'small muted break' }, (p.workspace?.idea || '(chưa có ý tưởng)').slice(0, 160)),
        h('div', { class: 'small muted' }, `${getPlatform(p.platform).name} · cập nhật ${fmtTime(p.updatedAt)} · ${nVer} version · ${(p.workspace?.skills || []).length} skill`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-xs btn-pri', disabled: isCurrent, onclick: async () => { await app.actions.openProject(p.id); modal.close(); } }, 'Mở'),
        h('button', { class: 'btn btn-xs btn-out', onclick: () => openVersions(app, p.id) }, `🕘 Version (${nVer})`),
        h('button', { class: 'btn btn-xs btn-out', 'aria-label': p.pinned ? 'Bỏ ghim' : 'Ghim', onclick: async () => { await app.projects.setPinned(p.id, !p.pinned); reload(); } }, p.pinned ? 'Bỏ ghim' : '📌'),
        h('button', { class: 'btn btn-xs btn-out', onclick: async () => { const n = await promptDialog({ title: 'Đổi tên dự án', label: 'Tên mới', value: p.name }); if (n) { await app.projects.rename(p.id, n); if (isCurrent) await app.reloadProject(); reload(); } } }, '✏️'),
        h('button', { class: 'btn btn-xs btn-out', title: 'Nhân bản', onclick: async () => { await app.guard(() => app.projects.duplicate(p.id), 'Nhân bản'); app.toast('Đã nhân bản (không gồm version)', 'ok'); reload(); } }, '⧉'),
        h('button', {
          class: 'btn btn-xs btn-danger', 'aria-label': 'Xóa dự án',
          onclick: async () => {
            if (!(await confirmDialog({ title: 'Xóa dự án', message: `Xóa VĨNH VIỄN "${p.name}" cùng mọi file và ${nVer} version?`, okText: 'Xóa', danger: true }))) return;
            await app.guard(() => app.projects.remove(p.id), 'Xóa dự án');
            if (isCurrent) await app.actions.openProject(null);
            reload();
          }
        }, '🗑️'))));
}

export function openVersions(app, projectId) {
  const body = h('div', { class: 'col' }, loadingView());
  const m = openModal({ title: '🕘 Version của dự án', body, size: 'wide' });
  const picked = new Set();

  async function load() {
    try {
      const p = await app.projects.getProject(projectId);
      const vs = await app.projects.listVersions(projectId);
      if (!vs.length) { mount(body, emptyView('🕘', 'Chưa có version', 'Version được tạo khi pipeline hoàn tất bước "Lưu version" hoặc khi bạn bấm "Lưu version" thủ công.')); return; }
      const cmpBtn = h('button', { class: 'btn btn-sm btn-pri', disabled: true, onclick: () => compare([...picked]) }, 'So sánh 2 version đã chọn');
      const rows = vs.map((v) => {
        const meta = p.versionMeta?.[v.id] || {};
        const cb = h('input', { type: 'checkbox', 'aria-label': 'Chọn để so sánh' });
        cb.addEventListener('change', () => { if (cb.checked) picked.add(v.id); else picked.delete(v.id); cmpBtn.disabled = picked.size !== 2; });
        const files = Object.values(v.snapshot.files);
        return h('div', { class: 'card' },
          h('div', { class: 'row-between' },
            h('label', { class: 'check' }, cb, h('b', null, meta.label || fmtTime(v.createdAt)), meta.pinned ? ' 📌' : '', v.id === p.headVersionId ? h('span', { class: 'badge badge-pri' }, 'mới nhất') : null),
            h('div', { class: 'row' },
              h('button', { class: 'btn btn-xs btn-out', onclick: () => viewVersion(app, v) }, '👁 Xem'),
              h('button', {
                class: 'btn btn-xs btn-pri',
                onclick: async () => {
                  if (!(await confirmDialog({ title: 'Khôi phục version', message: 'Bản làm việc hiện tại sẽ bị THAY THẾ bằng version này (các version khác không đổi). Nên "Lưu version" trước nếu có thay đổi chưa lưu.', okText: 'Khôi phục' }))) return;
                  const r = await app.guard(() => app.projects.restoreVersion(projectId, v.id), 'Khôi phục');
                  if (!r) return;
                  if (app.state.project?.id !== projectId) await app.actions.openProject(projectId); else await app.reloadProject();
                  app.toast(r.verifiedAfter ? '✔ Đã khôi phục NGUYÊN VẸN (băm SHA-256 khớp)' : '⚠ Đã khôi phục nhưng băm sau khôi phục KHÔNG khớp — xem Logs', r.verifiedAfter ? 'ok' : 'err');
                  m.close();
                }
              }, '↩ Khôi phục'),
              h('button', { class: 'btn btn-xs btn-out', onclick: async () => { await app.projects.setVersionMeta(projectId, v.id, { pinned: !meta.pinned }); load(); } }, meta.pinned ? 'Bỏ ghim' : '📌 Ghim'),
              h('button', { class: 'btn btn-xs btn-out', onclick: async () => { const n = await promptDialog({ title: 'Nhãn version', label: 'Nhãn', value: meta.label || '' }); if (n !== null) { await app.projects.setVersionMeta(projectId, v.id, { label: n }); load(); } } }, '🏷'),
              h('button', {
                class: 'btn btn-xs btn-out',
                onclick: async () => {
                  const r = await app.projects.verifyVersion(v);
                  app.toast(r.ok ? '✔ Toàn vẹn: mọi băm SHA-256 khớp' : `✖ Hỏng: ${[...r.bad, ...r.missing].join(', ') || 'snapshot'}`, r.ok ? 'ok' : 'err');
                }
              }, '🔐 Kiểm băm'))),
          h('div', { class: 'small muted' }, `${fmtTime(v.createdAt)} · ${v.reason === 'pipeline' ? 'pipeline' : 'thủ công'} · ${files.length} file · ${files.filter((f) => f.truncated).length} bị cắt` +
            (v.usage ? ` · ${fmtInt(v.usage.inTokens + v.usage.outTokens)} token · ${formatUsd(v.usage.knownCostUsd)}${v.usage.unknownPriceCalls ? ` + ${v.usage.unknownPriceCalls} lượt không rõ giá` : ''}` : '')));
      });
      mount(body, h('div', { class: 'row-between' }, h('span', { class: 'small muted' }, `${vs.length} version · giữ tối đa ${app.settings.get().maxVersionsPerProject} (bản ghim không bị tự xóa)`), cmpBtn), ...rows);
    } catch (e) {
      await app.logger.error('history', e.message, { projectId });
      mount(body, errorView(e.message, load));
    }
  }

  async function compare([a, b]) {
    const va = await app.projects.getVersion(a);
    const vb = await app.projects.getVersion(b);
    const [older, newer] = va.createdAt <= vb.createdAt ? [va, vb] : [vb, va];
    const map = (v) => Object.fromEntries([
      ...Object.entries(v.snapshot.files).map(([k, f]) => [k, f.content]),
      ['docs/Claude.md', v.snapshot.workspace.claudeMd || ''],
      ['docs/contract.json', v.snapshot.workspace.contractText || ''],
      ['README.md', v.snapshot.workspace.readme || ''],
      ...(v.snapshot.workspace.skills || []).map((s) => [`docs/skills/${s.filename}.md`, s.content])
    ]);
    const res = diffFileSets(map(older), map(newer));
    const changed = res.filter((r) => r.status !== 'same');
    openModal({
      title: `So sánh ${fmtTime(older.createdAt)} → ${fmtTime(newer.createdAt)}`, size: 'wide',
      body: h('div', { class: 'col' },
        h('div', { class: 'small' }, `${changed.length} mục thay đổi / ${res.length}`),
        ...(changed.length ? changed.map((r) => h('details', null,
          h('summary', null, h('span', { class: 'mono' }, r.path), ' ', h('span', { class: r.status === 'added' ? 'text-ok' : r.status === 'removed' ? 'text-err' : 'text-warn' }, `${r.status} +${r.stats.added} −${r.stats.removed}`)),
          r.ops ? diffView(r.ops) : null)) : [h('div', { class: 'ok-box' }, 'Hai version giống hệt nhau.')]))
    });
  }
  load();
}

/** Khung diff (dùng chung cho review fix). */
export function diffView(ops, context = 3) {
  const hunks = diffHunks(ops, context);
  if (!hunks.length) return h('div', { class: 'small muted' }, 'Không có thay đổi.');
  const box = h('div', { class: 'diff', role: 'region', 'aria-label': 'Khác biệt' });
  hunks.forEach((hk, i) => {
    if (i > 0 || hk[0].a > 1) box.appendChild(h('div', { class: 'diff-gap' }, `@@ dòng ${hk[0].a ?? hk[0].b} @@`));
    for (const o of hk) box.appendChild(h('div', { class: ['diff-line', o.op === 'add' ? 'diff-add' : o.op === 'del' ? 'diff-del' : 'diff-ctx'] }, (o.op === 'add' ? '+ ' : o.op === 'del' ? '− ' : '  ') + o.text));
  });
  return box;
}

function viewVersion(app, v) {
  const files = Object.entries(v.snapshot.files);
  openModal({
    title: '👁 Version ' + fmtTime(v.createdAt), size: 'wide',
    body: h('div', { class: 'col' },
      h('div', { class: 'small muted' }, `SHA-256 snapshot: ${v.snapshotHash.slice(0, 16)}…`),
      ...files.map(([path, f]) => h('details', null, h('summary', null, h('span', { class: 'mono' }, path), ' ', h('span', { class: ['state', 'state-' + (f.state || 'draft')] }, f.state || 'draft'), h('span', { class: 'small muted' }, ` ${(f.content || '').length.toLocaleString('vi-VN')} ký tự`)),
        h('pre', { class: 'code-block nowrap' }, f.content))))
  });
}
