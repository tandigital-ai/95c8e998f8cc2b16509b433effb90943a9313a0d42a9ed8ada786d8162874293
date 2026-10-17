import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDB } from '../public/js/core/db.js';
import { createProjectStore, deriveState } from '../public/js/core/projectStore.js';
import { sha256Hex } from '../public/js/core/hash.js';
import * as P from '../public/js/core/prompts.js';
import { filePaths } from '../public/js/core/platforms.js';

describe('projectStore / version', () => {
  test('version bất biến, khôi phục ĐÚNG TỪNG BYTE (kiểm tra băm)', async () => {
    const db = createMemoryDB();
    const ps = createProjectStore({ db });
    const p = await ps.create({ name: 'Test', platform: 'gas' });
    const big = 'x'.repeat(50000) + '\n// unicode: Tiếng Việt ✓ 🚀\r\n\ttab';
    await ps.putFile(p.id, 'Code.gs', { content: big, origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'pass' } } });
    await ps.putFile(p.id, 'Index.html', { content: '<p>a</p>', origin: 'ai', generatedAt: 1 });
    await ps.updateWorkspace(p.id, { claudeMd: '# Spec', skills: [{ filename: 's1', name: 'A', content: 'c' }] });
    const { version } = await ps.createVersion(p.id, { reason: 'pipeline' });
    assert.equal(version.fileHashes['Code.gs'], await sha256Hex(big));
    assert.equal((await ps.getFile(p.id, 'Code.gs')).content.length, big.length, 'không cắt nội dung');

    // sửa bản làm việc
    await ps.putFile(p.id, 'Code.gs', { content: 'đã sửa' });
    await ps.putFile(p.id, 'Extra.gs', { content: 'thừa' });
    await ps.updateWorkspace(p.id, { claudeMd: 'khác' });

    const r = await ps.restoreVersion(p.id, version.id);
    assert.equal(r.verifiedAfter, true);
    const restored = await ps.getFile(p.id, 'Code.gs');
    assert.equal(restored.content, big);
    assert.equal(await sha256Hex(restored.content), version.fileHashes['Code.gs']);
    assert.equal(await ps.getFile(p.id, 'Extra.gs'), undefined);
    assert.equal((await ps.getProject(p.id)).workspace.claudeMd, '# Spec');

    // version không ghi đè được
    await assert.rejects(db.put('versions', { ...version, reason: 'hack' }), (e) => e.code === 'IMMUTABLE');
  });

  test('không tạo version trùng; version hỏng không khôi phục', async () => {
    const db = createMemoryDB();
    const ps = createProjectStore({ db });
    const p = await ps.create({});
    await ps.putFile(p.id, 'a.js', { content: '1', origin: 'ai', generatedAt: 1 });
    const v1 = await ps.createVersion(p.id);
    const v2 = await ps.createVersion(p.id);
    assert.equal(v2.duplicate, true);
    assert.equal((await ps.listVersions(p.id)).length, 1);
    // Làm hỏng dữ liệu (giả lập bit-rot) bằng cách xóa rồi thêm bản khác nội dung
    const bad = JSON.parse(JSON.stringify(v1.version));
    bad.snapshot.files['a.js'].content = '2';
    await db.delete('versions', bad.id);
    await db.add('versions', bad);
    const chk = await ps.verifyVersion(bad);
    assert.equal(chk.ok, false);
    assert.deepEqual(chk.bad, ['a.js']);
    await assert.rejects(ps.restoreVersion(p.id, bad.id), /sai băm/);
  });

  test('giữ tối đa N version, không xóa bản ghim', async () => {
    const db = createMemoryDB();
    let t = 1000;
    const ps = createProjectStore({ db, now: () => ++t });
    const p = await ps.create({});
    const ids = [];
    for (let i = 0; i < 5; i++) {
      await ps.putFile(p.id, 'a.js', { content: String(i), origin: 'ai', generatedAt: 1 });
      ids.push((await ps.createVersion(p.id)).version.id);
    }
    await ps.setVersionMeta(p.id, ids[0], { pinned: true });
    const removed = await ps.pruneVersions(p.id, 2);
    const left = (await ps.listVersions(p.id)).map((v) => v.id);
    assert.ok(left.includes(ids[0]), 'giữ bản ghim');
    assert.ok(left.includes(ids[4]), 'giữ bản mới nhất (head)');
    assert.equal(left.length, 2);
    assert.equal(removed.length, 3);
  });

  test('nhân bản, đổi tên, ghim, xóa', async () => {
    const db = createMemoryDB();
    const ps = createProjectStore({ db });
    const p = await ps.create({ name: 'A' });
    await ps.putFile(p.id, 'a.js', { content: 'x' });
    const d = await ps.duplicate(p.id);
    assert.equal((await ps.getFile(d.id, 'a.js')).content, 'x');
    await ps.rename(d.id, 'B');
    await ps.setPinned(d.id, true);
    const list = await ps.list();
    assert.equal(list.items[0].name, 'B');
    await ps.remove(p.id);
    assert.equal((await ps.list()).total, 1);
  });

  test('deriveState theo bằng chứng', () => {
    assert.equal(deriveState({ origin: 'stub' }), 'draft');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1 }), 'generated');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, truncated: true, checks: { syntax: { status: 'pass' } } }), 'truncated');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'fail' } } }), 'generated');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'pass' } } }), 'syntax-checked');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'unchecked' }, consistency: { status: 'pass' } } }), 'consistency-checked');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'pass' }, consistency: { status: 'fail' } } }), 'syntax-checked');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, checks: { syntax: { status: 'pass' }, consistency: { status: 'pass' }, review: { status: 'pass' } } }), 'reviewed');
    assert.equal(deriveState({ origin: 'ai', generatedAt: 1, stale: true }), 'stale');
  });
});

describe('prompts', () => {
  test('kiến trúc: đủ marker, bắt buộc Data Seeder, file cố định', () => {
    const s = P.architectureSystem({ platformId: 'gas' });
    for (const k of ['===CLAUDE_MD_START===', '===DIAGRAM_START===', '===SKILL_START:', 'Data Seeder & QA', 'Code.gs']) assert.ok(s.includes(k), k);
  });
  test('ảnh + tệp tham chiếu đi CÙNG NHAU (sửa lỗi bản GAS)', () => {
    const c = P.architectureUser({ idea: 'ý tưởng', platformId: 'html', images: [{ dataUrl: 'data:image/png;base64,AAA' }], refFiles: [{ name: 'a.txt', content: 'NỘI DUNG TỆP' }] });
    assert.ok(Array.isArray(c));
    assert.ok(c[0].text.includes('NỘI DUNG TỆP'));
    assert.equal(c[1].type, 'image_url');
  });
  test('contract prompt liệt kê đúng danh sách file', () => {
    const fl = filePaths('react');
    const s = P.contractSystem({ platformId: 'react', fileList: fl });
    assert.ok(s.includes('app/page.tsx'));
    assert.ok(s.includes('"schemaVersion": 1'));
  });
  test('analyze: prompt theo nền tảng (không cố định GAS), có Tìm/Thay', () => {
    assert.ok(P.analyzeSystem({ platformId: 'python' }).includes('Python'));
    assert.ok(P.analyzeSystem({ platformId: 'python' }).includes('**Tìm:**'));
    const u = P.analyzeUser({ userText: 'lỗi', texts: [{ name: 'a.py', content: 'x' }], images: [{ dataUrl: 'data:,' }] });
    assert.equal(u.length, 3);
  });
});
