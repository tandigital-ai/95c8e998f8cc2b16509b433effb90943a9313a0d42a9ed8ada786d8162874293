import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDB, DBError, BACKUP_FORMAT } from '../public/js/core/db.js';
import { createBudget, estimateTokens, lookupPrice, computeCost, formatUsd, dayKey, BudgetError } from '../public/js/core/budget.js';
import { mergeSettings } from '../public/js/core/settings.js';
import { createLogger, sanitizeForLog } from '../public/js/core/logger.js';
import { fakeClock } from './helpers.js';

describe('db (bộ nhớ, cùng API với IndexedDB)', () => {
  test('put/get/getAll theo index + range + limit + direction', async () => {
    const db = createMemoryDB();
    for (let i = 1; i <= 5; i++) await db.put('jobs', { id: 'j' + i, projectId: i % 2 ? 'A' : 'B', status: 'x', updatedAt: i });
    assert.equal((await db.getAll('jobs', { index: 'projectId', query: 'A' })).length, 3);
    const recent = await db.getAll('jobs', { index: 'updatedAt', direction: 'prev', limit: 2 });
    assert.deepEqual(recent.map((r) => r.id), ['j5', 'j4']);
    const range = await db.getAll('jobs', { index: 'updatedAt', query: { lower: 2, upper: 4 } });
    assert.deepEqual(range.map((r) => r.id), ['j2', 'j3', 'j4']);
    assert.equal(await db.count('jobs'), 5);
  });

  test('khóa ghép cho files, autoIncrement cho logs', async () => {
    const db = createMemoryDB();
    await db.put('files', { projectId: 'p', path: 'a.js', state: 'draft' });
    assert.equal((await db.get('files', ['p', 'a.js'])).state, 'draft');
    const id1 = await db.add('logs', { ts: 1, level: 'info', kind: 'x' });
    const id2 = await db.add('logs', { ts: 2, level: 'info', kind: 'x' });
    assert.equal(id2, id1 + 1);
  });

  test('versions BẤT BIẾN', async () => {
    const db = createMemoryDB();
    await db.put('versions', { id: 'v1', projectId: 'p', createdAt: 1, manifest: {} });
    await assert.rejects(db.put('versions', { id: 'v1', projectId: 'p', createdAt: 1, manifest: { x: 1 } }), (e) => e instanceof DBError && e.code === 'IMMUTABLE');
  });

  test('export/import JSON round-trip, kể cả Uint8Array', async () => {
    const db = createMemoryDB();
    await db.put('projects', { id: 'p1', name: 'Dự án', updatedAt: 5 });
    await db.put('versions', { id: 'v1', projectId: 'p1', createdAt: 1, blob: new Uint8Array([1, 2, 3]) });
    await db.put('cache', { hash: 'h', expiresAt: 9, result: {} });
    const dump = await db.exportAll();
    assert.equal(dump.format, BACKUP_FORMAT);
    assert.ok(!dump.stores.cache, 'mặc định không xuất cache');
    const json = JSON.parse(JSON.stringify(dump));
    const db2 = createMemoryDB();
    const res = await db2.importAll(json);
    assert.equal(res.imported.projects, 1);
    const v = await db2.get('versions', 'v1');
    assert.deepEqual([...v.blob], [1, 2, 3]);
    // import lần 2: versions bị bỏ qua (không ghi đè)
    const res2 = await db2.importAll(json);
    assert.equal(res2.skipped.versions, 1);
    await assert.rejects(db2.importAll({ format: 'khac' }), (e) => e.code === 'BAD_BACKUP');
    await assert.rejects(db2.importAll({ format: BACKUP_FORMAT, schemaVersion: 99, stores: {} }), (e) => e.code === 'BAD_BACKUP');
  });

  test('store lạ => lỗi rõ ràng', async () => {
    const db = createMemoryDB();
    await assert.rejects(db.get('khong-co', 1), (e) => e.code === 'UNKNOWN_STORE');
  });
});

