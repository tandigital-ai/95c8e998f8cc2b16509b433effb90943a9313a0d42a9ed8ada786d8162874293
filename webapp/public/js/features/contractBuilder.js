/**
 * contractBuilder.js — Sinh Project Contract và KIỂM TRA SCHEMA.
 * Không hợp lệ ⇒ (1) tự gửi lại lỗi cho AI sửa đúng 1 lần, (2) vẫn sai ⇒ DỪNG pipeline,
 * hiện lỗi cụ thể, cho sửa tay JSON hoặc sinh lại. (Bản GAS: parse lỗi vẫn đi tiếp.)
 */
import { extractJson } from '../core/parser.js';
import { validateContract } from '../core/contract.js';
import { contractSystem, contractUser, contractRepairUser } from '../core/prompts.js';
import { filePaths } from '../core/platforms.js';
import { modelFor } from './models.js';

export function contractInput(project) {
  const w = project.workspace;
  return { claudeMd: w.claudeMd, skills: (w.skills || []).map((s) => s.filename + ':' + s.name), platform: project.platform, files: project.fileList || filePaths(project.platform), lang: project.outputLang };
}

/** Kiểm tra + lưu contract (dùng chung cho AI sinh và người dùng sửa tay). */
export async function applyContractText(app, projectId, text, { source = 'ai' } = {}) {
  const p = await app.projects.getProject(projectId);
  const fileList = p.fileList || filePaths(p.platform);
  const ex = extractJson(text);
  let validation;
  if (!ex.ok) validation = { valid: false, errors: [{ path: '$', message: ex.error + (ex.line ? ` (dòng ${ex.line}, cột ${ex.column})` : '') }], warnings: [] };
  else validation = validateContract(ex.value, { fileList });
  const prevText = p.workspace.contractText;
  const changed = prevText && prevText !== (ex.ok ? JSON.stringify(validation.normalized || ex.value, null, 2) : text);
  await app.projects.updateWorkspace(projectId, {
    contract: validation.valid ? validation.normalized : null,
    contractText: ex.ok ? JSON.stringify(ex.value, null, 2) : text,
    contractValidation: { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, at: Date.now(), source },
    contractStale: false
  });
  if (changed && validation.valid) {
    const n = await app.projects.markStale(projectId, 'Contract đã thay đổi');
    if (n) app.toast(`Contract thay đổi ⇒ ${n} file đã sinh được đánh dấu "Cũ — cần sinh lại".`, 'warn');
  }
  await app.reloadProject();
  return validation;
}

export async function buildContract(app, { signal, onDelta, onEvent } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  if (!w.claudeMd) throw new Error('Chưa có Claude.md — chạy bước Kiến trúc trước.');
  const ref = modelFor(app, 'contract');
  const fileList = p.fileList || filePaths(p.platform);
  const sys = contractSystem({ platformId: p.platform, outputLang: p.outputLang, fileList });
  const usr = contractUser({ claudeMd: w.claudeMd, skills: w.skills, fileList, platformId: p.platform });
  const base = { provider: ref.provider, model: ref.model, step: 'contract', projectId: p.id, temperature: 0.2, signal, onDelta, onEvent };
  let r = await app.llm.complete({ ...base, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] });
  if (r.truncated) {
    await app.projects.updateWorkspace(p.id, { contractText: r.content, contract: null, contractValidation: { valid: false, errors: [{ path: '$', message: `Contract BỊ CẮT sau ${r.rounds} vòng (finish_reason=length).` }], warnings: [], at: Date.now(), source: 'ai' } });
    await app.reloadProject();
    return { status: 'truncated', halt: true, error: 'Contract bị cắt — không thể dùng. Hãy chọn model có đầu ra dài hơn hoặc tăng max_tokens.' };
  }
  let v = await applyContractText(app, p.id, r.content);
  if (!v.valid) {
    app.toast(`Contract chưa đạt schema (${v.errors.length} lỗi) — đang yêu cầu AI sửa 1 lần…`, 'warn');
    onEvent?.({ type: 'repair', errors: v.errors.length });
    r = await app.llm.complete({ ...base, step: 'contract-repair', messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }, { role: 'assistant', content: r.content }, { role: 'user', content: contractRepairUser({ previousText: r.content, errors: v.errors }) }] });
    if (!r.truncated) v = await applyContractText(app, p.id, r.content);
  }
  if (!v.valid) return { status: 'failed', halt: true, error: `Contract không hợp lệ (${v.errors.length} lỗi). Pipeline DỪNG. Mở tab "Contract" để xem lỗi, sửa tay hoặc sinh lại.` };
  return { status: 'done', note: `${v.warnings.length} cảnh báo` };
}
