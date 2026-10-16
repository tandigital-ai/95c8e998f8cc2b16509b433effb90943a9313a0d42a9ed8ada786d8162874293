/**
 * consistency.js — Kiểm tra tính nhất quán giữa các file và với Contract.
 * Port + nâng cấp validateProjectConsistency của bản GAS.
 *
 * - JS/GS (và <script> trong HTML): phân tích AST bằng acorn ⇒ chính xác, có số dòng.
 * - TS/TSX/PY/DART: dùng regex (gắn nhãn "heuristic" trong kết quả).
 * - Bỏ qua Markdown/README (bản cũ quét cả README ⇒ báo trùng hàm sai).
 *
 * Phát hiện (mỗi mục: {level:'error'|'warn', type, message, file, line, names[]}):
 *   duplicate_function   hàm định nghĩa ở >1 file (error nếu GAS chung global; warn nếu module)
 *   duplicate_global     hằng/biến top-level trùng giữa các file .gs (GAS chung global scope)
 *   missing_function     hàm trong contract chưa được định nghĩa
 *   wrong_owner          hàm định nghĩa ở file khác file chủ trong contract
 *   undefined_call       hàm được gọi mà không thấy định nghĩa/ import / built-in
 *   gas_run_missing      google.script.run.X nhưng X không có trong file .gs nào
 *   field_not_in_schema  object literal giống entity nhưng có trường ngoài dataSchema
 *   dom_missing          DOM id trong contract không có trong HTML nào
 *   dom_unknown          JS dùng DOM id không có trong HTML lẫn contract
 *   dom_extra            HTML có id không khai báo trong contract
 *   parse_failed         không phân tích được file (đã báo bên syntaxCheck)
 */
import { langOf } from './platforms.js';
import { extractInlineScripts } from './syntaxCheck.js';

let acornMod = null;
export function setAcorn(mod) { acornMod = mod; }
async function getAcorn() {
  if (!acornMod) acornMod = await import('../../vendor/acorn.mjs');
  return acornMod;
}

/** Tên toàn cục/built-in không coi là "chưa định nghĩa". */
const BUILTINS = new Set(('require,import,eval,parseInt,parseFloat,isNaN,isFinite,encodeURIComponent,decodeURIComponent,encodeURI,decodeURI,escape,unescape,' +
  'setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame,queueMicrotask,structuredClone,fetch,alert,confirm,prompt,atob,btoa,' +
  'Number,String,Boolean,Object,Array,Date,Math,JSON,Promise,Symbol,Map,Set,WeakMap,WeakSet,RegExp,Error,TypeError,RangeError,SyntaxError,BigInt,Proxy,Reflect,Intl,' +
  'URL,URLSearchParams,Blob,File,FileReader,FormData,Headers,Request,Response,AbortController,TextEncoder,TextDecoder,Event,CustomEvent,EventTarget,' +
  'Uint8Array,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,ArrayBuffer,DataView,Image,Audio,Option,Worker,WebSocket,' +
  'IntersectionObserver,MutationObserver,ResizeObserver,DOMParser,XMLHttpRequest,Notification,getComputedStyle,matchMedia,scrollTo,open,close,print,' +
  'console,describe,it,test,expect,beforeEach,afterEach,beforeAll,afterAll,jest,vi,' +
  // GAS
  'include,doGet,doPost,onOpen,onEdit,onInstall,onFormSubmit,HtmlService,SpreadsheetApp,DriveApp,PropertiesService,CacheService,LockService,Utilities,Logger,' +
  'UrlFetchApp,MailApp,GmailApp,CalendarApp,DocumentApp,FormApp,ScriptApp,Session,ContentService,Browser,SlidesApp,Charts,Maps,console').split(','));

function lineOf(text, index) { return String(text).slice(0, index).split('\n').length; }

/* ------------------------------------------------------------------ */
/* Duyệt AST tối giản                                                  */
/* ------------------------------------------------------------------ */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node); }
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((e) => patternNames(e, out));
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

