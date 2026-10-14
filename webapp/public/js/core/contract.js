/**
 * contract.js — Project Contract: nguồn sự thật chung cho mọi file.
 * Validator tự viết (không phụ thuộc thư viện). Contract KHÔNG hợp lệ => pipeline DỪNG.
 *
 * Schema (schemaVersion 1):
 * {
 *   schemaVersion: 1,
 *   projectName: string,
 *   namingConventions: { functions, constants, variables, domIds, tables },
 *   dataSchema: [ { entity, store, fields: [ {name, type, desc?, required?} ] } ],
 *   globalConstants: [ { name, value?, file, desc? } ],
 *   functions: [ { name, file, params: string[], returns, desc?, calledBy?: string[] } ],
 *   domElements: [ { id, type?, file, usedBy?: string[], desc? } ],
 *   fileResponsibilities: [ { file, role, exposes?: string[], imports?: string[] } ],
 *   dependencies: string
 * }
 */

export const CONTRACT_SCHEMA_VERSION = 1;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const DOM_ID = /^[A-Za-z][\w:.-]*$/;
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'object', 'array', 'id', 'email', 'url', 'enum', 'json', 'text', 'float', 'timestamp', 'phone', 'currency']);

/** Mô tả schema dạng JSON (để đưa vào prompt + tài liệu). */
export const CONTRACT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ProjectContract',
  type: 'object',
  required: ['schemaVersion', 'projectName', 'namingConventions', 'dataSchema', 'functions', 'fileResponsibilities'],
  properties: {
    schemaVersion: { const: CONTRACT_SCHEMA_VERSION },
    projectName: { type: 'string', minLength: 1 },
    namingConventions: { type: 'object' },
    dataSchema: { type: 'array', minItems: 1, items: { type: 'object', required: ['entity', 'fields'], properties: { entity: { type: 'string' }, store: { type: 'string' }, fields: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'type'] } } } } },
    globalConstants: { type: 'array', items: { type: 'object', required: ['name', 'file'] } },
    functions: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'file', 'params', 'returns'] } },
    domElements: { type: 'array', items: { type: 'object', required: ['id', 'file'] } },
    fileResponsibilities: { type: 'array', minItems: 1, items: { type: 'object', required: ['file', 'role'] } },
    dependencies: { type: 'string' }
  }
};

/** Ví dụ ngắn gọn đưa vào prompt (khung, không phải dữ liệu thật). */
export function contractTemplate(fileList) {
  const f0 = fileList[0] || 'main.js';
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectName: 'string',
    namingConventions: { functions: 'camelCase', constants: 'UPPER_SNAKE', variables: 'camelCase', domIds: 'kebab-case', tables: 'PascalCase' },
    dataSchema: [{ entity: 'Customer', store: 'Customers', fields: [{ name: 'customerId', type: 'id', desc: '...', required: true }] }],
    globalConstants: [{ name: 'SHEET_CUSTOMERS', value: 'Customers', file: f0, desc: '...' }],
    functions: [{ name: 'getCustomerById', file: f0, params: ['customerId:string'], returns: 'Customer|null', desc: '...', calledBy: [] }],
    domElements: [{ id: 'btn-save', type: 'button', file: f0, usedBy: [], desc: '...' }],
    fileResponsibilities: fileList.map((file) => ({ file, role: '...', exposes: [], imports: [] })),
    dependencies: 'mô tả đồ thị gọi hàm giữa các file'
  };
}

/**
 * Kiểm tra contract. Trả {valid, errors[], warnings[], normalized}.
 * errors/warnings: {path, message}
 * @param {any} c
 * @param {{fileList:string[]}} opts
 */
