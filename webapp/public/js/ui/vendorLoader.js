/**
 * vendorLoader.js — Nạp lười thư viện tự host (cùng origin ⇒ hợp lệ với CSP script-src 'self').
 * Thư viện nặng (mermaid ~5MB, pdf.js, mammoth) chỉ tải khi cần.
 */
const loaded = new Map();

function loadScript(src, globalName) {
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((resolve, reject) => {
    if (globalName && globalThis[globalName]) { resolve(globalThis[globalName]); return; }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      const g = globalName ? globalThis[globalName] : true;
      if (globalName && !g) reject(new Error(`Đã tải ${src} nhưng không thấy ${globalName}.`));
      else resolve(g);
    };
    s.onerror = () => { loaded.delete(src); reject(new Error(`Không tải được thư viện ${src} (kiểm tra thư mục public/vendor).`)); };
    document.head.appendChild(s);
  });
  loaded.set(src, p);
  return p;
}

export const loadJSZip = () => loadScript('/vendor/jszip.min.js', 'JSZip');
export const loadFileSaver = () => loadScript('/vendor/FileSaver.min.js', 'saveAs');
export const loadMammoth = () => loadScript('/vendor/mammoth.browser.min.js', 'mammoth');

let mermaidReady = null;
export function loadMermaid(theme = 'dark') {
  if (!mermaidReady) {
    mermaidReady = loadScript('/vendor/mermaid.min.js', 'mermaid');
  }
  return mermaidReady.then((m) => {
    m.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
      flowchart: { htmlLabels: false, useMaxWidth: true, nodeSpacing: 50, rankSpacing: 60, curve: 'basis', padding: 10 }
    });
    return m;
  });
}

let pdfjsReady = null;
export function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = import('../../vendor/pdfjs/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return mod;
    }).catch((e) => { pdfjsReady = null; throw new Error('Không tải được pdf.js: ' + e.message); });
  }
  return pdfjsReady;
}
