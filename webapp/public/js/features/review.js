/**
 * review.js — Kiểm tra tự động (cú pháp + nhất quán), AI Reviewer, AI Fixer có DIFF + Chấp nhận.
 * - Reviewer trả JSON {issues:[...]}. JSON lỗi ⇒ cảnh báo rõ, KHÔNG coi là "không có lỗi" (lỗi B14 bản GAS).
 * - Fixer: mỗi bản sửa là ĐỀ XUẤT; chỉ ghi đè khi người dùng bấm "Chấp nhận"; sau đó chạy lại cú pháp + nhất quán.
 */
import { checkSyntax } from '../core/syntaxCheck.js';
import { checkConsistency } from '../core/consistency.js';
import { extractJson, stripCodeFences } from '../core/parser.js';
import { reviewSystem, reviewUser, fixSystem, fixUser } from '../core/prompts.js';
import { getPlatform } from '../core/platforms.js';
import { modelFor } from './models.js';
import { surfaceOfOthers } from './codeBuilder.js';

/** Chạy cú pháp + nhất quán cho toàn dự án, cập nhật checks từng file. */
export async function runChecks(app) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const generated = Object.fromEntries(Object.entries(files).filter(([, f]) => f.origin === 'ai').map(([k, f]) => [k, f.content]));
  if (!Object.keys(generated).length) return { status: 'failed', error: 'Chưa có file nào được sinh.' };
  const syn = {};
  for (const [path, code] of Object.entries(generated)) syn[path] = await checkSyntax(path, code);
  const con = await checkConsistency({ files: generated, contract: p.workspace.contract, platform: getPlatform(p.platform) });
  const byFile = {};
  for (const i of con.issues) { const k = i.file || '_project'; (byFile[k] = byFile[k] || []).push(i); }
  for (const [path, f] of Object.entries(files)) {
    if (f.origin !== 'ai') continue;
    const issues = byFile[path] || [];
    const errs = issues.filter((i) => i.level === 'error').length;
    const cov = con.coverage[path];
    const consistency = cov === 'skipped' ? { status: 'not-applicable', errors: 0, warnings: 0 }
      : cov === 'failed' ? { status: 'fail', errors: errs || 1, warnings: issues.length - errs, note: 'Không phân tích được' }
        : { status: errs ? 'fail' : issues.length ? 'warn' : 'pass', errors: errs, warnings: issues.length - errs, method: cov };
    await app.projects.putFile(p.id, path, { checks: { ...(f.checks || {}), syntax: { ...syn[path], at: Date.now() }, consistency: { ...consistency, at: Date.now() }, review: f.checks?.review || null } });
  }
  const sCount = { pass: 0, fail: 0, unchecked: 0 };
  Object.values(syn).forEach((s) => { sCount[s.status] = (sCount[s.status] || 0) + 1; });
  const validation = {
    at: Date.now(), ok: con.ok && !sCount.fail, stats: con.stats, coverage: con.coverage, issues: con.issues,
    syntax: Object.fromEntries(Object.entries(syn).map(([k, v]) => [k, { status: v.status, message: v.message, checker: v.checker, errors: v.errors }])),
    syntaxSummary: `${sCount.pass} đạt, ${sCount.fail} lỗi, ${sCount.unchecked} chưa kiểm tra`
  };
  await app.projects.updateWorkspace(p.id, { validation });
  await app.reloadProject();
  return { status: 'done', note: `cú pháp: ${validation.syntaxSummary}; nhất quán: ${con.stats.errors} lỗi, ${con.stats.warnings} cảnh báo`, validation };
}

/** AI Reviewer. */
export async function aiReview(app, { signal } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const gen = Object.fromEntries(Object.entries(files).filter(([, f]) => f.origin === 'ai').map(([k, f]) => [k, f.content]));
  if (!Object.keys(gen).length) return { status: 'failed', error: 'Chưa có file để review.' };
  const ref = modelFor(app, 'review');
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'review', projectId: p.id, signal, temperature: 0.1,
    messages: [{ role: 'system', content: reviewSystem({ outputLang: p.outputLang }) },
      { role: 'user', content: reviewUser({ contractText: p.workspace.contractText, findings: p.workspace.validation?.issues || [], files: gen }) }]
  });
  const ex = extractJson(r.content);
  let review;
  if (r.truncated) review = { ok: false, parseError: `Phản hồi review BỊ CẮT sau ${r.rounds} vòng.`, issues: [], raw: r.content };
  else if (!ex.ok) review = { ok: false, parseError: ex.error, issues: [], raw: r.content };
  else if (!Array.isArray(ex.value.issues)) review = { ok: false, parseError: 'JSON thiếu mảng "issues".', issues: [], raw: r.content };
  else {
    const issues = ex.value.issues.filter((i) => i && typeof i === 'object').map((i) => ({
      file: String(i.file || ''), severity: i.severity === 'error' ? 'error' : 'warn', problem: String(i.problem || ''), fix: String(i.fix || ''), known: String(i.file || '') in gen
    }));
    review = { ok: true, issues };
  }
  review.at = Date.now();
  review.model = `${r.provider}/${r.model}`;
  await app.projects.updateWorkspace(p.id, { review, fixProposals: [] });
  // Gắn kết quả review vào từng file (chỉ khi parse được)
  if (review.ok) {
    for (const [path, f] of Object.entries(files)) {
      if (f.origin !== 'ai') continue;
      const mine = review.issues.filter((i) => i.file === path);
      await app.projects.putFile(p.id, path, { checks: { ...(f.checks || {}), review: { status: mine.some((i) => i.severity === 'error') ? 'fail' : mine.length ? 'warn' : 'pass', issues: mine.length, at: Date.now() } } });
    }
  }
  await app.reloadProject();
  if (!review.ok) return { status: 'failed', halt: false, error: 'Không đọc được kết quả review: ' + review.parseError + ' (KHÔNG coi là "không có lỗi").' };
  return { status: 'done', note: `${review.issues.length} vấn đề` };
}

