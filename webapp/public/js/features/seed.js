/**
 * seed.js — Dữ liệu mẫu theo contract.dataSchema; KIỂM TRA entity/field khớp contract; tải JSON/CSV.
 * v2: TỰ SINH CODE NẠP DỮ LIỆU theo nền tảng (người dùng không phải viết code):
 *   - GAS: file SeedData.gs chứa sẵn dữ liệu + hàm aiaLoadSampleData() (chọn hàm → ▶ Chạy).
 *   - Nền tảng có data/seed.json trong danh sách file: ghi đè bằng dữ liệu đã kiểm tra.
 */
import { extractJson } from '../core/parser.js';
import { seedSystem, seedUser } from '../core/prompts.js';
import { toCsv, downloadText } from '../core/exporter.js';
import { filePaths } from '../core/platforms.js';
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

/** Code nạp dữ liệu cho Google Apps Script (hàm thuần, có thể test). */
export function gasSeedLoader(seed, contract) {
  const tables = (contract?.dataSchema || [])
    .filter((e) => Array.isArray(seed?.[e.entity]))
    .map((e) => ({ sheet: e.store || e.entity, fields: (e.fields || []).map((f) => f.name), rows: seed[e.entity] }));
  const idConsts = (contract?.globalConstants || []).map((k) => k.name).filter((n) => /SPREADSHEET|SHEET_ID|DB_ID|SS_ID/i.test(n));
  const constProbe = idConsts.map((n) => `  try { if (!id && typeof ${n} === 'string' && ${n}.length >= 30) id = ${n}; } catch (e) {}`).join('\n');
  return `/**
 * SeedData.gs — DỮ LIỆU MẪU do AI System Architect tự sinh. KHÔNG cần sửa.
 * CÁCH DÙNG: trong trình soạn Apps Script, chọn hàm "aiaLoadSampleData" ở thanh trên cùng → bấm ▶ Chạy.
 * Sheet đã có dữ liệu được GIỮ NGUYÊN. Muốn xóa và nạp lại từ đầu: chạy "aiaReloadSampleData".
 */
var AIA_SEED_TABLES = ${JSON.stringify(tables, null, 2)};

function aiaLoadSampleData() { return aiaSeed_(false); }
function aiaReloadSampleData() { return aiaSeed_(true); }

function aiaFindSpreadsheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = '';
${constProbe}
  var props = PropertiesService.getScriptProperties().getProperties();
  if (!id) id = props.SPREADSHEET_ID || props.SHEET_ID || props.DB_ID || '';
  if (!id) { for (var k in props) { if (/^[\\w-]{30,}$/.test(props[k])) { id = props[k]; break; } } }
  if (id) return SpreadsheetApp.openById(id);
  ss = SpreadsheetApp.create('Du lieu mau - ' + new Date().toISOString().slice(0, 10));
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function aiaSeed_(force) {
  var ss = aiaFindSpreadsheet_();
  var report = [];
  AIA_SEED_TABLES.forEach(function (t) {
    var sh = ss.getSheetByName(t.sheet) || ss.insertSheet(t.sheet);
    if (!force && sh.getLastRow() > 1) { report.push(t.sheet + ': đã có dữ liệu — bỏ qua'); return; }
    sh.clearContents();
    var values = [t.fields].concat(t.rows.map(function (r) {
      return t.fields.map(function (f) {
        var v = r[f];
        if (v === null || v === undefined) return '';
        return typeof v === 'object' ? JSON.stringify(v) : v;
      });
    }));
    sh.getRange(1, 1, values.length, t.fields.length).setValues(values);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, t.fields.length).setFontWeight('bold');
    report.push(t.sheet + ': ' + t.rows.length + ' dòng');
  });
  var msg = 'ĐÃ NẠP DỮ LIỆU MẪU vào: ' + ss.getUrl() + '\\n' + report.join('\\n');
  Logger.log(msg);
  return msg;
}
`;
}

/** Danh sách file nạp dữ liệu cần ghi theo nền tảng: {path: content}. */
export function seedLoaderFiles(platform, fileList, seed, contract) {
  if (platform === 'gas') return { 'SeedData.gs': gasSeedLoader(seed, contract) };
  if ((fileList || []).includes('data/seed.json')) return { 'data/seed.json': JSON.stringify(seed, null, 2) + '\n' };
  return {};
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
  let written = [];
  if (v.valid) {
    const loaders = seedLoaderFiles(p.platform, p.fileList || filePaths(p.platform), ex.value.seed, p.workspace.contract);
    for (const [fp, content] of Object.entries(loaders)) {
      await app.projects.putFile(p.id, fp, { content, origin: 'seed', generatedAt: Date.now(), truncated: false, stale: false, error: null, checks: null, meta: { generator: 'seed-loader' } });
      written.push(fp);
    }
  }
  await app.reloadProject();
  return v.valid
    ? { status: 'done', note: `${Object.keys(ex.value.seed).length} entity${written.length ? ' · đã tạo ' + written.join(', ') : ''}` }
    : { status: 'failed', halt: false, error: `Dữ liệu mẫu lệch schema: ${v.errors.length} lỗi` };
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