describe('budget', () => {
  function setup(over = {}) {
    const db = createMemoryDB();
    const clock = fakeClock(Date.parse('2026-10-07T03:00:00Z'));
    let s = mergeSettings({ dailyBudgetUsd: 1, projectBudgetUsd: 0.5, pricing: { 'gemini:flash': { in: 1, out: 2 } }, ...over });
    let asked = 0;
    let answer = true;
    const b = createBudget({
      db, getSettings: () => s, now: clock.now,
      getProviderPricing: () => ({ openrouter: { 'x/y': { in: 3, out: 4 } } }),
      confirm: async () => { asked++; return answer; }
    });
    return { db, b, clock, setS: (p) => { s = mergeSettings({ ...s, ...p }); }, asked: () => asked, answer: (v) => { answer = v; } };
  }

  test('ước lượng token = ký tự/4', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });

  test('giá: người dùng > provider > không rõ (null, không bịa số)', () => {
    assert.deepEqual(lookupPrice({ provider: 'gemini', model: 'flash', userPricing: { 'gemini:flash': { in: 1, out: 2 } } }), { in: 1, out: 2, source: 'user' });
    assert.equal(lookupPrice({ provider: 'openrouter', model: 'x/y', providerPricing: { openrouter: { 'x/y': { in: 3, out: 4 } } } }).source, 'provider');
    assert.equal(lookupPrice({ provider: 'nvidia', model: 'llama' }), null);
    assert.deepEqual(computeCost(1000, 1000, null), { cost: null, priceSource: 'unknown' });
    assert.equal(formatUsd(null), 'không rõ giá');
    assert.equal(computeCost(1e6, 1e6, { in: 1, out: 2, source: 'user' }).cost, 3);
  });

  test('ghi bền theo ngày + dự án; đếm cuộc gọi không rõ giá riêng', async () => {
    const { b, db } = setup();
    await b.record({ provider: 'gemini', model: 'flash', inTokens: 100000, outTokens: 50000, tokenSource: 'provider', cost: 0.2, projectId: 'P1' });
    await b.record({ provider: 'nvidia', model: 'llama', inTokens: 10, outTokens: 10, tokenSource: 'estimated', cost: null, projectId: 'P1' });
    await b.flush();
    const day = await b.getDay();
    assert.equal(day.date, '2026-10-07');
    assert.equal(day.calls, 2);
    assert.equal(day.knownCostUsd, 0.2);
    assert.equal(day.unknownPriceCalls, 1);
    assert.equal(day.estimatedTokenCalls, 1);
    const proj = await b.getProject('P1');
    assert.equal(proj.calls, 2);
    // Lưu bền: đọc trực tiếp từ DB
    assert.ok(await db.get('usage', 'day:2026-10-07'));
    assert.ok(await db.get('usage', 'project:P1'));
  });

  test('ghi song song không mất cập nhật', async () => {
    const { b } = setup();
    await Promise.all(Array.from({ length: 20 }, () => b.record({ provider: 'gemini', model: 'flash', inTokens: 1, outTokens: 1, tokenSource: 'provider', cost: 0.01 })));
    await b.flush();
    const day = await b.getDay();
    assert.equal(day.calls, 20);
    assert.equal(day.knownCostUsd, 0.2);
  });

  test('cảnh báo mềm: vượt => hỏi xác nhận; đồng ý => đi tiếp; từ chối => BudgetError', async () => {
    const t = setup();
    await t.b.record({ provider: 'gemini', model: 'flash', inTokens: 0, outTokens: 0, tokenSource: 'provider', cost: 0.9, projectId: 'P' });
    let r = await t.b.guard({ projectId: 'P', estimatedCost: 0.01 });
    assert.equal(t.asked(), 1); // vượt ngân sách dự án 0.5
    assert.equal(r.confirmed, true);
    // chế độ 'once': không hỏi lại cùng phạm vi
    r = await t.b.guard({ projectId: 'P', estimatedCost: 0.01 });
    assert.equal(t.asked(), 1);
    // vượt ngân sách ngày (1$) với ước tính lớn => hỏi phạm vi mới
    t.answer(false);
    await assert.rejects(t.b.guard({ projectId: 'P', estimatedCost: 0.5 }), (e) => e instanceof BudgetError && e.code === 'DECLINED');
  });

  test('không vượt => không hỏi; never => không hỏi', async () => {
    const t = setup({ confirmOverBudget: 'never' });
    await t.b.record({ provider: 'gemini', model: 'flash', inTokens: 0, outTokens: 0, tokenSource: 'provider', cost: 5 });
    const r = await t.b.guard({ estimatedCost: 1 });
    assert.equal(t.asked(), 0);
    assert.equal(r.warnings.length, 1);
  });

  test('ước tính kế hoạch tách bước không rõ giá', () => {
    const { b } = setup();
    const plan = b.estimatePlan([
      { label: 'Kiến trúc', provider: 'gemini', model: 'flash', inTokens: 1e6, outTokens: 1e6 },
      { label: 'Code', provider: 'nvidia', model: 'llama', inTokens: 10, outTokens: 10 }
    ]);
    assert.equal(plan.knownCostUsd, 3);
    assert.deepEqual(plan.unknownPriceSteps, ['Code']);
    assert.equal(plan.tokenSource, 'estimated');
  });

  test('dayKey theo múi giờ VN', () => {
    assert.equal(dayKey(Date.parse('2026-10-06T18:30:00Z'), 'Asia/Ho_Chi_Minh'), '2026-10-07');
  });
});

describe('logger', () => {
  test('che trường nhạy cảm, ghi bền vào logs', async () => {
    const db = createMemoryDB();
    const lg = createLogger({ db, consoleImpl: { error() {} } });
    await lg.error('test', 'Có lỗi', { apiKey: 'sk-should-hide', token: 't', keyIndex: 2, nested: { password: 'p' } });
    const rows = await lg.list();
    assert.equal(rows.length, 1);
    const s = JSON.stringify(rows[0]);
    assert.ok(!s.includes('sk-should-hide'));
    assert.ok(!s.includes('"p"'));
    assert.equal(rows[0].context.keyIndex, 2);
    assert.equal(sanitizeForLog({ authorization: 'Bearer x' }).authorization, '[REDACTED]');
  });
});