export function validateContract(c, { fileList = [] } = {}) {
  const errors = [];
  const warnings = [];
  const E = (path, message) => errors.push({ path, message });
  const W = (path, message) => warnings.push({ path, message });
  const files = new Set(fileList);

  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    E('$', 'Contract phải là một object JSON.');
    return { valid: false, errors, warnings, normalized: null };
  }
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const arr = (v) => (Array.isArray(v) ? v : null);

  // schemaVersion
  if (c.schemaVersion === undefined) W('schemaVersion', `Thiếu schemaVersion — coi là ${CONTRACT_SCHEMA_VERSION}.`);
  else if (c.schemaVersion !== CONTRACT_SCHEMA_VERSION) E('schemaVersion', `schemaVersion phải là ${CONTRACT_SCHEMA_VERSION} (nhận ${JSON.stringify(c.schemaVersion)}).`);

  if (!isStr(c.projectName)) E('projectName', 'Thiếu projectName (chuỗi không rỗng).');
  if (!c.namingConventions || typeof c.namingConventions !== 'object' || Array.isArray(c.namingConventions)) E('namingConventions', 'Thiếu namingConventions (object).');

  const checkFile = (path, file) => {
    if (!isStr(file)) { E(path, 'Thiếu "file".'); return; }
    if (files.size && !files.has(file)) E(path, `File "${file}" không nằm trong danh sách file cố định: ${[...files].join(', ')}`);
  };

  // dataSchema
  const ds = arr(c.dataSchema);
  const entityNames = new Set();
  const allFields = new Set();
  if (!ds || !ds.length) E('dataSchema', 'dataSchema phải là mảng có ít nhất 1 entity.');
  else ds.forEach((ent, i) => {
    const p = `dataSchema[${i}]`;
    if (!ent || typeof ent !== 'object') { E(p, 'Entity phải là object.'); return; }
    if (!isStr(ent.entity)) E(`${p}.entity`, 'Thiếu tên entity.');
    else if (entityNames.has(ent.entity)) E(`${p}.entity`, `Entity "${ent.entity}" bị khai báo trùng.`);
    else entityNames.add(ent.entity);
    const fl = arr(ent.fields);
    if (!fl || !fl.length) { E(`${p}.fields`, 'Entity phải có ít nhất 1 field.'); return; }
    const seen = new Set();
    fl.forEach((fd, j) => {
      const fp = `${p}.fields[${j}]`;
      if (!fd || !isStr(fd.name)) { E(fp, 'Field thiếu "name".'); return; }
      if (!IDENT.test(fd.name)) W(`${fp}.name`, `Tên field "${fd.name}" không phải định danh hợp lệ.`);
      if (seen.has(fd.name)) E(`${fp}.name`, `Field "${fd.name}" trùng trong entity ${ent.entity}.`);
      seen.add(fd.name);
      allFields.add(fd.name);
      if (!isStr(fd.type)) E(`${fp}.type`, `Field "${fd.name}" thiếu "type".`);
      else if (!FIELD_TYPES.has(String(fd.type).toLowerCase().replace(/\[\]$/, '').split(/[|<(]/)[0].trim())) W(`${fp}.type`, `Kiểu "${fd.type}" không thuộc danh sách quen thuộc.`);
    });
  });

  // functions
  const fns = arr(c.functions);
  const fnOwner = new Map();
  if (!fns || !fns.length) E('functions', 'functions phải là mảng có ít nhất 1 hàm.');
  else fns.forEach((fn, i) => {
    const p = `functions[${i}]`;
    if (!fn || typeof fn !== 'object') { E(p, 'Hàm phải là object.'); return; }
    if (!isStr(fn.name)) { E(`${p}.name`, 'Thiếu tên hàm.'); return; }
    if (!IDENT.test(fn.name)) E(`${p}.name`, `Tên hàm "${fn.name}" không hợp lệ.`);
    checkFile(`${p}.file`, fn.file);
    if (fnOwner.has(fn.name)) E(`${p}.name`, `Hàm "${fn.name}" có nhiều file chủ: ${fnOwner.get(fn.name)} và ${fn.file} (mỗi hàm chỉ được có ĐÚNG 1 file chủ).`);
    else fnOwner.set(fn.name, fn.file);
    if (!Array.isArray(fn.params)) E(`${p}.params`, `Hàm "${fn.name}": params phải là mảng (có thể rỗng).`);
    else if (fn.params.some((x) => typeof x !== 'string')) E(`${p}.params`, `Hàm "${fn.name}": mỗi param là chuỗi "ten:kieu".`);
    if (!isStr(fn.returns)) E(`${p}.returns`, `Hàm "${fn.name}" thiếu "returns" (dùng "void" nếu không trả gì).`);
    if (fn.calledBy !== undefined && !Array.isArray(fn.calledBy)) E(`${p}.calledBy`, 'calledBy phải là mảng.');
    else (fn.calledBy || []).forEach((cf, k) => { if (files.size && !files.has(cf)) W(`${p}.calledBy[${k}]`, `"${cf}" không thuộc danh sách file.`); });
  });

  // globalConstants
  const consts = c.globalConstants === undefined ? [] : arr(c.globalConstants);
  if (!consts) E('globalConstants', 'globalConstants phải là mảng.');
  else {
    const seen = new Map();
    consts.forEach((k, i) => {
      const p = `globalConstants[${i}]`;
      if (!k || !isStr(k.name)) { E(p, 'Hằng số thiếu "name".'); return; }
      if (!IDENT.test(k.name)) E(`${p}.name`, `Tên hằng "${k.name}" không hợp lệ.`);
      if (seen.has(k.name)) E(`${p}.name`, `Hằng "${k.name}" khai báo trùng (${seen.get(k.name)} và ${k.file}).`);
      seen.set(k.name, k.file);
      if (k.file === undefined) W(`${p}.file`, `Hằng "${k.name}" không có file chủ.`);
      else checkFile(`${p}.file`, k.file);
      if (fnOwner.has(k.name)) E(`${p}.name`, `"${k.name}" vừa là hàm vừa là hằng.`);
    });
  }

  // domElements
  const dom = c.domElements === undefined ? [] : arr(c.domElements);
  if (!dom) E('domElements', 'domElements phải là mảng.');
  else {
    const seen = new Set();
    dom.forEach((d, i) => {
      const p = `domElements[${i}]`;
      if (!d || !isStr(d.id)) { E(p, 'Phần tử DOM thiếu "id".'); return; }
      if (!DOM_ID.test(d.id)) E(`${p}.id`, `DOM id "${d.id}" không hợp lệ.`);
      if (seen.has(d.id)) E(`${p}.id`, `DOM id "${d.id}" bị trùng (DOM id phải duy nhất).`);
      seen.add(d.id);
      checkFile(`${p}.file`, d.file);
      (d.usedBy || []).forEach((u, k) => { if (files.size && !files.has(u)) W(`${p}.usedBy[${k}]`, `"${u}" không thuộc danh sách file.`); });
    });
  }

  // fileResponsibilities
  const fr = arr(c.fileResponsibilities);
  if (!fr || !fr.length) E('fileResponsibilities', 'fileResponsibilities phải là mảng.');
  else {
    const covered = new Set();
    fr.forEach((r, i) => {
      const p = `fileResponsibilities[${i}]`;
      if (!r) { E(p, 'Mục rỗng.'); return; }
      checkFile(`${p}.file`, r.file);
      if (covered.has(r.file)) W(`${p}.file`, `File "${r.file}" được mô tả 2 lần.`);
      covered.add(r.file);
      if (!isStr(r.role)) W(`${p}.role`, `File "${r.file}" thiếu mô tả vai trò.`);
      (r.exposes || []).forEach((n) => {
        if (fnOwner.has(n) && fnOwner.get(n) !== r.file) W(`${p}.exposes`, `"${n}" được khai là của ${r.file} nhưng functions ghi chủ là ${fnOwner.get(n)}.`);
      });
    });
    for (const f of files) if (!covered.has(f)) W('fileResponsibilities', `File "${f}" chưa được mô tả trách nhiệm.`);
  }

  if (c.dependencies !== undefined && typeof c.dependencies !== 'string') W('dependencies', 'dependencies nên là chuỗi mô tả.');

  const normalized = errors.length ? null : {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectName: c.projectName,
    namingConventions: c.namingConventions,
    dataSchema: ds,
    globalConstants: consts || [],
    functions: fns,
    domElements: dom || [],
    fileResponsibilities: fr,
    dependencies: typeof c.dependencies === 'string' ? c.dependencies : ''
  };
  return { valid: errors.length === 0, errors, warnings, normalized, entityNames: [...entityNames], fieldNames: [...allFields] };
}

