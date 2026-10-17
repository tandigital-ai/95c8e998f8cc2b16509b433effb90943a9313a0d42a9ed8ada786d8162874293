/**
 * review.js — Kiểm tra tự động (cú pháp + nhất quán), AI Reviewer, AI Fixer có DIFF + Chấp nhận.
 * - Reviewer trả JSON {issues:[...]}. JSON lỗi ⇒ cảnh báo rõ, KHÔNG coi là "không có lỗi" (lỗi B14 bản GAS).
 * - Fixer: mỗi bản sửa là ĐỀ XUẤT; chỉ ghi đè khi người dùng bấm "Chấp nhận"; sau đó chạy lại cú pháp + nhất quán.
 * v2 — BAN ĐIỀU PHỐI (phần 1):
 * - Mỗi đề xuất (sửa lỗi / nâng cấp) có PHIẾU CÔNG VIỆC (WO): contractHash, baseHash, model, trạng thái.
 * - Khóa theo file: 1 file chỉ 1 bản nháp đang chờ; bản mới THAY bản cũ (sổ cái ghi "superseded").
 * - Quy tắc hợp nhất: core/workOrders.js#checkMerge. Mọi bước ghi vào workspace.ledger (Sổ cái).
 * - Báo tiến trình qua `track` (ui/taskProgress.js). Không có track ⇒ chạy im lặng như cũ (pipeline).
 * - AI Review KHÔNG còn xóa các đề xuất đang chờ (sửa lỗi mất đề xuất nâng cấp).
 */
import { checkSyntax } from '../core/syntaxCheck.js';
import { checkConsistency } from '../core/consistency.js';
import { extractJson, stripCodeFences } from '../core/parser.js';
import { reviewSystem, reviewUser, fixSystem, fixUser } from '../core/prompts.js';
import { getPlatform } from '../core/platforms.js';
import { sha256Hex } from '../core/hash.js';
import { woId, nextRev, appendLedger, checkMerge } from '../core/workOrders.js';
import { modelFor } from './models.js';
import { surfaceOfOthers } from './codeBuilder.js';

export const NOOP_TRACK = Object.freeze({ stage() {}, progress() {}, addCall() {}, onEvent: undefined });

const shortHash = async (s) => String(await sha256Hex(String(s ?? ''))).slice(0, 16);

/** onDelta → % thật: số ký tự đã nhận / số ký tự dự kiến. */
export function deltaTracker(track, base, span, expectedChars, label) {
  const exp = Math.max(400, Number(expectedChars) || 0);
  return (_d, full) => {
    const n = String(full || '').length;
    track.progress(base + span * Math.min(0.95, n / exp), `${label}: đã nhận ${n.toLocaleString('vi-VN')} / ~${exp.toLocaleString('vi-VN')} ký tự`);
  };
}

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
export async function aiReview(app, { signal, track = NOOP_TRACK } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const gen = Object.fromEntries(Object.entries(files).filter(([, f]) => f.origin === 'ai').map(([k, f]) => [k, f.content]));
  const n = Object.keys(gen).length;
  if (!n) return { status: 'failed', error: 'Chưa có file để review.' };
  const ref = modelFor(app, 'review');
  track.stage(`AI đang đọc & review ${n} file (${ref.provider}/${ref.model})`, 3);
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'review', projectId: p.id, signal, temperature: 0.1,
    onEvent: track.onEvent, onDelta: deltaTracker(track, 3, 90, 1500 + 300 * n, 'Nhận xét'),
    messages: [{ role: 'system', content: reviewSystem({ outputLang: p.outputLang }) },
      { role: 'user', content: reviewUser({ contractText: p.workspace.contractText, findings: p.workspace.validation?.issues || [], files: gen }) }]
  });
  track.addCall(r);
  track.stage('Đọc kết quả & gắn nhãn từng file', 95);
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
  await app.projects.updateWorkspace(p.id, { review });
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

/** Lưu đề xuất + phiếu; bản nháp đang chờ cũ của CÙNG file bị thay (khóa theo file). */
async function saveProposal(app, projectId, prop) {
  const p = await app.projects.getProject(projectId);
  const w = p.workspace;
  let ledger = w.ledger || [];
  const keep = [];
  for (const x of w.fixProposals || []) {
    if (x.path === prop.path && x.status === 'pending') {
      if (x.wo) ledger = appendLedger(ledger, { ...x.wo, status: 'superseded', at: Date.now(), note: 'Thay bằng ' + prop.wo.id });
      continue;
    }
    keep.push(x);
  }
  const history = keep.filter((x) => x.status !== 'pending').slice(-30);
  const pending = keep.filter((x) => x.status === 'pending');
  ledger = appendLedger(ledger, { ...prop.wo, at: Date.now() });
  await app.projects.updateWorkspace(projectId, { fixProposals: [...history, ...pending, prop], ledger });
}

/** Tạo 1 ĐỀ XUẤT có PHIẾU CÔNG VIỆC (dùng chung cho Sửa lỗi và Nâng cấp). KHÔNG ghi đè file. */
export async function draftProposal(app, projectId, { step, path, problems, before, raw, truncated, provider, model }) {
  const p = await app.projects.getProject(projectId);
  const after = stripCodeFences(raw || '').replace(/^\n+/, '');
  const syntax = await checkSyntax(path, after);
  const rev = nextRev(p.workspace.ledger, step, path);
  const blocked = truncated || syntax.status === 'fail';
  const wo = {
    id: woId({ projectId, step, path, rev }), step, path, rev, owner: `${provider}/${model}`,
    contractHash: await shortHash(p.workspace.contractText || ''), baseHash: await shortHash(before),
    status: blocked ? 'blocked' : syntax.status === 'pass' ? 'verified' : 'drafted',
    note: truncated ? 'Bản nháp bị cắt' : syntax.status === 'fail' ? 'Lỗi cú pháp: ' + (syntax.message || '') : (problems || [])[0] || ''
  };
  const prop = { path, problems: problems || [], before, after, truncated: !!truncated, syntax, at: Date.now(), status: 'pending', model: wo.owner, wo };
  await saveProposal(app, projectId, prop);
  return prop;
}

