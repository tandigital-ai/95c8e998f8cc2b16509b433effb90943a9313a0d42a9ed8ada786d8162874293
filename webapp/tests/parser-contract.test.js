import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArchitecture, extractJson, stripCodeFences } from '../public/js/core/parser.js';
import { validateContract, contractSliceForFile, CONTRACT_SCHEMA_VERSION } from '../public/js/core/contract.js';
import { PLATFORMS, filePaths, langOf, stubFor } from '../public/js/core/platforms.js';

const GOOD = `Một chút mở đầu
===CLAUDE_MD_START===
# Dự án CRM
Nội dung đặc tả.
\`\`\`js
const x = 1;
\`\`\`
===CLAUDE_MD_END===

\`\`\`
===DIAGRAM_START===
flowchart TD
  A["User"] --> B["Bot"]
===DIAGRAM_END===
\`\`\`

===SKILL_START:skill-01:Phân tích khách hàng===
Nội dung skill 1
===SKILL_END===
=== SKILL_START : skill-02 : Chatbot ===
Nội dung 2
=== SKILL_END ===
**===SKILL_START:skill-03:Data Seeder & QA===**
Sinh dữ liệu mẫu
**===SKILL_END===**`;

describe('parser', () => {
  test('đầu ra đúng: đủ phần, chịu fence/khoảng trắng/**', () => {
    const r = parseArchitecture(GOOD);
    assert.match(r.claudeMd, /^# Dự án CRM/);
    assert.match(r.claudeMd, /const x = 1;/, 'giữ code fence bên trong Claude.md');
    assert.equal(r.diagram, 'flowchart TD\n  A["User"] --> B["Bot"]');
    assert.equal(r.skills.length, 3);
    assert.deepEqual(r.skills.map((s) => s.filename), ['skill-01', 'skill-02', 'skill-03']);
    assert.equal(r.skills[2].name, 'Data Seeder & QA');
    assert.deepEqual(r.warnings, []);
  });

  test('thiếu marker: cảnh báo thiếu diagram, ít skill, thiếu seeder', () => {
    const r = parseArchitecture('===CLAUDE_MD_START===\nA\n===CLAUDE_MD_END===\n===SKILL_START:s1:Bot A===\nx\n===SKILL_END===');
    const codes = r.warnings.map((w) => w.code);
    assert.ok(codes.includes('diagram_missing'));
    assert.ok(codes.includes('too_few_skills'));
    assert.ok(codes.includes('missing_seeder'));
  });

  test('không có marker Claude.md: lấy phần trước marker đầu tiên + cảnh báo', () => {
    const r = parseArchitecture('Đặc tả thô\n===DIAGRAM_START===\ngraph TD\nA-->B\n===DIAGRAM_END===');
    assert.equal(r.claudeMd, 'Đặc tả thô');
    assert.ok(r.warnings.some((w) => w.code === 'claude_md_marker_missing'));
  });

  test('bị cắt giữa chừng: skill cuối không đóng ⇒ cảnh báo, vẫn giữ nội dung', () => {
    const cut = GOOD.slice(0, GOOD.indexOf('Sinh dữ liệu mẫu') + 8);
    const r = parseArchitecture(cut);
    assert.equal(r.skills.length, 3);
    assert.equal(r.skills[2].closed, false);
    assert.ok(r.warnings.some((w) => w.code === 'skill_unterminated'));
  });

  test('Claude.md bị cắt (không có END)', () => {
    const r = parseArchitecture('===CLAUDE_MD_START===\n# Tiêu đề\nđang viết dở');
    assert.equal(r.claudeMd, '# Tiêu đề\nđang viết dở');
    assert.ok(r.warnings.some((w) => w.code === 'claude_md_unterminated'));
  });

  test('tên skill trùng ⇒ đổi tên + cảnh báo; tên tiếng Việt ⇒ slug', () => {
    const r = parseArchitecture('===SKILL_START:Phân Tích Dữ Liệu:A===\n1\n===SKILL_END===\n===SKILL_START:phan-tich-du-lieu:B===\n2\n===SKILL_END===', { minSkills: 0, requireSeeder: false });
    assert.deepEqual(r.skills.map((s) => s.filename), ['phan-tich-du-lieu', 'phan-tich-du-lieu-2']);
    assert.ok(r.warnings.some((w) => w.code === 'skill_duplicate_name'));
  });

  test('rỗng', () => {
    assert.equal(parseArchitecture('').warnings[0].code, 'empty');
  });

  test('extractJson: fence, văn bản thừa, lỗi có dòng/cột, không tự sửa', () => {
    assert.deepEqual(extractJson('Đây:\n```json\n{"a":1}\n```').value, { a: 1 });
    assert.deepEqual(extractJson('abc {"b":[1,2]} xyz').value, { b: [1, 2] });
    const bad = extractJson('{\n "a": 1,\n}');
    assert.equal(bad.ok, false);
    assert.ok(bad.line >= 2);
    assert.equal(extractJson('không có json').ok, false);
  });

  test('stripCodeFences', () => {
    assert.equal(stripCodeFences('```javascript\nconst a=1;\n```'), 'const a=1;');
    assert.equal(stripCodeFences('const a=1;'), 'const a=1;');
  });
});

const FILES = ['Code.gs', 'Models.gs', 'Index.html'];
function goodContract() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectName: 'CRM',
    namingConventions: { functions: 'camelCase' },
    dataSchema: [{ entity: 'Customer', store: 'Customers', fields: [{ name: 'customerId', type: 'string' }, { name: 'fullName', type: 'string' }] }],
    globalConstants: [{ name: 'SHEET_CUSTOMERS', value: 'Customers', file: 'Models.gs' }],
    functions: [
      { name: 'doGet', file: 'Code.gs', params: [], returns: 'HtmlOutput' },
      { name: 'getCustomers', file: 'Models.gs', params: [], returns: 'Customer[]', calledBy: ['Code.gs'] }
    ],
    domElements: [{ id: 'btn-save', type: 'button', file: 'Index.html' }],
    fileResponsibilities: FILES.map((f) => ({ file: f, role: 'x' })),
    dependencies: 'Code -> Models'
  };
}

