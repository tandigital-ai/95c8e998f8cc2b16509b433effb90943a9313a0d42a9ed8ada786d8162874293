/**
 * attachments.js — Đọc tệp đính kèm: ảnh (thu nhỏ trước khi gửi), text/code, PDF (pdf.js), DOCX (mammoth).
 * Giới hạn rõ ràng và LUÔN báo khi nội dung bị cắt (bản GAS cắt im lặng 12.000/15.000 ký tự).
 * Có modal "Phân tích ảnh lỗi / tệp code" (port analyzeAttachments) trả hướng dẫn Tìm/Thay thế.
 */
import { h, mount, fmtBytes, rafThrottle } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { markdownView } from '../ui/markdownView.js';
import { loadMammoth, loadPdfJs } from '../ui/vendorLoader.js';
import { analyzeSystem, analyzeUser } from '../core/prompts.js';
import { modelFor, roleSelect } from './models.js';

export const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxTextChars: 120000,
  maxPdfPages: 100,
  maxImageSide: 1600,
  imageQuality: 0.85,
  maxImages: 8
});

export const TEXT_EXT = new Set(['gs', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'html', 'htm', 'css', 'scss', 'json', 'md', 'txt', 'csv', 'xml', 'yaml', 'yml', 'sql', 'php', 'dart', 'c', 'cpp', 'h', 'rb', 'go', 'rs', 'kt', 'swift', 'sh', 'bat', 'ini', 'env', 'vue', 'svelte', 'gradle', 'toml', 'log']);
export const ACCEPT = 'image/*,.pdf,.docx,' + [...TEXT_EXT].map((e) => '.' + e).join(',');

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();

function capText(text, name) {
  const t = String(text ?? '');
  if (t.length <= LIMITS.maxTextChars) return { content: t, truncated: false, originalChars: t.length };
  return { content: t.slice(0, LIMITS.maxTextChars), truncated: true, originalChars: t.length, note: `${name}: chỉ giữ ${LIMITS.maxTextChars.toLocaleString('vi-VN')}/${t.length.toLocaleString('vi-VN')} ký tự đầu.` };
}

/** Thu nhỏ ảnh bằng canvas (giữ tỉ lệ), xuất JPEG/PNG data URL. */
export async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS.maxImageSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, hgt);
  bmp.close?.();
  const png = file.type === 'image/png' && w * hgt < 600 * 600;
  const dataUrl = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', LIMITS.imageQuality);
  return { dataUrl, width: w, height: hgt, resized: scale < 1, originalSize: `${bmp.width}×${bmp.height}` };
}

async function readPdf(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(doc.numPages, LIMITS.maxPdfPages);
  let out = '';
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map((it) => it.str).join(' ') + '\n';
  }
  return { text: out, pagesRead: n, totalPages: doc.numPages };
}

async function readDocx(file) {
  const mammoth = await loadMammoth();
  const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { text: r.value || '', messages: (r.messages || []).map((m) => m.message) };
}

/**
 * Đọc 1 tệp. Trả { kind:'image'|'text', name, size, dataUrl?|content?, truncated, notes[] } hoặc ném lỗi rõ ràng.
 */
export async function readAttachment(file) {
  if (file.size > LIMITS.maxFileBytes) throw new Error(`${file.name}: ${fmtBytes(file.size)} vượt giới hạn ${fmtBytes(LIMITS.maxFileBytes)}.`);
  const ext = extOf(file.name);
  const notes = [];
  if (file.type.startsWith('image/')) {
    const r = await resizeImage(file);
    if (r.resized) notes.push(`Ảnh thu nhỏ từ ${r.originalSize} xuống ${r.width}×${r.height}.`);
    return { kind: 'image', name: file.name, size: file.size, dataUrl: r.dataUrl, truncated: false, notes };
  }
  let text;
  if (ext === 'pdf') {
    const r = await readPdf(file);
    text = r.text;
    if (r.pagesRead < r.totalPages) notes.push(`PDF: chỉ đọc ${r.pagesRead}/${r.totalPages} trang.`);
    if (!text.trim()) notes.push('PDF không có lớp chữ (có thể là ảnh scan) — không trích được văn bản.');
  } else if (ext === 'docx') {
    const r = await readDocx(file);
    text = r.text;
    if (r.messages.length) notes.push('DOCX: ' + r.messages.slice(0, 3).join('; '));
  } else if (TEXT_EXT.has(ext) || file.type.startsWith('text/')) {
    text = await file.text();
  } else {
    throw new Error(`${file.name}: định dạng .${ext} chưa hỗ trợ. Hãy lưu thành .txt/.md/.pdf/.docx hoặc dán nội dung.`);
  }
  const c = capText(text, file.name);
  if (c.truncated) notes.push(c.note);
  return { kind: 'text', name: file.name, size: file.size, content: c.content, truncated: c.truncated, notes };
}

/** Đọc nhiều tệp; lỗi từng tệp được trả về riêng, không làm hỏng cả lô. */
export async function readAttachments(files, logger) {
  const ok = [];
  const errors = [];
  for (const f of files) {
    try {
      ok.push(await readAttachment(f));
    } catch (e) {
      errors.push(e.message);
      await logger?.error('attachments', e.message, { name: f.name });
    }
  }
  return { ok, errors };
}

/** Ô kéo-thả + dán (Ctrl+V ảnh) + chọn tệp. */
export function dropZone({ label, accept = ACCEPT, multiple = true, onFiles }) {
  const input = h('input', { type: 'file', accept, multiple, class: 'hidden', 'aria-label': label });
  const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': label + ' (Enter để chọn tệp)' },
    label, h('div', { class: 'small' }, 'Kéo-thả, dán (Ctrl+V) hoặc bấm để chọn'), input);
  const fire = (list) => { const arr = [...(list || [])]; if (arr.length) onFiles(arr); };
  zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { fire(input.files); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); fire(e.dataTransfer?.files); });
  zone.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); fire(files); }
  });
  return zone;
}