/** Gom vấn đề cần sửa theo file: từ AI review + lỗi kiểm tra tự động (mức error). */
export function problemsByFile(workspace) {
  const by = {};
  for (const i of workspace.review?.issues || []) if (i.known) (by[i.file] = by[i.file] || []).push(`[review/${i.severity}] ${i.problem}${i.fix ? ' ⇒ ' + i.fix : ''}`);
  for (const i of workspace.validation?.issues || []) if (i.level === 'error' && i.file) (by[i.file] = by[i.file] || []).push(`[check/${i.type}] ${i.message}${i.line ? ` (dòng ${i.line})` : ''}`);
  return by;
}

/** Sinh ĐỀ XUẤT sửa cho các file có vấn đề. KHÔNG ghi đè file. */
export async function proposeFixes(app, { signal, onlyFiles = null } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const by = problemsByFile(p.workspace);
  const targets = Object.keys(by).filter((f) => files[f]?.origin === 'ai' && (!onlyFiles || onlyFiles.includes(f)));
  if (!targets.length) return { status: 'skipped', note: 'Không có vấn đề nào cần sửa' };
  const ref = modelFor(app, 'review');
  const proposals = (p.workspace.fixProposals || []).filter((x) => !targets.includes(x.path));
  for (const path of targets) {
    if (signal?.aborted) throw signal.reason;
    const r = await app.llm.complete({
      provider: ref.provider, model: ref.model, step: `fix:${path}`, projectId: p.id, signal, temperature: 0.1, noCache: true,
      messages: [{ role: 'system', content: fixSystem({ outputLang: p.outputLang }) },
        { role: 'user', content: fixUser({ contractText: p.workspace.contractText, path, problems: by[path], code: files[path].content, surface: await surfaceOfOthers(files, path) }) }]
    });
    const content = stripCodeFences(r.content).replace(/^\n+/, '');
    const syntax = await checkSyntax(path, content);
    proposals.push({ path, problems: by[path], before: files[path].content, after: content, truncated: r.truncated, syntax, at: Date.now(), status: 'pending', model: `${r.provider}/${r.model}` });
    await app.projects.updateWorkspace(p.id, { fixProposals: proposals });
  }
  await app.reloadProject();
  const trunc = proposals.filter((x) => x.truncated).length;
  return { status: 'done', note: `${targets.length} đề xuất chờ duyệt${trunc ? `, ${trunc} bị cắt (không nên chấp nhận)` : ''}` };
}

/** Chấp nhận 1 đề xuất: ghi đè file rồi chạy lại cú pháp + nhất quán. */
export async function acceptFix(app, path) {
  const p = await app.projects.getProject(app.state.project.id);
  const list = p.workspace.fixProposals || [];
  const prop = list.find((x) => x.path === path && x.status === 'pending');
  if (!prop) throw new Error('Không có đề xuất đang chờ cho ' + path);
  if (prop.truncated) throw new Error('Đề xuất này BỊ CẮT — không thể chấp nhận. Hãy tạo lại đề xuất.');
  const cur = await app.projects.getFile(p.id, path);
  if (cur.content !== prop.before) throw new Error('File đã thay đổi sau khi tạo đề xuất — hãy tạo lại đề xuất để tránh ghi đè mất dữ liệu.');
  await app.projects.putFile(p.id, path, { content: prop.after, truncated: false, checks: { syntax: { ...prop.syntax, at: Date.now() } }, meta: { ...(cur.meta || {}), fixedBy: prop.model, fixedAt: Date.now() } });
  prop.status = 'accepted';
  await app.projects.updateWorkspace(p.id, { fixProposals: list });
  await runChecks(app);
}

export async function rejectFix(app, path) {
  const p = await app.projects.getProject(app.state.project.id);
  const list = p.workspace.fixProposals || [];
  const prop = list.find((x) => x.path === path && x.status === 'pending');
  if (prop) prop.status = 'rejected';
  await app.projects.updateWorkspace(p.id, { fixProposals: list });
  await app.reloadProject();
}