describe('contract', () => {
  test('hợp lệ', () => {
    const r = validateContract(goodContract(), { fileList: FILES });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.ok(r.normalized);
  });
  test('không phải object / thiếu khóa ⇒ lỗi', () => {
    assert.equal(validateContract(null, { fileList: FILES }).valid, false);
    const r = validateContract({ schemaVersion: 1 }, { fileList: FILES });
    const paths = r.errors.map((e) => e.path);
    for (const p of ['projectName', 'dataSchema', 'functions', 'fileResponsibilities']) assert.ok(paths.includes(p), p);
  });
  test('file ngoài danh sách cố định', () => {
    const c = goodContract();
    c.functions[1].file = 'Helpers.gs';
    const r = validateContract(c, { fileList: FILES });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /Helpers\.gs/.test(e.message)));
  });
  test('hàm có 2 file chủ', () => {
    const c = goodContract();
    c.functions.push({ name: 'getCustomers', file: 'Code.gs', params: [], returns: 'x' });
    const r = validateContract(c, { fileList: FILES });
    assert.ok(r.errors.some((e) => /ĐÚNG 1 file chủ/.test(e.message)));
  });
  test('DOM id trùng', () => {
    const c = goodContract();
    c.domElements.push({ id: 'btn-save', file: 'Index.html' });
    assert.ok(validateContract(c, { fileList: FILES }).errors.some((e) => /btn-save/.test(e.message)));
  });
  test('sai schemaVersion, params không phải mảng, thiếu returns', () => {
    const c = goodContract();
    c.schemaVersion = 7;
    c.functions[0].params = 'x';
    delete c.functions[0].returns;
    const r = validateContract(c, { fileList: FILES });
    assert.ok(r.errors.some((e) => e.path === 'schemaVersion'));
    assert.ok(r.errors.some((e) => e.path === 'functions[0].params'));
    assert.ok(r.errors.some((e) => e.path === 'functions[0].returns'));
  });
  test('field trùng, entity trùng', () => {
    const c = goodContract();
    c.dataSchema[0].fields.push({ name: 'fullName', type: 'string' });
    c.dataSchema.push({ entity: 'Customer', fields: [{ name: 'a', type: 'string' }] });
    const r = validateContract(c, { fileList: FILES });
    assert.ok(r.errors.some((e) => /fullName/.test(e.message)));
    assert.ok(r.errors.some((e) => /Entity "Customer"/.test(e.message)));
  });
  test('slice cho 1 file giữ đủ chữ ký hàm khác', () => {
    const s = contractSliceForFile(goodContract(), 'Code.gs');
    assert.deepEqual(s.functionsOwnedByThisFile.map((f) => f.name), ['doGet']);
    assert.deepEqual(s.functionsInOtherFiles.map((f) => f.name), ['getCustomers']);
    assert.equal(s.dataSchema.length, 1);
  });
});

describe('platforms', () => {
  test('6 preset, đường dẫn duy nhất, có ngôn ngữ', () => {
    assert.deepEqual(Object.keys(PLATFORMS).sort(), ['flutter', 'gas', 'html', 'node', 'python', 'react']);
    for (const id of Object.keys(PLATFORMS)) {
      const ps = filePaths(id);
      assert.equal(new Set(ps).size, ps.length, id);
      assert.ok(ps.length >= 5, id);
    }
    assert.ok(filePaths('react').includes('app/page.tsx'));
    assert.equal(langOf('src/a.mjs'), 'js');
    assert.equal(langOf('Dockerfile'), 'docker');
  });
  test('stub ghi rõ BẢN NHÁP, JSON stub hợp lệ', () => {
    assert.match(stubFor('gas', 'Code.gs'), /BẢN NHÁP/);
    JSON.parse(stubFor('gas', 'appsscript.json'));
  });
});
