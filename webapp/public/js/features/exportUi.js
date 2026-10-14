/**
 * exportUi.js — Xuất dự án: ZIP chuẩn + manifest (SHA-256 + trạng thái kiểm tra thật),
 * hoặc ghi thẳng vào thư mục (File System Access API) nếu trình duyệt hỗ trợ.
 */
import { h } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { buildExportEntries, buildZipBlob, writeToDirectory, downloadBlob, downloadText, slugify } from '../core/exporter.js';
import { loadJSZip } from '../ui/vendorLoader.js';

export async function snapshotForExport(app) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const w = p.workspace;
  const out = {};
  for (const [path, f] of Object.entries(files)) out[path] = { content: f.content, state: f.state, truncated: f.truncated, checks: f.checks };
  return {
    project: p,
    snapshot: {
      claudeMd: w.claudeMd, skills: w.skills, diagram: w.diagram, diagramSvg: w.diagramSvg || '', contract: w.contract, contractText: w.contractText,
      contractValid: !!w.contractValidation?.valid, validation: w.validation ? { ...w.validation, review: w.review || null, contractValidation: w.contractValidation || null } : null,
      seed: w.seed, seedValid: !!w.seedValidation?.valid, readme: w.readme, readmeState: w.readmeState, files: out
    }
  };
}

export async function openExport(app) {
  if (!app.state.project) { app.toast('Chưa có dự án', 'err'); return; }
  const { project, snapshot } = await snapshotForExport(app);
  if (!snapshot.claudeMd && !Object.keys(snapshot.files).length) { app.toast('Chưa có nội dung để xuất — hãy tạo kiến trúc trước.', 'err'); return; }
  const banner = app.settings.get().authorBanner;
  const { entries, manifest, root } = await buildExportEntries({ project, snapshot, banner, versionId: project.headVersionId });
  const s = manifest.summary;
  const fsSupported = typeof window.showDirectoryPicker === 'function';
  const m = openModal({
    title: '📦 Xuất dự án', size: 'narrow',
    body: h('div', { class: 'col' },
      h('div', { class: 'small' }, `${entries.length} tệp, thư mục gốc "${root}/".`),
      h('ul', { class: 'small' },
        h('li', null, `${s.total} file mã nguồn: cú pháp đạt ${s.syntaxPass}, lỗi ${s.syntaxFail}, chưa kiểm tra ${s.syntaxUnchecked}`),
        h('li', null, `${s.consistencyChecked} file đã kiểm nhất quán · ${s.reviewed} file đã AI review`),
        s.truncated ? h('li', { class: 'text-err' }, `${s.truncated} file BỊ CẮT (TRUNCATED)`) : null,
        h('li', { class: 'muted' }, 'Không file nào được build/chạy thử thật (manifest ghi runtimeTested=false).')),
      banner?.enabled ? h('div', { class: 'info-box small' }, 'Banner tác giả sẽ được chèn (Cài đặt → Banner).') : null,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-pri',
          onclick: async () => {
            const JSZip = await app.guard(() => loadJSZip(), 'Tải JSZip');
            if (!JSZip) return;
            const blob = await app.guard(() => buildZipBlob({ JSZip, entries }), 'Tạo ZIP');
            if (!blob) return;
            downloadBlob(`${root}.zip`, blob);
            app.toast('Đã tạo ZIP', 'ok');
            m.close();
          }
        }, '⬇ Tải ZIP'),
        fsSupported ? h('button', {
          class: 'btn btn-out',
          onclick: async () => {
            let dir;
            try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e.name !== 'AbortError') app.toast('Không mở được thư mục: ' + e.message, 'err'); return; }
            const n = await app.guard(() => writeToDirectory(dir, entries), 'Ghi thư mục');
            if (n) { app.toast(`Đã ghi ${n} tệp vào thư mục`, 'ok'); m.close(); }
          }
        }, '📁 Ghi vào thư mục') : h('span', { class: 'small muted' }, 'Trình duyệt không hỗ trợ ghi thư mục ⇒ dùng ZIP.'),
        h('button', { class: 'btn btn-out', onclick: () => downloadText('manifest.json', JSON.stringify(manifest, null, 2), 'application/json') }, 'manifest.json')))
  });
}

export function downloadContract(app) {
  const w = app.state.project?.workspace;
  if (!w?.contractText) { app.toast('Chưa có Contract để tải.', 'err'); return; }
  downloadText(`${slugify(app.state.project.name)}_contract.json`, w.contractText, 'application/json');
}
