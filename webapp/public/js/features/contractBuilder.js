/**
 * contractBuilder.js — v2.1 "SINH CONTRACT THEO PHẦN NHỎ" (Nhà máy: Phòng Tiêu chuẩn).
 *
 * v2.0 → v2.1: phần "khung" v2.0 vẫn quá dài với dự án nhiều bảng (bị cắt ở 8192 token).
 * CÁCH MỚI (mỗi lần gọi AI chỉ ra một mẩu JSON ngắn):
 *   Phần 1   — KHUNG: tên entity + store, vai trò file, dependencies (KHÔNG có field/hàm/hằng/DOM).
 *   Phần 2.. — FIELD: mỗi lần tối đa ENTITY_BATCH entity.
 *   Phần ..N — TỪNG FILE CODE: hàm + hằng số + DOM id do CHÍNH file đó sở hữu.
 *              File cấu hình/tài liệu (.json, .example, .css, .md…) không gọi AI.
 *   Ghép     — bằng CODE: khử trùng, chuẩn hóa tên/kiểu, ghi cảnh báo ⇒ validateContract().
 *   - Không tự nối JSON (autoContinue:false). Bị cắt ⇒ hỏi lại bản gọn + max_tokens x2 (≤32768).
 *   - Vẫn hỏng ⇒ DỪNG và báo RÕ nguyên nhân (giới hạn đầu ra của model / AI trả JSON sai).
 *   - Phần đã xong nằm trong cache (TTL theo Cài đặt) ⇒ chạy lại không tốn token phần đó.
 * Giữ nguyên 3 hàm export cũ: contractInput, applyContractText, buildContract.
 */
import { extractJson } from '../core/parser.js';
import { validateContract, CONTRACT_SCHEMA_VERSION } from '../core/contract.js';
import { getPlatform, filePaths } from '../core/platforms.js';
import { modelFor } from './models.js';

const langName = (l) => (l === 'en' ? 'English' : 'Vietnamese');
const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'object', 'array', 'id', 'email', 'url', 'enum', 'json', 'text', 'float', 'timestamp', 'phone', 'currency'];
const FIELD_TYPE_SET = new Set(FIELD_TYPES);
const IDENT = /^[A-Za-z_$][\w$]*$/;
const DOM_ID = /^[A-Za-z][\w:.-]*$/;
const ENTITY_BATCH = 4;
const MAX_FUNCTIONS_PER_FILE = 40;
const ESCALATE_CAP = 32768;
const NON_CODE_RE = /(\.json|\.example|\.css|\.scss|\.less|\.md|\.txt|\.ya?ml|\.toml|\.ini|\.env|\.svg|\.lock|\.gitignore)$/i;
const MARKUP_RE = /\.(html?|jsx|tsx|vue|svelte|dart)$/i;
const DEFAULT_NAMING = { functions: 'camelCase', constants: 'UPPER_SNAKE', variables: 'camelCase', domIds: 'kebab-case', tables: 'PascalCase' };

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => typeof v === 'string' && v.trim().length > 0;

export function contractInput(project) {
  const w = project.workspace;
  return { claudeMd: w.claudeMd, skills: (w.skills || []).map((s) => s.filename + ':' + s.name), platform: project.platform, files: project.fileList || filePaths(project.platform), lang: project.outputLang };
}

/** Kiểm tra + lưu contract (dùng chung cho AI sinh và người dùng sửa tay). GIỮ NGUYÊN như bản gốc. */
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

