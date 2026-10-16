import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as acorn from '../public/vendor/acorn.mjs';
import { setAcorn as setA1, checkSyntax, checkHtmlTags } from '../public/js/core/syntaxCheck.js';
import { setAcorn as setA2, checkConsistency } from '../public/js/core/consistency.js';
import { getPlatform } from '../public/js/core/platforms.js';

setA1(acorn);
setA2(acorn);

describe('syntaxCheck', () => {
  test('JS hợp lệ / lỗi có dòng', async () => {
    assert.equal((await checkSyntax('a.js', 'export const a = 1;\nfunction b(){ return a }')).status, 'pass');
    const bad = await checkSyntax('a.js', 'const a = 1;\nfunction ( {');
    assert.equal(bad.status, 'fail');
    assert.equal(bad.errors[0].line, 2);
  });
  test('.gs dùng script mode', async () => {
    assert.equal((await checkSyntax('Code.gs', 'function doGet(){ return HtmlService.createHtmlOutput("x"); }')).status, 'pass');
    assert.equal((await checkSyntax('Code.gs', 'function doGet( {')).status, 'fail');
  });
  test('JSON', async () => {
    assert.equal((await checkSyntax('a.json', '{"a":1}')).status, 'pass');
    const r = await checkSyntax('a.json', '{\n"a":1,\n}');
    assert.equal(r.status, 'fail');
  });
  test('HTML: thẻ không đóng + script nội tuyến lỗi', async () => {
    assert.equal((await checkSyntax('i.html', '<!DOCTYPE html><html><body><div><p>x</div><br><img src=a></body></html>')).status, 'pass');
    const r = await checkSyntax('i.html', '<div><span>x</div>\n<script>\nfunction (\n</script>');
    assert.equal(r.status, 'fail');
    assert.ok(r.errors.some((e) => /span/.test(e.message)));
    assert.ok(r.errors.some((e) => /script/i.test(e.message)));
    assert.deepEqual(checkHtmlTags('<ul><li>a<li>b</ul>'), []);
  });
  test('ngôn ngữ khác ⇒ unchecked (không giả vờ OK)', async () => {
    for (const p of ['a.py', 'b.tsx', 'c.dart', 'pubspec.yaml', 'x.css']) {
      const r = await checkSyntax(p, 'x');
      assert.equal(r.status, 'unchecked', p);
      assert.match(r.message, /Chưa kiểm tra/);
    }
  });
  test('file rỗng ⇒ fail', async () => {
    assert.equal((await checkSyntax('a.js', '   ')).status, 'fail');
  });
});

const gas = getPlatform('gas');
const contract = {
  functions: [
    { name: 'doGet', file: 'Code.gs' },
    { name: 'getCustomers', file: 'Models.gs' },
    { name: 'saveCustomer', file: 'Handlers.gs' }
  ],
  dataSchema: [{ entity: 'Customer', fields: [{ name: 'customerId' }, { name: 'fullName' }, { name: 'phone' }] }],
  domElements: [{ id: 'btn-save', file: 'Index.html' }, { id: 'list', file: 'Index.html' }]
};
const baseFiles = () => ({
  'Code.gs': 'function doGet(){ return HtmlService.createTemplateFromFile("Index").evaluate(); }',
  'Models.gs': 'const SHEET = "Customers";\nfunction getCustomers(){ return [{ customerId: "1", fullName: "A", phone: "1" }]; }',
  'Handlers.gs': 'function saveCustomer(c){ return getCustomers().length; }',
  'Index.html': '<button id="btn-save">Lưu</button><ul id="list"></ul>\n<script>\ndocument.getElementById("btn-save").onclick = function(){ google.script.run.withSuccessHandler(render).saveCustomer({}); };\nfunction render(){ document.getElementById("list").textContent = "ok"; }\n</script>',
  'README.md': '```js\nfunction doGet(){}\n```'
});

