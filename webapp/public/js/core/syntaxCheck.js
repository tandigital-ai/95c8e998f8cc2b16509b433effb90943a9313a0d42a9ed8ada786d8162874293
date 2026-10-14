/**
 * syntaxCheck.js — Kiểm tra CÚ PHÁP THẬT trong khả năng của trình duyệt.
 *  - .js/.mjs/.cjs/.gs : acorn (ecmaVersion latest). .gs thử script trước rồi module.
 *  - .json             : JSON.parse (báo dòng/cột).
 *  - .html             : kiểm tra thẻ đóng/mở cơ bản + cú pháp <script> nội tuyến bằng acorn.
 *                        (HTML vốn "dễ dãi" ⇒ ghi rõ là kiểm tra LỎNG.)
 *  - Ngôn ngữ khác     : status 'unchecked' — "chưa kiểm tra cú pháp". KHÔNG giả vờ OK.
 *
 * Kết quả: { status: 'pass'|'fail'|'unchecked'|'partial', checker, message, errors:[{line,column,message}] }
 */
import { langOf } from './platforms.js';

let acornMod = null;

/** Nạp acorn (tự host). Trong Node test có thể truyền module vào. */
export function setAcorn(mod) { acornMod = mod; }

async function getAcorn() {
  if (acornMod) return acornMod;
  acornMod = await import('../../vendor/acorn.mjs');
  return acornMod;
}

function parseJs(acorn, code, sourceType) {
  acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowAwaitOutsideFunction: sourceType === 'module', allowReturnOutsideFunction: false, locations: true });
}

function acornErr(e) {
  return { line: e.loc?.line ?? null, column: e.loc ? e.loc.column + 1 : null, message: String(e.message).replace(/\s*\(\d+:\d+\)$/, '') };
}

export async function checkJs(code, { lang = 'js' } = {}) {
  const acorn = await getAcorn();
  const first = lang === 'gs' ? 'script' : 'module';
  const second = first === 'module' ? 'script' : 'module';
  try {
    parseJs(acorn, code, first);
    return { status: 'pass', checker: `acorn (${first})`, message: 'Cú pháp hợp lệ', errors: [] };
  } catch (e1) {
    try {
      parseJs(acorn, code, second);
      return { status: 'pass', checker: `acorn (${second})`, message: 'Cú pháp hợp lệ', errors: [] };
    } catch (_e2) {
      const err = acornErr(e1);
      return { status: 'fail', checker: `acorn (${first})`, message: `Lỗi cú pháp dòng ${err.line}: ${err.message}`, errors: [err] };
    }
  }
}

export function checkJson(code) {
  try {
    JSON.parse(code);
    return { status: 'pass', checker: 'JSON.parse', message: 'JSON hợp lệ', errors: [] };
  } catch (e) {
    const msg = String(e.message);
    let line = null;
    let column = null;
    const pos = Number((msg.match(/position (\d+)/) || [])[1]);
    if (Number.isFinite(pos)) {
      const before = code.slice(0, pos);
      line = before.split('\n').length;
      column = pos - before.lastIndexOf('\n');
    } else {
      const lc = msg.match(/line (\d+) column (\d+)/);
      if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
    }
    return { status: 'fail', checker: 'JSON.parse', message: 'JSON không hợp lệ: ' + msg, errors: [{ line, column, message: msg }] };
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// Thẻ cho phép bỏ thẻ đóng theo chuẩn HTML
const OPTIONAL_CLOSE = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'option', 'optgroup', 'html', 'head', 'body', 'colgroup', 'caption', 'rt', 'rp']);