/** Sinh ĐỀ XUẤT sửa cho các file có vấn đề. KHÔNG ghi đè file. */
export async function proposeFixes(app, { signal, onlyFiles = null, track = NOOP_TRACK } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const files = await app.projects.filesMap(p.id);
  const by = problemsByFile(p.workspace);
  const targets = Object.keys(by).filter((f) => files[f]?.origin === 'ai' && (!onlyFiles || onlyFiles.includes(f)));
  if (!targets.length) return { status: 'skipped', note: 'Không có vấn đề nào cần sửa' };
  const ref = modelFor(app, 'review');
  let trunc = 0;
  for (let i = 0; i < targets.length; i++) {
    const path = targets[i];
    if (signal?.aborted) throw signal.reason;
    const before = files[path].content;
    const base = (100 * i) / targets.length;
    const span = 100 / targets.length;
    track.stage(`Sửa file ${i + 1}/${targets.length}: ${path} (${ref.provider}/${ref.model})`, base + 1);
    const r = await app.llm.complete({
      provider: ref.provider, model: ref.model, step: `fix:${path}`, projectId: p.id, signal, temperature: 0.1, noCache: true,
      onEvent: track.onEvent, onDelta: deltaTracker(track, base, span, before.length, path),
      messages: [{ role: 'system', content: fixSystem({ outputLang: p.outputLang }) },
        { role: 'user', content: fixUser({ contractText: p.workspace.contractText, path, problems: by[path], code: before, surface: await surfaceOfOthers(files, path) }) }]
    });
    track.addCall(r);
    track.stage(`Kiểm cú pháp & lập phiếu cho ${path}`, base + span * 0.97);
    const prop = await draftProposal(app, p.id, { step: 'fix', path, problems: by[path], before, raw: r.content, truncated: r.truncated, provider: r.provider, model: r.model });
    if (prop.truncated) trunc++;
  }
  await app.reloadProject();
  return { status: 'done', note: `${targets.length} đề xuất chờ duyệt${trunc ? `, ${trunc} bị cắt (không nên chấp nhận)` : ''}` };
}

/** Chấp nhận 1 đề xuất: KIỂM QUY TẮC HỢP NHẤT → ghi đè file → chạy lại cú pháp + nhất quán. */
export async function acceptFix(app, path) {
  const p = await app.projects.getProject(app.state.project.id);
  const list = p.workspace.fixProposals || [];
  const prop = list.find((x) => x.path === path && x.status === 'pending');
  if (!prop) throw new Error('Không có đề xuất đang chờ cho ' + path);
  const cur = await app.projects.getFile(p.id, path);
  let ledger = p.workspace.ledger || [];
  if (!prop.wo) {
    // Đề xuất cũ (tạo trước khi có Ban Điều phối): giữ cách kiểm tra cũ
    if (prop.truncated) throw new Error('Đề xuất này BỊ CẮT — không thể chấp nhận. Hãy tạo lại đề xuất.');
    if (cur?.content !== prop.before) throw new Error('File đã thay đổi sau khi tạo đề xuất — hãy tạo lại đề xuất để tránh ghi đè mất dữ liệu.');
  } else {
    const chk = checkMerge({
      wo: prop.wo, currentContractHash: await shortHash(p.workspace.contractText || ''),
      currentBaseHash: await shortHash(cur?.content ?? ''), syntaxStatus: prop.syntax?.status, truncated: prop.truncated
    });
    if (!chk.ok) {
      ledger = appendLedger(ledger, { ...prop.wo, status: 'blocked', at: Date.now(), note: chk.errors.join(' ') });
      await app.projects.updateWorkspace(p.id, { ledger });
      throw new Error('Ban Điều phối CHẶN hợp nhất: ' + chk.errors.join(' '));
    }
  }
  const contractHash = await shortHash(p.workspace.contractText || '');
  await app.projects.putFile(p.id, path, {
    content: prop.after, truncated: false, checks: { syntax: { ...prop.syntax, at: Date.now() } },
    meta: { ...(cur?.meta || {}), fixedBy: prop.model, fixedAt: Date.now(), woId: prop.wo?.id || null, contractHash }
  });
  prop.status = 'accepted';
  if (prop.wo) ledger = appendLedger(ledger, { ...prop.wo, status: 'merged', at: Date.now(), note: 'Đã hợp nhất vào file' });
  await app.projects.updateWorkspace(p.id, { fixProposals: list, ledger });
  await runChecks(app);
}

export async function rejectFix(app, path) {
  const p = await app.projects.getProject(app.state.project.id);
  const list = p.workspace.fixProposals || [];
  const prop = list.find((x) => x.path === path && x.status === 'pending');
  let ledger = p.workspace.ledger || [];
  if (prop) {
    prop.status = 'rejected';
    if (prop.wo) ledger = appendLedger(ledger, { ...prop.wo, status: 'rejected', at: Date.now(), note: 'Người dùng từ chối' });
  }
  await app.projects.updateWorkspace(p.id, { fixProposals: list, ledger });
  await app.reloadProject();
}