describe('consistency', () => {
  test('dự án sạch ⇒ ok, README bị bỏ qua', async () => {
    const r = await checkConsistency({ files: baseFiles(), contract, platform: gas });
    assert.equal(r.ok, true, JSON.stringify(r.issues, null, 1));
    assert.equal(r.coverage['README.md'], 'skipped');
    assert.equal(r.coverage['Code.gs'], 'ast');
  });

  test('cố ý XÓA 1 hàm ⇒ missing_function + gas_run_missing + undefined_call', async () => {
    const f = baseFiles();
    f['Handlers.gs'] = '// đã xóa saveCustomer';
    f['Code.gs'] += '\nfunction boot(){ return saveCustomer({}); }';
    const r = await checkConsistency({ files: f, contract, platform: gas });
    const types = r.issues.map((i) => i.type);
    assert.equal(r.ok, false);
    assert.ok(types.includes('missing_function'));
    assert.ok(types.includes('gas_run_missing'));
    assert.ok(types.includes('undefined_call'));
    const u = r.issues.find((i) => i.type === 'undefined_call');
    assert.equal(u.file, 'Code.gs');
    assert.equal(u.line, 2);
  });

  test('cố ý TRÙNG 1 hàm giữa 2 file .gs ⇒ error có file/dòng', async () => {
    const f = baseFiles();
    f['Handlers.gs'] += '\n\nfunction getCustomers(){ return []; }';
    const r = await checkConsistency({ files: f, contract, platform: gas });
    const d = r.issues.find((i) => i.type === 'duplicate_function');
    assert.ok(d);
    assert.equal(d.level, 'error');
    assert.equal(d.file, 'Handlers.gs');
    assert.equal(d.line, 3);
  });

  test('hằng số trùng giữa các file GAS ⇒ duplicate_global', async () => {
    const f = baseFiles();
    f['Code.gs'] = 'const SHEET = "X";\n' + f['Code.gs'];
    const r = await checkConsistency({ files: f, contract, platform: gas });
    assert.ok(r.issues.some((i) => i.type === 'duplicate_global' && i.names.includes('SHEET')));
  });

  test('module (không phải GAS): trùng tên chỉ là warn', async () => {
    const r = await checkConsistency({
      files: { 'a.js': 'export function x(){}', 'b.js': 'export function x(){}' },
      contract: { functions: [] },
      platform: { scope: 'module' }
    });
    assert.equal(r.ok, true);
    assert.equal(r.issues.find((i) => i.type === 'duplicate_function').level, 'warn');
  });

  test('trường ngoài schema', async () => {
    const f = baseFiles();
    f['Models.gs'] = 'const SHEET = "C";\nfunction getCustomers(){ return [{ customerId: "1", fullName: "A", emailAddr: "x" }]; }';
    const r = await checkConsistency({ files: f, contract, platform: gas });
    const i = r.issues.find((x) => x.type === 'field_not_in_schema');
    assert.ok(i);
    assert.deepEqual(i.names, ['emailAddr']);
  });

  test('DOM: thiếu, thừa, không tồn tại, trùng', async () => {
    const f = baseFiles();
    f['Index.html'] = '<button id="btn-save">x</button><i id="extra"></i><i id="extra"></i>\n<script>\ndocument.getElementById("ghost").x=1; google.script.run.saveCustomer();\n</script>';
    const r = await checkConsistency({ files: f, contract, platform: gas });
    const t = r.issues.map((i) => i.type);
    assert.ok(t.includes('dom_missing')); // list
    assert.ok(t.includes('dom_extra'));
    assert.ok(t.includes('dom_unknown'));
    assert.ok(t.includes('dom_duplicate'));
  });

  test('gọi hàm private (_ cuối) qua google.script.run ⇒ lỗi', async () => {
    const f = baseFiles();
    f['Handlers.gs'] += '\nfunction secret_(){ return 1; }';
    f['Index.html'] = f['Index.html'].replace('</script>', 'google.script.run.secret_();\n</script>');
    const r = await checkConsistency({ files: f, contract, platform: gas });
    assert.ok(r.issues.some((i) => i.type === 'gas_run_private'));
  });

  test('file không parse được ⇒ parse_failed, không crash', async () => {
    const r = await checkConsistency({ files: { 'a.js': 'function (' }, contract: null, platform: { scope: 'module' } });
    assert.equal(r.coverage['a.js'], 'failed');
    assert.ok(r.issues.some((i) => i.type === 'parse_failed'));
  });

  test('python dùng regex (heuristic)', async () => {
    const r = await checkConsistency({ files: { 'app/routes.py': 'def index():\n    return 1\n' }, contract: { functions: [{ name: 'index', file: 'app/routes.py' }] }, platform: { scope: 'module' } });
    assert.equal(r.coverage['app/routes.py'], 'regex');
    assert.equal(r.ok, true);
  });
});