/** Chuỗi thành viên google.script.run....X */
function gasRunTarget(callee) {
  if (callee?.type !== 'MemberExpression' || callee.computed) return null;
  const name = callee.property.name;
  let obj = callee.object;
  // bỏ qua chuỗi withSuccessHandler(...).withFailureHandler(...)
  while (obj && obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && /^with(SuccessHandler|FailureHandler|UserObject)$/.test(obj.callee.property.name)) {
    obj = obj.callee.object;
  }
  if (obj?.type === 'MemberExpression' && !obj.computed && obj.property.name === 'run' && obj.object?.type === 'MemberExpression' && obj.object.property?.name === 'script' && obj.object.object?.name === 'google') {
    return /^with(SuccessHandler|FailureHandler|UserObject)$/.test(name) ? null : name;
  }
  return null;
}

/**
 * Trích "bề mặt" JS bằng AST.
 * @returns {{functions:Array<{name,line}>, globals:Array<{name,line,kind}>, calls:Array<{name,line}>, imports:Set<string>,
 *            localNames:Set<string>, domRefs:Array<{id,line}>, gasRun:Array<{name,line}>, objects:Array<{keys,line}>}}
 */
export async function analyzeJs(code, { lang = 'js', lineOffset = 0 } = {}) {
  const acorn = await getAcorn();
  let ast;
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  try { ast = acorn.parse(code, { ...opts, sourceType: lang === 'gs' ? 'script' : 'module', allowAwaitOutsideFunction: true }); } catch (e1) {
    try { ast = acorn.parse(code, { ...opts, sourceType: lang === 'gs' ? 'module' : 'script' }); } catch (_e2) {
      return { error: e1.message };
    }
  }
  const L = (n) => (n.loc?.start.line || 0) + lineOffset;
  const out = { functions: [], globals: [], calls: [], imports: new Set(), localNames: new Set(), domRefs: [], gasRun: [], objects: [] };

  // Top-level declarations
  for (const st of ast.body) {
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration' && decl.id) out.functions.push({ name: decl.id.name, line: L(decl) });
    else if (decl.type === 'ClassDeclaration' && decl.id) out.globals.push({ name: decl.id.name, line: L(decl), kind: 'class' });
    else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const isFn = d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression');
        for (const n of patternNames(d.id)) {
          if (isFn) out.functions.push({ name: n, line: L(d) });
          else out.globals.push({ name: n, line: L(d), kind: decl.kind });
        }
      }
    }
    if (st.type === 'ImportDeclaration') st.specifiers.forEach((s) => out.imports.add(s.local.name));
  }

  walk(ast, (node) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) out.localNames.add(node.id.name);
        node.params.forEach((p) => patternNames(p).forEach((n) => out.localNames.add(n)));
        break;
      case 'VariableDeclarator': patternNames(node.id).forEach((n) => out.localNames.add(n)); break;
      case 'ClassDeclaration': if (node.id) out.localNames.add(node.id.name); break;
      case 'CatchClause': patternNames(node.param).forEach((n) => out.localNames.add(n)); break;
      case 'ImportDeclaration': node.specifiers.forEach((s) => out.imports.add(s.local.name)); break;
      case 'CallExpression': {
        const c = node.callee;
        if (c.type === 'Identifier') out.calls.push({ name: c.name, line: L(node) });
        const g = gasRunTarget(c);
        if (g) out.gasRun.push({ name: g, line: L(node) });
        // DOM: getElementById('x'), querySelector('#x')
        if (c.type === 'MemberExpression' && !c.computed && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
          const m = c.property.name;
          const v = node.arguments[0].value;
          if (m === 'getElementById') out.domRefs.push({ id: v, line: L(node) });
          else if ((m === 'querySelector' || m === 'querySelectorAll') && /^#[A-Za-z][\w-]*$/.test(v)) out.domRefs.push({ id: v.slice(1), line: L(node) });
        }
        break;
      }
      case 'ObjectExpression': {
        const keys = node.properties
          .filter((p) => p.type === 'Property' && !p.computed)
          .map((p) => (p.key.type === 'Identifier' ? p.key.name : typeof p.key.value === 'string' ? p.key.value : null))
          .filter(Boolean);
        if (keys.length >= 2) out.objects.push({ keys, line: L(node) });
        break;
      }
      default: break;
    }
  });
  return out;
}