/** Kiểm tra cân bằng thẻ đơn giản (bỏ qua comment, nội dung script/style). Thuần, test được. */
export function checkHtmlTags(html) {
  const errors = [];
  const stack = [];
  const src = String(html).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const re = /<\/?([A-Za-z][\w:-]*|!doctype)\b[^>]*?(\/?)>/gi;
  let m;
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    const selfClose = m[2] === '/';
    if (!closing && RAW_TAGS.has(tag)) {
      const end = src.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      if (end < 0) { errors.push({ line: lineAt(m.index), column: null, message: `Thẻ <${tag}> không có thẻ đóng.` }); break; }
      re.lastIndex = end;
      stack.push({ tag, line: lineAt(m.index) });
      continue;
    }
    if (VOID_TAGS.has(tag) || selfClose) continue;
    if (!closing) { stack.push({ tag, line: lineAt(m.index) }); continue; }
    // closing
    let idx = stack.length - 1;
    while (idx >= 0 && stack[idx].tag !== tag) idx--;
    if (idx < 0) { errors.push({ line: lineAt(m.index), column: null, message: `Thẻ đóng </${tag}> không có thẻ mở tương ứng.` }); continue; }
    for (let k = stack.length - 1; k > idx; k--) {
      if (!OPTIONAL_CLOSE.has(stack[k].tag)) errors.push({ line: stack[k].line, column: null, message: `Thẻ <${stack[k].tag}> chưa được đóng trước </${tag}>.` });
    }
    stack.length = idx;
  }
  for (const s of stack) if (!OPTIONAL_CLOSE.has(s.tag)) errors.push({ line: s.line, column: null, message: `Thẻ <${s.tag}> chưa được đóng.` });
  return errors;
}

/** Trích các <script> nội tuyến (không src, không type lạ). */
export function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
    const line = String(html).slice(0, m.index).split('\n').length;
    out.push({ code: m[2], line, module: /^module$/i.test(type || '') });
  }
  return out;
}

export async function checkHtml(code) {
  // Không dùng DOMParser: không bao giờ báo lỗi HTML, và parse <style> trong trang chính vi phạm CSP.
  const errors = checkHtmlTags(code);
  // GAS template (<?= ?>) => bỏ qua phần script có scriptlet
  const scripts = extractInlineScripts(code).filter((s) => !/<\?/.test(s.code));
  for (const s of scripts) {
    const r = await checkJs(s.code, { lang: s.module ? 'js' : 'gs' });
    if (r.status === 'fail') for (const e of r.errors) errors.push({ line: e.line != null ? s.line + e.line - 1 : null, column: e.column, message: 'Trong <script>: ' + e.message });
  }
  if (errors.length) return { status: 'fail', checker: 'html-lỏng + acorn(script)', message: `${errors.length} vấn đề HTML/script`, errors };
  return { status: 'pass', checker: 'html-lỏng + acorn(script)', message: 'Cấu trúc thẻ cân bằng, script nội tuyến hợp lệ (kiểm tra LỎNG — HTML không có trình kiểm tra chặt trong trình duyệt)', errors: [] };
}

const UNCHECKED_LABEL = {
  ts: 'TypeScript', tsx: 'TypeScript/TSX', jsx: 'JSX', py: 'Python', dart: 'Dart', yaml: 'YAML', css: 'CSS', md: 'Markdown',
  txt: 'văn bản', env: '.env', docker: 'Dockerfile'
};

/**
 * Kiểm tra 1 file theo đuôi.
 * @returns {Promise<{status,checker,message,errors}>}
 */
export async function checkSyntax(path, code, opts = {}) {
  const lang = langOf(path);
  const text = String(code ?? '');
  if (!text.trim()) return { status: 'fail', checker: 'empty', message: 'File rỗng', errors: [{ line: null, column: null, message: 'File rỗng' }] };
  if (lang === 'js' || lang === 'gs') return checkJs(text, { lang });
  if (lang === 'json') return checkJson(text);
  if (lang === 'html') return checkHtml(text, opts);
  return { status: 'unchecked', checker: null, message: `Chưa kiểm tra cú pháp (${UNCHECKED_LABEL[lang] || lang}: trình duyệt không có trình phân tích)`, errors: [] };
}
