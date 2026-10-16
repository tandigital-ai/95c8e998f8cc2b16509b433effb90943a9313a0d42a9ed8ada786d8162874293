/**
 * seed.js — Dữ liệu mẫu theo contract.dataSchema; KIỂM TRA entity/field khớp contract; tải JSON/CSV.
 * Port buildSeedData (bản GAS không kiểm tra gì, parse lỗi trả {} im lặng).
 */
import { extractJson } from '../core/parser.js';
import { seedSystem, seedUser } from '../core/prompts.js';
import { toCsv, downloadText } from '../core/exporter.js';
import { modelFor } from './models.js';

/** Kiểm tra seed so với dataSchema. Hàm thuần. */
export function validateSeed(seed, contract) {
  const errors = [];
  const warnings = [];
  const schema = new Map((contract?.dataSchema || []).map((e) => [e.entity, e]));
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return { valid: false, errors: ['seed phải là object {Entity: [rows]}'], warnings };
  for (const [entity, rows] of Object.entries(seed)) {
    const def = schema.get(entity);
    if (!def) { errors.push(`Entity "${entity}" không có trong dataSchema.`); continue; }
    if (!Array.isArray(rows)) { errors.push(`"${entity}" phải là mảng.`); continue; }
    if (!rows.length) warnings.push(`"${entity}" không có dòng nào.`);
    const fields = new Set((def.fields || []).map((f) => f.name));
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object') { errors.push(`${entity}[${i}] không phải object.`); return; }
      const extra = Object.keys(row).filter((k) => !fields.has(k));
      const missing = [...fields].filter((k) => !(k in row));
      if (extra.length) errors.push(`${entity}[${i}] có trường ngoài schema: ${extra.join(', ')}`);
      if (missing.length) warnings.push(`${entity}[${i}] thiếu trường: ${missing.join(', ')}`);
    });
  }
  for (const name of schema.keys()) if (!(name in seed)) warnings.push(`Không có dữ liệu mẫu cho entity "${name}".`);
  return { valid: errors.length === 0, errors, warnings };
}

export async function buildSeed(app, { signal } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  if (!p.workspace.contract) return { status: 'failed', halt: false, error: 'Chưa có Contract hợp lệ.' };
  const ref = modelFor(app, 'seed');
  const r = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'seed', projectId: p.id, signal, temperature: 0.6,
    messages: [{ role: 'system', content: seedSystem({ outputLang: p.outputLang }) }, { role: 'user', content: seedUser({ contractText: p.workspace.contractText }) }]
  });
  if (r.truncated) {
    await app.projects.updateWorkspace(p.id, { seed: null, seedValidation: { valid: false, errors: ['Phản hồi bị cắt (finish_reason=length).'], warnings: [], raw: r.content } });
    await app.reloadProject();
    return { status: 'truncated', note: 'dữ liệu mẫu bị cắt' };
  }
  const ex = extractJson(r.content);
  if (!ex.ok || !ex.value.seed) {
    await app.projects.updateWorkspace(p.id, { seed: null, seedValidation: { valid: false, errors: [ex.ok ? 'JSON thiếu khóa "seed".' : ex.error], warnings: [], raw: r.content } });
    await app.reloadProject();
    return { status: 'failed', halt: false, error: 'Dữ liệu mẫu không phải JSON hợp lệ.' };
  }
  const v = validateSeed(ex.value.seed, p.workspace.contract);
  await app.projects.updateWorkspace(p.id, { seed: ex.value, seedValidation: { ...v, at: Date.now() } });
  await app.reloadProject();
  return v.valid ? { status: 'done', note: `${Object.keys(ex.value.seed).length} entity` } : { status: 'failed', halt: false, error: `Dữ liệu mẫu lệch schema: ${v.errors.length} lỗi` };
}

export function downloadSeedJson(seed, name = 'seed') {
  downloadText(`${name}.json`, JSON.stringify(seed, null, 2), 'application/json');
}

export function downloadSeedCsv(seed, contract, name = 'seed') {
  for (const [entity, rows] of Object.entries(seed?.seed || {})) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const def = (contract?.dataSchema || []).find((e) => e.entity === entity);
    const cols = (def?.fields?.map((f) => f.name) || Object.keys(rows[0])).map((k) => ({ key: k, get: (r) => (r[k] !== null && typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]) }));
    downloadText(`${name}_${entity}.csv`, toCsv(rows, cols), 'text/csv;charset=utf-8');
  }
}