/** Regex cho ngôn ngữ không có parser (heuristic). */
export function analyzeByRegex(code, lang) {
  const out = { functions: [], globals: [], calls: [], imports: new Set(), localNames: new Set(), domRefs: [], gasRun: [], objects: [], heuristic: true };
  const text = String(code);
  const push = (re, arr, kind) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) arr.push(kind ? { name: m[1], line: lineOf(text, m.index), kind } : { name: m[1], line: lineOf(text, m.index) });
  };
  if (lang === 'py') {
    push(/^def\s+([A-Za-z_]\w*)\s*\(/gm, out.functions);
    push(/^class\s+([A-Za-z_]\w*)/gm, out.globals, 'class');
    push(/^([A-Z][A-Z0-9_]{2,})\s*=/gm, out.globals, 'const');
  } else if (lang === 'dart') {
    push(/^\s*(?:[\w<>?,\s]+\s+)?([a-z_]\w*)\s*\([^;{]*\)\s*(?:async\s*)?\{/gm, out.functions);
    push(/^\s*class\s+([A-Za-z_]\w*)/gm, out.globals, 'class');
  } else {
    // ts/tsx/jsx
    push(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/g, out.functions);
    push(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g, out.functions);
    push(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/g, out.globals, 'const');
    push(/getElementById\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g, out.domRefs);
  }
  return out;
}

/** id="..." trong HTML/JSX. */
export function htmlIds(code) {
  const ids = [];
  const re = /\bid\s*=\s*["']([A-Za-z][\w:.-]*)["']/g;
  let m;
  while ((m = re.exec(String(code))) !== null) ids.push({ id: m[1], line: lineOf(code, m.index) });
  return ids;
}

/**
 * Kiểm tra toàn dự án.
 * @param {{files: Record<string,string>, contract?: object, platform?: {scope:string}}} p
 * @returns {Promise<{ok:boolean, issues:Array, stats:object, coverage:Record<string,'ast'|'regex'|'skipped'|'failed'>}>}
 */
export async function checkConsistency({ files, contract = null, platform = { scope: 'module' } }) {
  const issues = [];
  const add = (level, type, message, file = null, line = null, names = []) => issues.push({ level, type, message, file, line, names });
  const coverage = {};
  const per = {};
  const htmlIdMap = new Map(); // id -> [{file,line}]
  const isGas = platform.scope === 'gas-global';

  for (const [path, code] of Object.entries(files || {})) {
    const lang = langOf(path);
    if (lang === 'md' || /readme/i.test(path)) { coverage[path] = 'skipped'; continue; }
    if (lang === 'js' || lang === 'gs') {
      const a = await analyzeJs(String(code ?? ''), { lang });
      if (a.error) { coverage[path] = 'failed'; add('warn', 'parse_failed', `Không phân tích được ${path}: ${a.error}`, path); continue; }
      per[path] = { ...a, lang, server: lang === 'gs' };
      coverage[path] = 'ast';
    } else if (lang === 'html') {
      for (const x of htmlIds(code)) { if (!htmlIdMap.has(x.id)) htmlIdMap.set(x.id, []); htmlIdMap.get(x.id).push({ file: path, line: x.line }); }
      const merged = { functions: [], globals: [], calls: [], imports: new Set(), localNames: new Set(), domRefs: [], gasRun: [], objects: [], lang: 'html', server: false };
      let failed = false;
      for (const s of extractInlineScripts(code)) {
        if (/<\?/.test(s.code)) continue;
        const a = await analyzeJs(s.code, { lang: s.module ? 'js' : 'gs', lineOffset: s.line - 1 });
        if (a.error) { failed = true; add('warn', 'parse_failed', `Không phân tích được <script> trong ${path}: ${a.error}`, path, s.line); continue; }
        for (const k of ['functions', 'globals', 'calls', 'domRefs', 'gasRun', 'objects']) merged[k].push(...a[k]);
        a.imports.forEach((n) => merged.imports.add(n));
        a.localNames.forEach((n) => merged.localNames.add(n));
      }
      per[path] = merged;
      coverage[path] = failed ? 'failed' : 'ast';
    } else if (['ts', 'tsx', 'jsx', 'py', 'dart'].includes(lang)) {
      per[path] = { ...analyzeByRegex(code, lang), lang, server: false };
      if (lang === 'tsx' || lang === 'jsx') for (const x of htmlIds(code)) { if (!htmlIdMap.has(x.id)) htmlIdMap.set(x.id, []); htmlIdMap.get(x.id).push({ file: path, line: x.line }); }
      coverage[path] = 'regex';
    } else {
      coverage[path] = 'skipped';
    }
  }

  // ---- 1) Hàm trùng giữa các file ----
  const fnDefs = new Map(); // name -> [{file,line}]
  for (const [path, a] of Object.entries(per)) {
    for (const fn of a.functions) {
      if (!fnDefs.has(fn.name)) fnDefs.set(fn.name, []);
      fnDefs.get(fn.name).push({ file: path, line: fn.line });
    }
  }
  for (const [name, locs] of fnDefs) {
    const filesWith = [...new Set(locs.map((l) => l.file))];
    if (locs.length > 1) {
      if (filesWith.length === 1) {
        add('error', 'duplicate_function', `Hàm "${name}" định nghĩa ${locs.length} lần trong ${filesWith[0]} (dòng ${locs.map((l) => l.line).join(', ')}).`, filesWith[0], locs[1].line, [name]);
        continue;
      }
      const gasServer = filesWith.filter((f) => per[f].server);
      if (isGas && gasServer.length > 1) {
        add('error', 'duplicate_function', `Hàm "${name}" định nghĩa ở nhiều file .gs (GAS dùng chung global scope): ${gasServer.join(', ')}.`, gasServer[1], locs.find((l) => l.file === gasServer[1])?.line, [name]);
      } else if (!isGas) {
        add('warn', 'duplicate_function', `Hàm "${name}" định nghĩa ở nhiều file: ${filesWith.join(', ')} (module riêng nên không lỗi cú pháp, nhưng trái quy tắc "1 hàm 1 file chủ").`, filesWith[1], null, [name]);
      }
    }
  }

  // ---- 2) Hằng/biến top-level trùng giữa các file GAS ----
  if (isGas) {
    const g = new Map();
    for (const [path, a] of Object.entries(per)) {
      if (!a.server) continue;
      for (const x of [...a.globals, ...a.functions]) {
        if (!g.has(x.name)) g.set(x.name, []);
        g.get(x.name).push({ file: path, line: x.line, kind: x.kind || 'function' });
      }
    }
    for (const [name, locs] of g) {
      const fs = [...new Set(locs.map((l) => l.file))];
      if (fs.length > 1 && locs.some((l) => l.kind !== 'function')) {
        add('error', 'duplicate_global', `"${name}" khai báo top-level ở nhiều file .gs (${locs.map((l) => `${l.file}:${l.line}`).join(', ')}) — GAS chung global scope ⇒ lỗi "Identifier has already been declared" hoặc ghi đè.`, fs[1], locs[1].line, [name]);
      }
    }
  }

  // ---- 3) So với contract ----
  const contractFns = contract?.functions || [];
  for (const f of contractFns) {
    if (!f?.name) continue;
    const locs = fnDefs.get(f.name);
    const ownerAnalyzed = !f.file || coverage[f.file] === 'ast' || coverage[f.file] === 'regex';
    if (!locs) {
      if (f.file && !(f.file in files)) add('error', 'missing_function', `Hàm "${f.name}" (chủ: ${f.file}) chưa định nghĩa — file ${f.file} chưa có.`, f.file, null, [f.name]);
      else if (ownerAnalyzed) add('error', 'missing_function', `Hàm "${f.name}" trong contract (chủ: ${f.file || '?'}) chưa được định nghĩa ở đâu.`, f.file || null, null, [f.name]);
    } else if (f.file && !locs.some((l) => l.file === f.file)) {
      add('warn', 'wrong_owner', `Hàm "${f.name}" đáng lẽ ở "${f.file}" nhưng định nghĩa ở ${[...new Set(locs.map((l) => l.file))].join(', ')}.`, locs[0].file, locs[0].line, [f.name]);
    }
  }

  // ---- 4) Hàm được gọi mà chưa định nghĩa ----
  const defined = new Set(fnDefs.keys());
  const globalsAll = new Set();
  for (const a of Object.values(per)) a.globals.forEach((x) => globalsAll.add(x.name));
  const contractNames = new Set(contractFns.map((f) => f.name));
  for (const [path, a] of Object.entries(per)) {
    if (a.heuristic) continue; // regex không đủ tin cậy cho phép kiểm tra này
    const seen = new Set();
    for (const c of a.calls) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      if (defined.has(c.name) || globalsAll.has(c.name) || BUILTINS.has(c.name) || a.imports.has(c.name) || a.localNames.has(c.name)) continue;
      add('warn', 'undefined_call', `${path}: gọi "${c.name}()" nhưng không thấy định nghĩa trong dự án${contractNames.has(c.name) ? ' (có trong contract nhưng chưa hiện thực)' : ''}.`, path, c.line, [c.name]);
    }
    // google.script.run.X phải có trong .gs
    if (isGas) {
      const serverFns = new Set();
      for (const b of Object.values(per)) if (b.server) b.functions.forEach((x) => serverFns.add(x.name));
      for (const g of a.gasRun) {
        if (!serverFns.has(g.name)) add('error', 'gas_run_missing', `${path}: google.script.run.${g.name}() nhưng không file .gs nào định nghĩa "${g.name}".`, path, g.line, [g.name]);
        else if (g.name.endsWith('_')) add('error', 'gas_run_private', `${path}: google.script.run.${g.name}() — hàm kết thúc bằng "_" là private trong GAS, client không gọi được.`, path, g.line, [g.name]);
      }
    }
  }

  // ---- 5) Trường dữ liệu ngoài schema ----
  if (contract?.dataSchema?.length) {
    const entities = contract.dataSchema.map((e) => ({ name: e.entity, fields: new Set((e.fields || []).map((f) => f.name)) }));
    for (const [path, a] of Object.entries(per)) {
      for (const o of a.objects) {
        let best = null;
        let bestHit = 0;
        for (const e of entities) {
          const hit = o.keys.filter((k) => e.fields.has(k)).length;
          if (hit > bestHit) { best = e; bestHit = hit; }
        }
        if (!best || bestHit < 2 || bestHit < Math.ceil(o.keys.length / 2)) continue;
        const extra = o.keys.filter((k) => !best.fields.has(k));
        if (extra.length) add('warn', 'field_not_in_schema', `${path}: object giống entity "${best.name}" có trường ngoài dataSchema: ${extra.join(', ')}.`, path, o.line, extra);
      }
    }
  }

  // ---- 6) DOM id ----
  const contractIds = new Set((contract?.domElements || []).map((d) => d.id).filter(Boolean));
  const hasMarkup = Object.keys(files || {}).some((p) => ['html', 'tsx', 'jsx'].includes(langOf(p)));
  if (hasMarkup) {
    for (const id of contractIds) if (!htmlIdMap.has(id)) add('warn', 'dom_missing', `DOM id "${id}" có trong contract nhưng không thấy trong HTML.`, (contract.domElements.find((d) => d.id === id) || {}).file || null, null, [id]);
    for (const [id, locs] of htmlIdMap) {
      if (locs.length > 1 && new Set(locs.map((l) => l.file)).size === 1 && locs[0].file && langOf(locs[0].file) === 'html') {
        add('error', 'dom_duplicate', `DOM id "${id}" xuất hiện ${locs.length} lần trong ${locs[0].file}.`, locs[0].file, locs[1].line, [id]);
      }
      if (contractIds.size && !contractIds.has(id)) add('warn', 'dom_extra', `HTML có id "${id}" không khai báo trong contract.`, locs[0].file, locs[0].line, [id]);
    }
    for (const [path, a] of Object.entries(per)) {
      for (const r of a.domRefs) {
        if (!htmlIdMap.has(r.id) && !contractIds.has(r.id)) add('error', 'dom_unknown', `${path}: dùng DOM id "${r.id}" nhưng không có trong HTML lẫn contract.`, path, r.line, [r.id]);
        else if (!htmlIdMap.has(r.id)) add('warn', 'dom_unknown', `${path}: dùng DOM id "${r.id}" (có trong contract) nhưng HTML chưa có phần tử này.`, path, r.line, [r.id]);
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  return {
    ok: errors === 0,
    issues,
    stats: { errors, warnings: issues.length - errors, analyzedFiles: Object.keys(per).length },
    coverage
  };
}
