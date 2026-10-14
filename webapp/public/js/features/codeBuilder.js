/**
 * codeBuilder.js — Sinh TỪNG file theo Contract (nguồn sự thật), truyền API surface của file đã build.
 * Không cắt Contract im lặng: nếu quá dài so với ngân sách ngữ cảnh ⇒ dùng bản rút gọn CÓ KIỂM SOÁT
 * (contractSliceForFile — đủ dataSchema, hằng số, chữ ký MỌI hàm, mọi DOM id) và BÁO người dùng.
 * Port buildCodeFile + buildReadme + _extractSurface (gộp bản client/server trùng nhau).
 */
import { contractSliceForFile } from '../core/contract.js';
import { codeSystem, codeUser, readmeSystem, readmeUser } from '../core/prompts.js';
import { stripCodeFences } from '../core/parser.js';
import { fileSpec, filePaths, langOf } from '../core/platforms.js';
import { analyzeJs, analyzeByRegex, htmlIds } from '../core/consistency.js';
import { checkSyntax } from '../core/syntaxCheck.js';
import { modelFor } from './models.js';

/** Ngưỡng ký tự contract trước khi dùng bản rút gọn (sửa được trong Settings). */
export const DEFAULT_CONTRACT_CHAR_BUDGET = 60000;

/** Bề mặt API (hàm/hằng/DOM id) của 1 file — ngắn, đúng thứ AI cần. */
export async function extractSurface(path, code) {
  const lang = langOf(path);
  let a = null;
  if (lang === 'js' || lang === 'gs') {
    const r = await analyzeJs(String(code || ''), { lang });
    if (!r.error) a = r;
  } else if (['ts', 'tsx', 'jsx', 'py', 'dart'].includes(lang)) a = analyzeByRegex(code, lang);
  const ids = ['html', 'tsx', 'jsx'].includes(lang) ? htmlIds(code).map((x) => x.id) : [];
  const parts = [];
  if (a?.functions.length) parts.push('functions: ' + [...new Set(a.functions.map((f) => f.name))].join(', '));
  const consts = a ? [...new Set(a.globals.filter((g) => g.kind === 'const' || /^[A-Z][A-Z0-9_]+$/.test(g.name)).map((g) => g.name))] : [];
  if (consts.length) parts.push('constants: ' + consts.join(', '));
  if (ids.length) parts.push('domIds: ' + [...new Set(ids)].join(', '));
  return parts.length ? `### ${path} ĐÃ ĐỊNH NGHĨA:\n${parts.join('\n')}` : '';
}

export async function surfaceOfOthers(files, exceptPath) {
  const out = [];
  for (const [p, f] of Object.entries(files)) {
    if (p === exceptPath || f.origin !== 'ai' || !f.content) continue;
    const s = await extractSurface(p, f.content);
    if (s) out.push(s);
  }
  return out.join('\n\n');
}

export function codeFileInput(project, path) {
  const w = project.workspace;
  return { path, contract: w.contractText, claudeMd: w.claudeMd, platform: project.platform, lang: project.outputLang };
}

/** Sinh 1 file. Trả {status:'done'|'truncated'|'failed', note, error}. */
export async function buildFile(app, path, { signal, onDelta, onEvent } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  if (!w.contract) return { status: 'failed', error: 'Chưa có Contract hợp lệ.' };
  const ref = modelFor(app, 'code');
  const files = await app.projects.filesMap(p.id);
  const budget = app.settings.get().contractCharBudget || DEFAULT_CONTRACT_CHAR_BUDGET;
  let contractText = w.contractText;
  let contractNote = '';
  if (contractText.length > budget) {
    contractText = JSON.stringify(contractSliceForFile(w.contract, path), null, 2);
    contractNote = `Contract đầy đủ dài ${w.contractText.length.toLocaleString('vi-VN')} ký tự; đây là bản rút gọn có kiểm soát cho ${path} (giữ đủ dataSchema, hằng số, chữ ký mọi hàm, DOM id).`;
    onEvent?.({ type: 'contract-sliced', path, from: w.contractText.length, to: contractText.length });
    await app.logger.warn('codeBuilder', `Contract dài hơn ${budget} ký tự ⇒ dùng bản rút gọn cho ${path}.`, { projectId: p.id, path });
  }
  const spec = fileSpec(p.platform, path);
  const surface = await surfaceOfOthers(files, path);
  const stub = files[path]?.origin === 'ai' ? '' : files[path]?.content || '';
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: `code:${path}`, projectId: p.id, signal, onDelta, onEvent, temperature: 0.3,
    messages: [{ role: 'system', content: codeSystem({ platformId: p.platform, outputLang: p.outputLang }) },
      { role: 'user', content: codeUser({ claudeMd: w.claudeMd, contractText, contractNote, fileSpec: spec, surface, stub, skills: w.skills }) }]
  });
  const content = stripCodeFences(r.content).replace(/^\n+/, '');
  const syntax = await checkSyntax(path, content);
  await app.projects.putFile(p.id, path, {
    content, origin: 'ai', generatedAt: Date.now(), truncated: r.truncated, stale: false, error: null,
    checks: { syntax: { ...syntax, at: Date.now() } },
    meta: { provider: r.provider, model: r.model, rounds: r.rounds, cost: r.cost, usage: r.usage, cached: r.cached, contractSliced: !!contractNote, fallbackFrom: r.fallbackFrom }
  });
  if (r.truncated) return { status: 'truncated', note: `bị cắt sau ${r.rounds} vòng` };
  return { status: 'done', note: `${content.length.toLocaleString('vi-VN')} ký tự · cú pháp: ${syntax.status === 'pass' ? 'OK' : syntax.status === 'fail' ? 'LỖI' : 'chưa kiểm tra'}` };
}

export function fileList(project) {
  return project.fileList || filePaths(project.platform);
}

/** README cho người mới. */
export async function buildReadme(app, { signal, onDelta } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  const ref = modelFor(app, 'readme');
  const v = w.validation;
  const summary = v ? `${v.stats?.errors ?? 0} lỗi, ${v.stats?.warnings ?? 0} cảnh báo nhất quán; cú pháp: ${v.syntaxSummary || 'n/a'}` : 'chưa chạy kiểm tra';
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'readme', projectId: p.id, signal, onDelta,
    messages: [{ role: 'system', content: readmeSystem({ outputLang: p.outputLang }) },
      { role: 'user', content: readmeUser({ claudeMd: w.claudeMd, platformId: p.platform, fileList: fileList(p), skills: w.skills, validationSummary: summary, outputLang: p.outputLang }) }]
  });
  const md = r.content.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
  await app.projects.updateWorkspace(p.id, { readme: md, readmeState: r.truncated ? 'truncated' : 'generated', readmeMeta: { provider: r.provider, model: r.model, cost: r.cost, at: Date.now() } });
  await app.reloadProject();
  return r.truncated ? { status: 'truncated', note: 'README bị cắt' } : { status: 'done' };
}