/** Danh sách chip tệp đã nạp. */
export function attachmentChips(list, onRemove) {
  if (!list.length) return h('div', { class: 'small muted' }, 'Chưa có tệp.');
  return h('div', { class: 'row' }, ...list.map((a, i) => h('span', { class: 'chip', title: (a.notes || []).join('\n') },
    (a.kind === 'image' ? '🖼️ ' : '📄 ') + a.name + (a.kind === 'text' ? ` (${a.content.length.toLocaleString('vi-VN')} ký tự${a.truncated ? ', ĐÃ CẮT' : ''})` : ''),
    h('button', { class: 'icon-btn', 'aria-label': 'Bỏ ' + a.name, onclick: () => onRemove(i) }, '✕'))));
}

/* ------------------------------------------------------------------ */
/* Modal phân tích ảnh lỗi / tệp code                                  */
/* ------------------------------------------------------------------ */
export function openAnalyze(app) {
  const items = [];
  const listBox = h('div');
  const notesBox = h('div', { class: 'col' });
  const text = h('textarea', { class: 'ta', rows: '3', placeholder: 'Mô tả bạn cần gì (vd: App báo lỗi này khi bấm Lưu, chỉ cách sửa giúp tôi).', 'aria-label': 'Mô tả yêu cầu' });
  const out = h('div', { class: 'stream-box', 'aria-live': 'polite' }, 'Kết quả sẽ hiển thị ở đây…');
  let controller = null;

  const redraw = () => mount(listBox, attachmentChips(items, (i) => { items.splice(i, 1); redraw(); }));
  redraw();
  const zone = dropZone({
    label: '📎 Ảnh chụp lỗi (.png/.jpg) hoặc tệp code/tài liệu (.js/.gs/.html/.py/.pdf/.docx…)',
    onFiles: async (files) => {
      const r = await readAttachments(files, app.logger);
      items.push(...r.ok);
      redraw();
      mount(notesBox, ...r.ok.flatMap((a) => (a.notes || []).map((n) => h('div', { class: 'warn-box small' }, '⚠ ' + n))), ...r.errors.map((e) => h('div', { class: 'error-box small' }, '❌ ' + e)));
    }
  });

  const runBtn = h('button', { class: 'btn btn-pri' }, '▶️ Phân tích');
  const cancelBtn = h('button', { class: 'btn btn-out', disabled: true }, '⏹ Hủy');
  cancelBtn.addEventListener('click', () => controller?.abort());
  runBtn.addEventListener('click', async () => {
    if (!items.length && !text.value.trim()) { app.toast('Chọn tệp hoặc nhập mô tả!', 'err'); return; }
    let ref;
    try { ref = modelFor(app, 'analyze'); } catch (e) { app.toast(e.message, 'err'); return; }
    const images = items.filter((a) => a.kind === 'image');
    if (images.length > LIMITS.maxImages) { app.toast(`Tối đa ${LIMITS.maxImages} ảnh mỗi lần.`, 'err'); return; }
    const vision = app.llm.getModelMeta(ref.provider, ref.model)?.vision;
    if (images.length && vision === false) app.toast('Model này có vẻ KHÔNG đọc được ảnh (theo danh sách model). Kết quả có thể bỏ qua ảnh.', 'warn');
    controller = new AbortController();
    runBtn.disabled = true;
    cancelBtn.disabled = false;
    mount(out, h('span', { class: 'muted' }, '⏳ AI đang phân tích' + (images.length ? ' (đọc ảnh)' : '') + '…'));
    const lang = app.state.project?.outputLang || 'vi';
    const paint = rafThrottle((full) => mount(out, markdownView(full)));
    try {
      const r = await app.llm.complete({
        provider: ref.provider, model: ref.model, step: 'analyze', projectId: app.state.project?.id, noCache: true, signal: controller.signal,
        messages: [{ role: 'system', content: analyzeSystem({ platformId: app.state.project?.platform || 'gas', outputLang: lang }) },
          { role: 'user', content: analyzeUser({ userText: text.value.trim(), images, texts: items.filter((a) => a.kind === 'text'), outputLang: lang }) }],
        onDelta: (_d, full) => paint(full)
      });
      mount(out, markdownView(r.content || '(AI không trả nội dung)'), app.ui.callMeta(r));
    } catch (e) {
      await app.logger.error('analyze', e.message, { code: e.code });
      mount(out, h('div', { class: 'error-box' }, '❌ ' + e.message));
    } finally {
      runBtn.disabled = false;
      cancelBtn.disabled = true;
      controller = null;
    }
  });

  openModal({
    title: '🔎 Phân tích ảnh lỗi / tệp code (AI debug)', size: 'wide',
    body: h('div', { class: 'col' },
      h('div', { class: 'small muted' }, `Giới hạn: mỗi tệp ≤ ${fmtBytes(LIMITS.maxFileBytes)}, văn bản ≤ ${LIMITS.maxTextChars.toLocaleString('vi-VN')} ký tự/tệp, PDF ≤ ${LIMITS.maxPdfPages} trang, ảnh tự thu nhỏ còn cạnh dài ≤ ${LIMITS.maxImageSide}px. Ảnh chỉ đọc được khi model có "vision".`),
      roleSelect(app, 'analyze'),
      zone, listBox, notesBox, text, h('div', { class: 'row' }, runBtn, cancelBtn), out),
    onClose: () => controller?.abort()
  });
}