/** Phần contract liên quan tới 1 file (dùng khi contract quá dài cho prompt). */
export function contractSliceForFile(contract, file) {
  const fns = contract.functions || [];
  const own = fns.filter((f) => f.file === file);
  const others = fns.filter((f) => f.file !== file).map((f) => ({ name: f.name, file: f.file, params: f.params, returns: f.returns }));
  return {
    schemaVersion: contract.schemaVersion,
    projectName: contract.projectName,
    namingConventions: contract.namingConventions,
    dataSchema: contract.dataSchema,
    globalConstants: (contract.globalConstants || []).map((k) => ({ name: k.name, value: k.value, file: k.file })),
    functionsOwnedByThisFile: own,
    functionsInOtherFiles: others,
    domElements: (contract.domElements || []).filter((d) => d.file === file || (d.usedBy || []).includes(file)),
    allDomIds: (contract.domElements || []).map((d) => d.id),
    thisFile: (contract.fileResponsibilities || []).find((r) => r.file === file) || null,
    _note: 'Bản rút gọn có kiểm soát cho file này: đủ toàn bộ dataSchema, hằng số, chữ ký mọi hàm, DOM id; bỏ phần desc của file khác.'
  };
}

/** Tóm tắt các entity/field để dùng cho seed + kiểm tra. */
export function schemaIndex(contract) {
  const map = {};
  for (const e of contract?.dataSchema || []) map[e.entity] = new Set((e.fields || []).map((f) => f.name));
  return map;
}