/* ------------------------------------------------------------------ */
/* Prompt từng phần                                                    */
/* ------------------------------------------------------------------ */
function skeletonSystem({ platformId, outputLang, fileList, compact }) {
  const p = getPlatform(platformId);
  const shape = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectName: 'string',
    namingConventions: DEFAULT_NAMING,
    entities: [{ entity: 'Customer', store: 'Customers' }],
    fileResponsibilities: fileList.map((file) => ({ file, role: '...', imports: [] })),
    dependencies: '...'
  };
  return [
    'You are the LEAD SOFTWARE ARCHITECT. This is PART 1 of a multi-part technical contract: the SKELETON (keep it SHORT).',
    'Read the ENTIRE spec, then output ONE strict JSON object ONLY (no markdown, no fences, no comments) with EXACTLY this shape:',
    JSON.stringify(shape),
    '',
    'RULES:',
    `- "schemaVersion" MUST be ${CONTRACT_SCHEMA_VERSION}.`,
    `- FILE NAMES ARE FIXED: ${fileList.join(', ')}. Every file appears exactly once in fileResponsibilities. Never invent file names.`,
    '- "entities": EVERY data entity/table of the spec with ONLY "entity" (PascalCase, singular) and "store" (table/sheet/collection name). NO fields here — fields come in a later part.',
    '- DO NOT output fields, functions, constants or DOM ids — they come in later parts.',
    '- "imports": other files (from the fixed list) this file depends on.',
    compact ? '- BE VERY COMPACT: "role" max 8 words, "dependencies" max 20 words.' : `- "role" max 15 words, "dependencies" max 60 words, written in ${langName(outputLang)}.`,
    `- Platform: ${p.name}. Do not invent features that are not in the spec.`,
    '- Valid JSON only: double-quoted strings, no trailing commas.'
  ].join('\n');
}

function skeletonUser({ claudeMd, skills = [], fileList, platformId }) {
  return [
    'PROJECT SPEC (Claude.md):', claudeMd, '',
    'AI BOT ROLES (context only):', arr(skills).map((s) => `- ${s.filename}: ${s.name}`).join('\n') || '(none)', '',
    `PLATFORM: ${getPlatform(platformId).name}`, `FILES: ${fileList.join(', ')}`, '',
    'Produce PART 1 (skeleton JSON) now.'
  ].join('\n');
}

function fieldsSystem({ compact }) {
  return [
    'You are the LEAD SOFTWARE ARCHITECT. PART 2: define the FIELDS of ONLY the TARGET ENTITIES given by the user.',
    'Output ONE strict JSON object ONLY (no markdown, no fences, no comments) with EXACTLY this shape:',
    JSON.stringify({ dataSchema: [{ entity: 'Customer', fields: [{ name: 'customerId', type: 'id', required: true }] }] }),
    '',
    'RULES:',
    '- Use the EXACT entity names given. Exactly one item per target entity, nothing else.',
    `- Field "type" MUST be one of: ${FIELD_TYPES.join(', ')}.`,
    '- Field names: camelCase, unique inside the entity. NO "desc".',
    '- Include every field the spec needs for this entity (primary id, foreign keys such as roleId, audit fields if the spec requires them).',
    compact ? '- BE VERY COMPACT: only essential fields; omit "required" when false.' : '- Omit "required" when false.',
    '- Valid JSON only: double-quoted strings, no trailing commas.'
  ].join('\n');
}

function fieldsUser({ claudeMd, entities, batch }) {
  return [
    'PROJECT SPEC (Claude.md):', claudeMd, '',
    'ALL ENTITIES (context): ' + entities.map((e) => e.entity).join(', '), '',
    'TARGET ENTITIES: ' + batch.map((e) => `${e.entity} (store: ${e.store})`).join(', '), '',
    'Produce the dataSchema JSON for the TARGET ENTITIES now.'
  ].join('\n');
}

