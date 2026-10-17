/**
 * markdownView.js — Render markdown AN TOÀN: marked → DOMPurify → DOM.
 * Không bao giờ chèn output AI vào innerHTML khi chưa làm sạch.
 * Link mở tab mới với rel=noopener noreferrer; ảnh chỉ cho data:/blob:/same-origin (CSP chặn phần còn lại).
 */
import { marked } from '../../vendor/marked.esm.js';
import DOMPurify from '../../vendor/purify.es.mjs';
import { h } from './dom.js';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'script'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  ALLOW_DATA_ATTR: false
};

/** Chuỗi HTML đã làm sạch (dùng nội bộ). */
export function renderMarkdownToHtml(md) {
  const raw = marked.parse(String(md ?? ''), { async: false });
  return DOMPurify.sanitize(raw, PURIFY_CFG);
}

/** Node chứa markdown đã làm sạch. */
export function markdownView(md) {
  const el = h('div', { class: 'md' });
  // Đây là chỗ DUY NHẤT gán innerHTML cho nội dung AI — và luôn qua DOMPurify.
  el.innerHTML = renderMarkdownToHtml(md);
  return el;
}

/** Làm sạch SVG (Mermaid) trước khi chèn. */
export function sanitizeSvg(svg) {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], FORBID_TAGS: ['script'], FORBID_ATTR: ['onerror', 'onload', 'onclick'] });
}

export { DOMPurify };
