/**
 * diagram.js — Sinh diagram độc lập (port generateDiagram + prompt V3.2), render Mermaid an toàn
 * (securityLevel strict, render trong iframe sandbox /mermaid-frame.html, SVG làm sạch bằng DOMPurify,
 * hiển thị qua <img src=blob:> để CSP trang chính không cần 'unsafe-inline'), editor sửa tay + render lại, xuất SVG/PNG, modal Workflow.
 */
import { h, mount, copyButton } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { sanitizeMermaid, workflowDiagram } from '../core/mermaidSanitize.js';
import { diagramSystem, diagramUser } from '../core/prompts.js';
import { downloadText, downloadBlob } from '../core/exporter.js';
import { modelFor } from './models.js';

let seq = 0;

/* Render Mermaid trong iframe sandbox ẩn (/mermaid-frame.html) — xem giải thích trong file đó.
 * Trang chính giữ CSP style-src 'self'; khung render có CSP riêng và origin mờ. */
let framePromise = null;
const pending = new Map();
const RENDER_TIMEOUT_MS = 20000;

function getRenderFrame() {
  if (framePromise) return framePromise;
  framePromise = new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.title = 'Mermaid renderer';
    iframe.className = 'mermaid-render-frame';
    const timer = setTimeout(() => { framePromise = null; iframe.remove(); reject(new Error('Khung render Mermaid không phản hồi')); }, RENDER_TIMEOUT_MS);
    window.addEventListener('message', (ev) => {
      if (ev.source !== iframe.contentWindow) return;
      const d = ev.data || {};
      if (d.type === 'mmd-ready') { clearTimeout(timer); resolve(iframe); return; }
      if (d.type === 'mmd-result' && pending.has(d.id)) {
        const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
        if (d.ok) p.resolve(d.svg); else p.reject(new Error(d.error || 'Mermaid lỗi'));
      }
    });
    iframe.src = '/mermaid-frame.html';
    document.body.appendChild(iframe);
  });
  return framePromise;
}

/** Render Mermaid → chuỗi SVG đã làm sạch, hoặc ném lỗi cú pháp. */
export async function renderMermaidSvg(code, theme) {
  const iframe = await getRenderFrame();
  const id = 'r' + Date.now() + '_' + seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Render Mermaid quá thời gian')); }, RENDER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    iframe.contentWindow.postMessage({ type: 'mmd-render', id, code, theme: theme === 'dark' ? 'dark' : 'light' }, '*');
  });
}

/** Hiển thị SVG qua blob URL trong <img> (không chèn SVG vào DOM ⇒ không cần style inline). */
function svgImage(svg, alt) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const img = h('img', { src: url, alt });
  img.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(url), 30000), { once: true });
  return img;
}