function fileSystem({ platformId, outputLang, file, fileList, compact, markup }) {
  const p = getPlatform(platformId);
  const shape = {
    functions: [{ name: 'getCustomerById', params: ['customerId:string'], returns: 'Customer|null', desc: '...', calledBy: [fileList[0] || file] }],
    globalConstants: [{ name: 'SHEET_CUSTOMERS', value: 'Customers' }],
    domElements: markup ? [{ id: 'btn-save', type: 'button', usedBy: [file] }] : []
  };
  return [
    `You are the LEAD SOFTWARE ARCHITECT. PART 3: define ONLY what is DEFINED (owned) by ONE file: "${file}".`,
    'Output ONE strict JSON object ONLY (no markdown, no fences, no comments) with EXACTLY this shape:',
    JSON.stringify(shape),
    '',
    'RULES:',
    `- Only items whose definition lives in "${file}". NEVER reuse a name or id from the ALREADY ASSIGNED lists.`,
    '- functions: valid camelCase identifiers; "params" = array of "name:type" strings ([] if none); "returns" = type string ("void" if nothing).',
    '- globalConstants: UPPER_SNAKE names declared in this file only ([] if none).',
    markup ? "- domElements: every element id declared in this file's markup; globally unique; kebab-case." : '- domElements MUST be [] (this file has no markup).',
    '- Use ONLY entity/field names from the DATA SCHEMA.',
    `- "calledBy" / "usedBy" values must be from: ${fileList.join(', ')}.`,
    compact ? '- BE VERY COMPACT: "desc" max 6 words; only essential items.' : `- "desc" max 12 words, in ${langName(outputLang)}.`,
    `- At most ${MAX_FUNCTIONS_PER_FILE} functions. Platform: ${p.name}.`,
    "- Cover every feature of the spec that belongs to this file's role. If the file defines nothing, return empty arrays.",
    '- Valid JSON only: double-quoted strings, no trailing commas.'
  ].join('\n');
}

function fileUser({ claudeMd, skeleton, dataSchema, file, assigned }) {
  const frs = arr(skeleton.fileResponsibilities).filter((r) => r && str(r.file));
  const role = frs.find((r) => r.file === file)?.role || '';
  const schemaText = dataSchema.map((e) => `${e.entity} (${e.store}): ${arr(e.fields).map((f) => `${f.name}:${f.type}`).join(', ')}`).join('\n');
  const list = (xs, key) => (xs.length ? xs.map((a) => `${a[key]}→${a.file}`).join(', ') : '(none)');
  return [
    'PROJECT SPEC (Claude.md):', claudeMd, '',
    'FILES & ROLES:', frs.map((r) => `- ${r.file}: ${r.role || ''}`).join('\n'), '',
    'DATA SCHEMA (fixed — use exactly):', schemaText, '',
    'ALREADY ASSIGNED (do NOT redefine):',
    'functions: ' + list(assigned.functions, 'name'),
    'constants: ' + list(assigned.constants, 'name'),
    'dom ids: ' + list(assigned.dom, 'id'), '',
    `TARGET FILE: ${file}${role ? ` — role: ${role}` : ''}`,
    'Produce the JSON for this file now.'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Ghép các phần bằng code (hàm thuần, không gọi AI)                   */
/* ------------------------------------------------------------------ */
export function mergeContractParts(skeleton, partsByFile, fileList) {
  const warnings = [];
  const inList = (f) => typeof f === 'string' && fileList.includes(f);
  const markupFile = fileList.find((f) => MARKUP_RE.test(f)) || fileList[0];

  // dataSchema
  const entities = [];
  const seenEnt = new Set();
  for (const ent of arr(skeleton.dataSchema)) {
    if (!ent || !str(ent.entity)) continue;
    const name = ent.entity.trim();
    if (seenEnt.has(name)) { warnings.push(`Entity "${name}" trùng — giữ bản đầu.`); continue; }
    seenEnt.add(name);
    const seenF = new Set();
    const fields = [];
    for (const fd of arr(ent.fields)) {
      if (!fd || !str(fd.name)) continue;
      const fname = fd.name.trim();
      if (!IDENT.test(fname)) { warnings.push(`Field "${name}.${fname}" có tên không hợp lệ — bỏ.`); continue; }
      if (seenF.has(fname)) continue;
      seenF.add(fname);
      let type = str(fd.type) ? fd.type.trim().toLowerCase() : 'string';
      if (!FIELD_TYPE_SET.has(type)) { warnings.push(`Field "${name}.${fname}" có kiểu "${fd.type}" lạ — đổi thành "string".`); type = 'string'; }
      const item = { name: fname, type };
      if (fd.required === true) item.required = true;
      if (str(fd.desc)) item.desc = fd.desc;
      fields.push(item);
    }
    if (!fields.length) { warnings.push(`Entity "${name}" không có field — tạm thêm "id".`); fields.push({ name: 'id', type: 'id', required: true }); }
    entities.push({ entity: name, store: str(ent.store) ? ent.store.trim() : name, fields });
  }

  // chuẩn hóa các phần theo file
  const parts = {};
  for (const file of fileList) {
    const raw = partsByFile[file];
    parts[file] = Array.isArray(raw) ? { functions: raw } : raw && typeof raw === 'object' ? raw : {};
  }

  // globalConstants
  const constants = [];
  const constNames = new Set();
  const addConst = (k, file) => {
    if (!k || !str(k.name)) return;
    const name = k.name.trim();
    if (!IDENT.test(name)) { warnings.push(`Hằng "${name}" có tên không hợp lệ — bỏ.`); return; }
    if (constNames.has(name)) return;
    let f = file;
    if (!inList(f)) { warnings.push(`Hằng "${name}" có file "${f}" không hợp lệ — gán cho ${fileList[0]}.`); f = fileList[0]; }
    constNames.add(name);
    const item = { name, file: f };
    if (k.value !== undefined) item.value = k.value;
    if (str(k.desc)) item.desc = k.desc;
    constants.push(item);
  };
  for (const k of arr(skeleton.globalConstants)) addConst(k, k && k.file);
  for (const file of fileList) for (const k of arr(parts[file].globalConstants)) addConst(k, file);

  // functions — file chủ = file của phần đó
  const functions = [];
  const fnOwner = new Map();
  for (const file of fileList) {
    for (const fn of arr(parts[file].functions)) {
      if (!fn || !str(fn.name)) continue;
      const name = fn.name.trim();
      if (!IDENT.test(name)) { warnings.push(`Hàm "${name}" có tên không hợp lệ — bỏ.`); continue; }
      if (fnOwner.has(name)) { warnings.push(`Hàm "${name}" khai báo lại ở ${file} (đã thuộc ${fnOwner.get(name)}) — giữ bản đầu.`); continue; }
      if (constNames.has(name)) { warnings.push(`"${name}" trùng tên hằng số — bỏ hàm ở ${file}.`); continue; }
      fnOwner.set(name, file);
      const params = arr(fn.params).map((x) => (typeof x === 'string' ? x : x && str(x.name) ? `${x.name}:${x.type || 'any'}` : String(x)));
      const item = { name, file, params, returns: str(fn.returns) ? fn.returns.trim() : 'void' };
      if (str(fn.desc)) item.desc = fn.desc;
      item.calledBy = arr(fn.calledBy).filter(inList);
      functions.push(item);
    }
  }

  // domElements
  const dom = [];
  const seenDom = new Set();
  const addDom = (d, file) => {
    if (!d || !str(d.id)) return;
    const id = d.id.trim();
    if (!DOM_ID.test(id)) { warnings.push(`DOM id "${id}" không hợp lệ — bỏ.`); return; }
    if (seenDom.has(id)) return;
    seenDom.add(id);
    let f = file;
    if (!inList(f)) { warnings.push(`DOM id "${id}" có file "${f}" không hợp lệ — gán cho ${markupFile}.`); f = markupFile; }
    const item = { id, file: f, usedBy: arr(d.usedBy).filter(inList) };
    if (str(d.type)) item.type = d.type;
    if (str(d.desc)) item.desc = d.desc;
    dom.push(item);
  };
  for (const d of arr(skeleton.domElements)) addDom(d, d && d.file);
  for (const file of fileList) for (const d of arr(parts[file].domElements)) addDom(d, file);

  // fileResponsibilities — đủ mọi file, exposes = hàm file đó sở hữu
  const frMap = new Map();
  for (const r of arr(skeleton.fileResponsibilities)) if (r && inList(r.file) && !frMap.has(r.file)) frMap.set(r.file, r);
  const fileResponsibilities = fileList.map((file) => {
    const r = frMap.get(file);
    if (!r) warnings.push(`File "${file}" thiếu mô tả vai trò — đã thêm chỗ trống.`);
    return {
      file,
      role: r && str(r.role) ? r.role : '(chưa mô tả)',
      exposes: functions.filter((f) => f.file === file).map((f) => f.name),
      imports: r ? arr(r.imports).filter((x) => inList(x) && x !== file) : []
    };
  });

  const nc = skeleton.namingConventions;
  const contract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectName: str(skeleton.projectName) ? skeleton.projectName : 'Project',
    namingConventions: nc && typeof nc === 'object' && !Array.isArray(nc) ? { ...DEFAULT_NAMING, ...nc } : { ...DEFAULT_NAMING },
    dataSchema: entities,
    globalConstants: constants,
    functions,
    domElements: dom,
    fileResponsibilities,
    dependencies: str(skeleton.dependencies) ? skeleton.dependencies : ''
  };
  return { contract, warnings };
}

/* ------------------------------------------------------------------ */
/* Gọi AI cho 1 phần                                                   */
/* ------------------------------------------------------------------ */
function note(app, text) {
  try { app.state.liveNote = text; } catch (_e) { /* UI không bắt buộc */ }
}

async function askJson(app, base, { sys, usr, step, maxTokens }) {
  const r = await app.llm.complete({ ...base, step, maxTokens, autoContinue: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] });
  if (r.truncated) return { status: 'truncated', r };
  const ex = extractJson(r.content);
  if (!ex.ok) return { status: 'bad-json', r, error: ex.error };
  if (!ex.value || typeof ex.value !== 'object' || Array.isArray(ex.value)) return { status: 'bad-json', r, error: 'Kết quả không phải object JSON' };
  return { status: 'ok', r, value: ex.value };
}