async function svgToPng(svg, scale = 2) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Không vẽ được SVG thành ảnh')); img.src = url; });
    const w = Math.max(1, Math.round((img.naturalWidth || 1200) * scale));
    const hh = Math.max(1, Math.round((img.naturalHeight || 800) * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hh);
    ctx.drawImage(img, 0, 0, w, hh);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Không tạo được PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Khung diagram: render + lỗi ⇒ editor sửa tay. onSave(code, svg) lưu lại.
 */
export function diagramView(app, { code, onSave = null, title = 'diagram' }) {
  const box = h('div', { class: 'diagram-box', 'aria-live': 'polite' }, h('div', { class: 'loading-line' }, h('span', { class: 'spinner' }), 'Đang render diagram…'));
  const editor = h('textarea', { class: 'ta mono', rows: '10', 'aria-label': 'Mã Mermaid' });
  editor.value = code || '';
  const status = h('div', { class: 'small' });
  let lastSvg = '';
  const editorWrap = h('details', { class: 'mt-8' }, h('summary', { class: 'small' }, '✏️ Sửa mã Mermaid'), editor,
    h('div', { class: 'row mt-8' },
      h('button', { class: 'btn btn-sm btn-pri', onclick: () => render(editor.value, true) }, '🔁 Render lại'),
      h('button', { class: 'btn btn-sm btn-out', onclick: () => { const r = sanitizeMermaid(editor.value); editor.value = r.code; render(r.code, true); if (r.warnings.length) app.toast(r.warnings.join('\n'), 'info'); } }, '🧹 Tự làm sạch & render')));

  async function render(src, save) {
    mount(box, h('div', { class: 'loading-line' }, h('span', { class: 'spinner' }), 'Đang render…'));
    try {
      const svg = await renderMermaidSvg(src, document.documentElement.dataset.theme);
      lastSvg = svg;
      mount(box, svgImage(svg, 'Sơ đồ ' + title));
      mount(status, h('span', { class: 'text-ok' }, '✔ Mermaid hợp lệ'));
      if (save && onSave) await onSave(src, svg);
    } catch (e) {
      lastSvg = '';
      await app.logger.warn('diagram', 'Mermaid lỗi cú pháp: ' + (e?.message || e), { projectId: app.state.project?.id });
      mount(box, h('div', { class: 'error-box' }, '⚠ Mermaid lỗi cú pháp: ', String(e?.message || e).slice(0, 400)), h('pre', { class: 'code-block mt-8' }, src));
      mount(status, h('span', { class: 'text-err' }, 'Sửa mã bên dưới rồi bấm "Render lại", hoặc "Tự làm sạch".'));
      editorWrap.open = true;
      if (save && onSave) await onSave(src, '');
    }
  }
  render(code, false);
  const toolbar = h('div', { class: 'row' },
    copyButton(() => editor.value, app.toast),
    h('button', { class: 'btn btn-xs btn-out', onclick: () => downloadText(`${title}.mmd`, editor.value) }, '💾 .mmd'),
    h('button', { class: 'btn btn-xs btn-out', onclick: () => (lastSvg ? downloadText(`${title}.svg`, lastSvg, 'image/svg+xml') : app.toast('Chưa render được SVG', 'err')) }, '🖼️ SVG'),
    h('button', {
      class: 'btn btn-xs btn-out',
      onclick: async () => {
        if (!lastSvg) { app.toast('Chưa render được SVG', 'err'); return; }
        const b = await app.guard(() => svgToPng(lastSvg), 'Xuất PNG');
        if (b) downloadBlob(`${title}.png`, b);
      }
    }, '🖼️ PNG'));
  return h('div', { class: 'col' }, toolbar, box, status, editorWrap);
}

/** Sinh diagram nghiệp vụ độc lập (nút "📊 Diagram"). */
export async function generateDiagram(app, { signal } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  if (!w.claudeMd && !w.idea?.trim()) throw new Error('Hãy nhập ý tưởng hoặc tạo kiến trúc trước.');
  const ref = modelFor(app, 'diagram');
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'diagram', projectId: p.id, noCache: false, signal, maxTokens: 4000,
    messages: [{ role: 'system', content: diagramSystem({ platformId: p.platform, outputLang: p.outputLang }) },
      { role: 'user', content: diagramUser({ claudeMd: w.claudeMd, idea: w.idea, skills: w.skills, outputLang: p.outputLang }) }]
  });
  if (r.truncated) throw new Error('Diagram bị cắt (finish_reason=length) — không lưu. Thử model khác hoặc tăng max_tokens.');
  const s = sanitizeMermaid(r.content);
  await app.projects.updateWorkspace(p.id, { diagram: s.code, diagramSvg: '' });
  await app.reloadProject();
  return { ...s, result: r };
}

export function openWorkflow(app) {
  const skills = app.state.project?.workspace?.skills || [];
  openModal({
    title: '🔄 Workflow — luồng các BOT (đầu vào → đầu ra)', size: 'wide',
    body: h('div', { class: 'col' },
      diagramView(app, { code: workflowDiagram(skills), title: 'workflow' }),
      h('div', { class: 'small muted' }, skills.length ? `Trạng thái: đã có kiến trúc với ${skills.length} BOT.` : 'Chưa tạo kiến trúc — đây là luồng mẫu.'))
  });
}