/** Lần 1 bình thường; hỏng ⇒ lần 2 bản gọn (+ max_tokens x2 nếu bị cắt). Model từ chối max_tokens lớn ⇒ về mức cũ. */
async function askPart(app, base, { makeSys, usr, step, label, maxTokens }) {
  let a = await askJson(app, base, { sys: makeSys(false), usr, step, maxTokens });
  if (a.status === 'ok') return a;
  const why = a.status === 'truncated' ? 'bị cắt (chạm max_tokens)' : `JSON lỗi: ${a.error}`;
  const bigger = a.status === 'truncated' ? Math.max(maxTokens, Math.min(ESCALATE_CAP, maxTokens * 2)) : maxTokens;
  note(app, `${label}: lần 1 ${why} — đang hỏi lại bản gọn hơn (max_tokens=${bigger})…`);
  try { await app.logger?.warn?.('contract', `${label}: lần 1 ${why} — hỏi lại bản gọn, max_tokens=${bigger}.`, { step }); } catch (_e) { /* bỏ qua */ }
  const extra = a.status === 'bad-json' ? `\n\nNOTE: your previous answer was not valid JSON (${a.error}). Output ONLY one valid JSON object.` : '';
  const sys2 = makeSys(true) + extra;
  let used = bigger;
  try {
    a = await askJson(app, base, { sys: sys2, usr, step: step + '-retry', maxTokens: bigger });
  } catch (e) {
    if (bigger !== maxTokens && e && e.status === 400) {
      used = maxTokens;
      a = await askJson(app, base, { sys: sys2, usr, step: step + '-retry', maxTokens });
    } else throw e;
  }
  a.maxTokensUsed = used;
  return a;
}

function failText(a, label) {
  const who = a.r ? `${a.r.provider}/${a.r.model}` : 'model';
  if (a.status === 'truncated') {
    return `${label} vẫn BỊ CẮT dù đã yêu cầu viết gọn và dùng max_tokens=${a.maxTokensUsed}. NGUYÊN NHÂN: GIỚI HẠN ĐẦU RA của ${who} — KHÔNG phải lỗi code. Nếu đây là model "suy luận" (reasoning/thinking), phần suy nghĩ cũng tính vào max_tokens ⇒ hãy chọn model KHÔNG suy luận cho bước Contract rồi bấm ↻.`;
  }
  return `${label}: AI trả JSON không hợp lệ 2 lần liên tiếp (${a.error}). Đây là lỗi chất lượng đầu ra của ${who} — hãy chọn model khác cho bước Contract rồi bấm ↻.`;
}

async function saveFailure(app, projectId, a, message) {
  await app.projects.updateWorkspace(projectId, {
    contractText: (a.r && a.r.content) || '',
    contract: null,
    contractValidation: { valid: false, errors: [{ path: '$', message }], warnings: [], at: Date.now(), source: 'ai' }
  });
  await app.reloadProject();
}

/* ------------------------------------------------------------------ */
/* Hàm chính                                                           */
/* ------------------------------------------------------------------ */
export async function buildContract(app, { signal, onDelta, onEvent } = {}) {
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  if (!w.claudeMd) throw new Error('Chưa có Claude.md — chạy bước Kiến trúc trước.');
  const ref = modelFor(app, 'contract');
  const fileList = p.fileList || filePaths(p.platform);
  const maxTokens = Number(app.settings.get().maxTokens) || 8192;
  const base = { provider: ref.provider, model: ref.model, projectId: p.id, temperature: 0.2, signal, onDelta, onEvent };
  const fail = async (a, label) => {
    const msg = failText(a, label);
    await saveFailure(app, p.id, a, msg);
    return { status: a.status === 'truncated' ? 'truncated' : 'failed', halt: true, error: msg, note: msg };
  };

  // ---- Phần 1: khung ----
  const skLabel = 'Contract · phần 1 (khung: danh sách dữ liệu & vai trò file)';
  note(app, skLabel);
  const sk = await askPart(app, base, {
    makeSys: (compact) => skeletonSystem({ platformId: p.platform, outputLang: p.outputLang, fileList, compact }),
    usr: skeletonUser({ claudeMd: w.claudeMd, skills: w.skills, fileList, platformId: p.platform }),
    step: 'contract-skeleton', label: skLabel, maxTokens
  });
  if (sk.status !== 'ok') return fail(sk, skLabel);
  const skeleton = sk.value;

  // Danh sách entity (chấp nhận cả "entities" lẫn "dataSchema" nếu AI trả kiểu cũ)
  const entities = [];
  const seen = new Set();
  for (const e of [...arr(skeleton.entities), ...arr(skeleton.dataSchema)]) {
    if (!e || !str(e.entity) || seen.has(e.entity.trim())) continue;
    seen.add(e.entity.trim());
    entities.push({ entity: e.entity.trim(), store: str(e.store) ? e.store.trim() : e.entity.trim(), fields: arr(e.fields) });
  }
  if (!entities.length) {
    const msg = 'Contract phần 1: AI không liệt kê bảng dữ liệu nào (entities) — hãy kiểm tra Claude.md có mô tả dữ liệu, hoặc đổi model rồi bấm ↻.';
    await saveFailure(app, p.id, sk, msg);
    return { status: 'failed', halt: true, error: msg };
  }

  const batches = [];
  for (let i = 0; i < entities.length; i += ENTITY_BATCH) batches.push(entities.slice(i, i + ENTITY_BATCH));
  const codeFiles = fileList.filter((f) => !NON_CODE_RE.test(f));
  const total = 1 + batches.length + codeFiles.length;
  let n = 1;

  // ---- Phần 2: field theo nhóm entity ----
  const dataSchema = [];
  for (const batch of batches) {
    n++;
    const names = batch.map((e) => e.entity);
    const label = `Contract · phần ${n}/${total} (dữ liệu: ${names.join(', ')})`;
    note(app, label);
    const part = await askPart(app, base, {
      makeSys: (compact) => fieldsSystem({ compact }),
      usr: fieldsUser({ claudeMd: w.claudeMd, entities, batch }),
      step: 'contract-fields:' + names.join(','), label, maxTokens
    });
    if (part.status !== 'ok') return fail(part, label);
    const got = arr(part.value.dataSchema);
    for (const ent of batch) {
      const m = got.find((x) => x && x.entity === ent.entity) || got.find((x) => x && String(x.entity || '').toLowerCase() === ent.entity.toLowerCase());
      dataSchema.push({ entity: ent.entity, store: ent.store, fields: arr(m && m.fields).length ? m.fields : ent.fields });
    }
  }

  // ---- Phần 3: từng file code ----
  const partsByFile = {};
  const assigned = { functions: [], constants: [], dom: [] };
  for (const file of fileList) {
    if (NON_CODE_RE.test(file)) { partsByFile[file] = { functions: [], globalConstants: [], domElements: [] }; continue; }
    n++;
    const markup = MARKUP_RE.test(file);
    const label = `Contract · phần ${n}/${total} (hàm của ${file})`;
    note(app, label);
    const part = await askPart(app, base, {
      makeSys: (compact) => fileSystem({ platformId: p.platform, outputLang: p.outputLang, file, fileList, compact, markup }),
      usr: fileUser({ claudeMd: w.claudeMd, skeleton, dataSchema, file, assigned }),
      step: 'contract-file:' + file, label, maxTokens
    });
    if (part.status !== 'ok') return fail(part, label);
    const own = (x) => x && (!str(x.file) || x.file === file); // bỏ mục AI gán cho file khác
    const fns = arr(part.value.functions).filter(own).slice(0, MAX_FUNCTIONS_PER_FILE);
    const consts = arr(part.value.globalConstants).filter(own);
    const doms = markup ? arr(part.value.domElements).filter(own) : [];
    partsByFile[file] = { functions: fns, globalConstants: consts, domElements: doms };
    for (const x of fns) if (str(x.name)) assigned.functions.push({ name: x.name.trim(), file });
    for (const x of consts) if (str(x.name)) assigned.constants.push({ name: x.name.trim(), file });
    for (const x of doms) if (str(x.id)) assigned.dom.push({ id: x.id.trim(), file });
  }

  // ---- Ghép bằng code + kiểm tra ----
  note(app, 'Contract: đang ghép các phần và kiểm tra schema');
  const { contract, warnings } = mergeContractParts({ ...skeleton, dataSchema }, partsByFile, fileList);
  const v = await applyContractText(app, p.id, JSON.stringify(contract, null, 2));
  if (warnings.length) {
    const cur = await app.projects.getProject(p.id);
    const cv = cur.workspace.contractValidation || {};
    await app.projects.updateWorkspace(p.id, { contractValidation: { ...cv, warnings: [...arr(cv.warnings), ...warnings.map((m) => ({ path: 'ghép', message: m }))] } });
    await app.reloadProject();
  }
  if (!v.valid) {
    const first = v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(' | ');
    return { status: 'failed', halt: true, error: `Contract ghép xong nhưng còn ${v.errors.length} lỗi schema (${first}). Mở tab "Contract" để xem/sửa tay, hoặc bấm ↻.` };
  }
  return { status: 'done', note: `${total} phần · ${dataSchema.length} bảng · ${contract.functions.length} hàm · ${v.warnings.length + warnings.length} cảnh báo` };
}
