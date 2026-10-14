import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMemoryDB } from '../public/js/core/db.js';
import { createVault } from '../public/js/core/vault.js';
import { createKeyring } from '../public/js/core/keyring.js';
import { createBudget } from '../public/js/core/budget.js';
import { createLogger } from '../public/js/core/logger.js';
import { createSettingsStore } from '../public/js/core/settings.js';
import { splitSSE, createStreamAccumulator } from '../public/js/core/sse.js';
import {
  createLLMClient, backoffDelay, mergeContinuation, parseModelsResponse, isRetryableStatus, LLMError, buildContinueMessages
} from '../public/js/core/llmClient.js';
import { jsonResponse, sseResponse, fakeClock } from './helpers.js';

const cryptoImpl = globalThis.crypto || webcrypto;

const okJson = (content, finish = 'stop', usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
  jsonResponse({ choices: [{ message: { content }, finish_reason: finish }], usage });

async function setup({ responses, settingsPatch = {}, serverKeys = {}, clientKeys = {}, confirmFallback = null, budgetConfirm = null } = {}) {
  const db = createMemoryDB();
  const settings = createSettingsStore({ db });
  await settings.load();
  await settings.update({ backoffBaseMs: 1, backoffMaxMs: 2, ...settingsPatch });
  const vault = createVault({ db, cryptoImpl });
  await vault.useMemoryOnly();
  const clock = fakeClock();
  const keyring = createKeyring({ vault, cryptoImpl, now: clock.now });
  for (const [p, k] of Object.entries(clientKeys)) await keyring.addKeys(p, k);
  const logger = createLogger({ db, consoleImpl: { error() {} } });
  let providerPricing = {};
  const budget = createBudget({ db, getSettings: () => settings.get(), getProviderPricing: () => providerPricing, confirm: budgetConfirm });
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof responses === 'function' ? responses(calls.length, calls[calls.length - 1]) : responses[calls.length - 1];
    if (r instanceof Error) throw r;
    if (!r) throw new Error('Hết response giả lập ở lần gọi ' + calls.length);
    return r;
  };
  const client = createLLMClient({
    db, settings, keyring, budget, logger, fetchImpl,
    getServerKeyCount: (p) => serverKeys[p] || 0,
    confirmFallback,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    random: () => 0.5
  });
  providerPricing = client.getProviderPricing();
  return { db, client, calls, sleeps, logger, budget, keyring, settings };
}

const msgs = [{ role: 'user', content: 'Xin chào' }];

describe('hàm thuần', () => {
  test('backoff lũy thừa, chặn trần, tôn trọng Retry-After', () => {
    assert.equal(backoffDelay(0, { baseMs: 1000, maxMs: 16000, random: () => 0.5 }), 1000);
    assert.equal(backoffDelay(3, { baseMs: 1000, maxMs: 16000, random: () => 0.5 }), 8000);
    assert.equal(backoffDelay(10, { baseMs: 1000, maxMs: 16000, random: () => 0.5 }), 16000);
    assert.equal(backoffDelay(0, { baseMs: 1000, maxMs: 16000, retryAfterMs: 5000, random: () => 0.5 }), 5000);
  });
  test('retryable status', () => {
    for (const s of [429, 500, 502, 503, 504, 408]) assert.ok(isRetryableStatus(s));
    for (const s of [400, 401, 403, 404, 422]) assert.equal(isRetryableStatus(s), false);
  });
  test('mergeContinuation bỏ phần lặp', () => {
    const a = 'Đây là đoạn văn bản đầu tiên rất dài và kết thúc ở đây';
    assert.equal(mergeContinuation(a, 'rất dài và kết thúc ở đây. Tiếp theo'), a + '. Tiếp theo');
    assert.equal(mergeContinuation('abc', 'def'), 'abcdef');
  });
  test('buildContinueMessages giữ nguyên messages gốc (kể cả ảnh) + TOÀN BỘ nội dung đã sinh', () => {
    const base = [{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 't' }, { type: 'image_url', image_url: { url: 'data:x' } }] }];
    const m = buildContinueMessages(base, 'AAA BBB', 'CONTINUE');
    assert.equal(m.length, 4);
    assert.deepEqual(m[1], base[1]);
    assert.equal(m[2].content, 'AAA BBB');
  });
  test('parseModelsResponse: lọc, bỏ "models/", lấy giá OpenRouter', () => {
    const r = parseModelsResponse({ data: [
      { id: 'models/gemini-x' }, { id: 'text-embedding-1' }, { id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 1000 }
    ] }, { filterRegex: 'embed' });
    assert.deepEqual(r.models, ['a/b', 'gemini-x']);
    assert.deepEqual(r.pricing['a/b'], { in: 1, out: 2 });
    assert.equal(r.meta['a/b'].contextLength, 1000);
  });
  test('SSE parser: CRLF, comment, nhiều sự kiện, usage, proxy_error', () => {
    const { events, rest } = splitSSE(': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"x"');
    assert.equal(events.length, 1);
    assert.equal(rest, 'data: {"x"');
    const acc = createStreamAccumulator();
    acc.handle({ event: 'message', data: '{"choices":[{"delta":{"content":"Hi"},"finish_reason":"length"}]}' });
    acc.handle({ event: 'message', data: '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}' });
    acc.handle({ event: 'message', data: '[DONE]' });
    assert.equal(acc.state.content, 'Hi');
    assert.equal(acc.state.finishReason, 'length');
    assert.equal(acc.state.usage.completion_tokens, 2);
    assert.throws(() => acc.handle({ event: 'proxy_error', data: '{"error":{"message":"idle"}}' }), /idle/);
    assert.throws(() => acc.handle({ event: 'message', data: '{"error":{"message":"quota"}}' }), /quota/);
  });
});

describe('llmClient', () => {
  test('chat cơ bản: usage từ provider, chi phí không rõ giá => null, log ghi đủ trường', async () => {
    const t = await setup({ responses: [okJson('Chào bạn')], serverKeys: { deepseek: 1 } });
    const r = await t.client.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: msgs, step: 'test', projectId: 'P' });
    assert.equal(r.content, 'Chào bạn');
    assert.equal(r.complete, true);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.usage, { inTokens: 10, outTokens: 5, tokenSource: 'provider' });
    assert.equal(r.cost, null);
    assert.equal(t.calls[0].url, '/api/llm/deepseek/chat');
    assert.equal(t.calls[0].init.headers['X-Provider-Key'], undefined);
    const logs = await t.logger.list({ kind: 'llm' });
    assert.equal(logs.length, 1);
    const c = logs[0].context;
    for (const k of ['step', 'provider', 'model', 'cached', 'latencyMs', 'inTokens', 'outTokens', 'cost', 'status']) assert.ok(k in c, 'thiếu ' + k);
    assert.equal(c.status, 'ok');
    await t.budget.flush();
    const day = await t.budget.getDay();
    assert.equal(day.unknownPriceCalls, 1);
  });

  test('không có usage => ước lượng, gắn nhãn estimated', async () => {
    const t = await setup({ responses: [jsonResponse({ choices: [{ message: { content: '12345678' }, finish_reason: 'stop' }] })], serverKeys: { mistral: 1 } });
    const r = await t.client.chat({ provider: 'mistral', model: 'm', messages: msgs });
    assert.equal(r.usage.tokenSource, 'estimated');
    assert.equal(r.usage.outTokens, 2);
  });

  test('có giá người dùng nhập => tính chi phí', async () => {
    const t = await setup({ responses: [okJson('x', 'stop', { prompt_tokens: 1e6, completion_tokens: 1e6 })], serverKeys: { gemini: 1 }, settingsPatch: { pricing: { 'gemini:g': { in: 0.1, out: 0.4 } } } });
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r.cost, 0.5);
  });

  test('retry + backoff khi 503 rồi thành công', async () => {
    const t = await setup({ responses: [jsonResponse({ error: { message: 'down', upstream: true } }, 503), jsonResponse({ error: { message: 'down' } }, 502), okJson('ok')], serverKeys: { gemini: 1 } });
    const events = [];
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs, onEvent: (e) => events.push(e) });
    assert.equal(r.content, 'ok');
    assert.equal(t.calls.length, 3);
    assert.equal(t.sleeps.length, 2);
    assert.ok(t.sleeps[1] >= t.sleeps[0]);
    assert.equal(events.filter((e) => e.type === 'retry').length, 2);
    const errLogs = (await t.logger.list({ kind: 'llm' })).filter((l) => l.context.status === 'error');
    assert.equal(errLogs.length, 2);
  });

  test('400 không retry; lỗi được ném rõ ràng', async () => {
    const t = await setup({ responses: [jsonResponse({ error: { message: 'bad model', upstream: true } }, 400)], serverKeys: { gemini: 1 } });
    await assert.rejects(t.client.chat({ provider: 'gemini', model: 'g', messages: msgs }), (e) => e instanceof LLMError && e.status === 400 && /bad model/.test(e.message));
    assert.equal(t.calls.length, 1);
  });

  test('hết retry => ném lỗi cuối', async () => {
    const t = await setup({ responses: () => jsonResponse({ error: { message: 'down' } }, 500), serverKeys: { gemini: 1 }, settingsPatch: { maxRetries: 2 } });
    await assert.rejects(t.client.chat({ provider: 'gemini', model: 'g', messages: msgs }), (e) => e.status === 500);
    assert.equal(t.calls.length, 3);
  });

  test('key trình duyệt: 429 => đổi key ngay (không chờ), gửi X-Provider-Key', async () => {
    const t = await setup({
      responses: [jsonResponse({ error: { message: 'rate' } }, 429), okJson('ok')],
      clientKeys: { openrouter: 'or-key-111111111\nor-key-222222222' }
    });
    const r = await t.client.chat({ provider: 'openrouter', model: 'm', messages: msgs });
    assert.equal(r.content, 'ok');
    assert.equal(t.sleeps.length, 0);
    const k1 = t.calls[0].init.headers['X-Provider-Key'];
    const k2 = t.calls[1].init.headers['X-Provider-Key'];
    assert.ok(k1 && k2 && k1 !== k2);
    assert.equal(t.keyring.listMasked('openrouter').filter((k) => k.status === 'cooldown').length, 1);
    // log không chứa key thật
    const s = JSON.stringify(await t.logger.list());
    assert.ok(!s.includes('or-key-111111111') && !s.includes('or-key-222222222'));
  });

  test('không có key => NO_KEY, không gọi mạng', async () => {
    const t = await setup({ responses: [] });
    await assert.rejects(t.client.chat({ provider: 'grok', model: 'x', messages: msgs }), (e) => e.code === 'NO_KEY');
    assert.equal(t.calls.length, 0);
  });

  test('auto-continue khi length: gửi lại TOÀN BỘ phần đã sinh, cộng dồn usage', async () => {
    const t = await setup({
      responses: [okJson('Phần một. ', 'length'), okJson('Phần hai. ', 'length'), okJson('Hết.', 'stop')],
      serverKeys: { gemini: 1 }, settingsPatch: { maxContinueRounds: 4 }
    });
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r.content, 'Phần một. Phần hai. Hết.');
    assert.equal(r.rounds, 3);
    assert.equal(r.truncated, false);
    assert.equal(r.complete, true);
    assert.equal(r.usage.inTokens, 30);
    const third = t.calls[2].body.messages;
    assert.equal(third[third.length - 2].role, 'assistant');
    assert.equal(third[third.length - 2].content, 'Phần một. Phần hai. ');
  });

  test('vẫn bị cắt sau N vòng => TRUNCATED, không cache', async () => {
    const t = await setup({ responses: () => okJson('x', 'length'), serverKeys: { gemini: 1 }, settingsPatch: { maxContinueRounds: 2 } });
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r.truncated, true);
    assert.equal(r.complete, false);
    assert.equal(r.rounds, 2);
    assert.equal(t.calls.length, 2);
    assert.equal((await t.client.cacheStats()).entries, 0);
    const warn = (await t.logger.list()).find((l) => /BỊ CẮT/.test(l.message));
    assert.ok(warn);
  });

  test('cache: lần 2 trả "cached", không gọi mạng; noCache bỏ qua; xóa cache', async () => {
    const t = await setup({ responses: () => okJson('cache me'), serverKeys: { gemini: 1 } });
    const r1 = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r1.cached, false);
    const r2 = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r2.cached, true);
    assert.equal(r2.content, 'cache me');
    assert.equal(t.calls.length, 1);
    await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs, noCache: true });
    assert.equal(t.calls.length, 2);
    await t.client.clearCache();
    assert.equal((await t.client.cacheStats()).entries, 0);
  });

  test('cache hết hạn theo TTL', async () => {
    const t = await setup({ responses: () => okJson('v'), serverKeys: { gemini: 1 }, settingsPatch: { cacheTtlHours: 1 } });
    await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    const rows = await t.db.getAll('cache');
    rows[0].expiresAt = Date.now() - 1;
    await t.db.put('cache', rows[0]);
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r.cached, false);
    assert.equal(t.calls.length, 2);
  });

  test('stream: onDelta nhận từng phần, usage từ stream_options', async () => {
    const t = await setup({
      responses: [sseResponse([
        'data: {"choices":[{"delta":{"content":"Xin "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"chào"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n'
      ])],
      serverKeys: { gemini: 1 }
    });
    const seen = [];
    const r = await t.client.stream({ provider: 'gemini', model: 'g', messages: msgs, onDelta: (_d, full) => seen.push(full) });
    assert.deepEqual(seen, ['Xin ', 'Xin chào']);
    assert.equal(r.content, 'Xin chào');
    assert.equal(r.usage.tokenSource, 'provider');
    assert.equal(t.calls[0].body.stream, true);
    assert.deepEqual(t.calls[0].body.stream_options, { include_usage: true });
  });

  test('stream bị đứt sau khi đã phát nội dung => lỗi, KHÔNG retry (tránh trùng)', async () => {
    const t = await setup({
      responses: () => sseResponse(['data: {"choices":[{"delta":{"content":"abc"}}]}\n\n', 'event: proxy_error\ndata: {"error":{"status":504,"message":"idle"}}\n\n']),
      serverKeys: { gemini: 1 }
    });
    await assert.rejects(t.client.stream({ provider: 'gemini', model: 'g', messages: msgs }), (e) => e.code === 'STREAM' && /idle/.test(e.message));
    assert.equal(t.calls.length, 1);
  });

  test('provider không nhận stream_options => tự thử lại không dùng', async () => {
    const t = await setup({
      responses: [jsonResponse({ error: { message: 'Unknown field stream_options', upstream: true } }, 400), sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'])],
      serverKeys: { mistral: 1 }, settingsPatch: { providerOptions: { mistral: { streamUsage: true } } }
    });
    const r = await t.client.stream({ provider: 'mistral', model: 'm', messages: msgs });
    assert.equal(r.content, 'ok');
    assert.equal(t.calls[1].body.stream_options, undefined);
    assert.equal(r.usage.tokenSource, 'estimated');
  });

  test('Hủy bằng AbortController', async () => {
    const ac = new AbortController();
    const t = await setup({
      responses: (n, call) => new Promise((_res, rej) => call.init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
      serverKeys: { gemini: 1 }
    });
    const p = t.client.chat({ provider: 'gemini', model: 'g', messages: msgs, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, (e) => e.code === 'ABORTED');
    assert.equal(t.calls.length, 1);
  });

  test('fallback: mặc định TẮT', async () => {
    const t = await setup({ responses: () => jsonResponse({ error: { message: 'x' } }, 500), serverKeys: { gemini: 1, deepseek: 1 }, settingsPatch: { maxRetries: 0, fallbackChain: [{ provider: 'deepseek', model: 'deepseek-chat' }] } });
    await assert.rejects(t.client.chat({ provider: 'gemini', model: 'g', messages: msgs }));
    assert.equal(t.calls.length, 1);
  });

  test('fallback bật: bỏ qua provider không có key, dùng provider kế tiếp, ghi fallbackFrom, không cache', async () => {
    const t = await setup({
      responses: (n, call) => (call.url.includes('/gemini/') ? jsonResponse({ error: { message: 'down' } }, 500) : okJson('từ deepseek')),
      serverKeys: { gemini: 1, deepseek: 1 },
      settingsPatch: { maxRetries: 0, fallbackEnabled: true, fallbackChain: [{ provider: 'grok', model: 'x' }, { provider: 'deepseek', model: 'deepseek-chat' }] }
    });
    const r = await t.client.chat({ provider: 'gemini', model: 'g', messages: msgs });
    assert.equal(r.content, 'từ deepseek');
    assert.equal(r.provider, 'deepseek');
    assert.equal(r.fallbackFrom.provider, 'gemini');
    assert.ok(!t.calls.some((c) => c.url.includes('/grok/')));
    assert.equal((await t.client.cacheStats()).entries, 0);
  });

  test('fallback cần xác nhận: người dùng từ chối => ném lỗi gốc', async () => {
    const t = await setup({
      responses: (n, call) => (call.url.includes('/gemini/') ? jsonResponse({ error: { message: 'down' } }, 500) : okJson('x')),
      serverKeys: { gemini: 1, deepseek: 1 },
      settingsPatch: { maxRetries: 0, fallbackEnabled: true, fallbackChain: [{ provider: 'deepseek', model: 'd' }] },
      confirmFallback: async () => false
    });
    await assert.rejects(t.client.chat({ provider: 'gemini', model: 'g', messages: msgs }), (e) => e.status === 500);
    assert.ok(!t.calls.some((c) => c.url.includes('/deepseek/')));
  });

  test('ngân sách: người dùng từ chối => BUDGET_DECLINED, không gọi mạng', async () => {
    const t = await setup({
      responses: () => okJson('x'), serverKeys: { gemini: 1 },
      settingsPatch: { dailyBudgetUsd: 0.000001, pricing: { 'gemini:g': { in: 1, out: 1 } } },
      budgetConfirm: async () => false
    });
    await assert.rejects(t.client.chat({ provider: 'gemini', model: 'g', messages: msgs }), (e) => e.code === 'BUDGET_DECLINED');
    assert.equal(t.calls.length, 0);
  });

  test('loadModels lưu IndexedDB + lấy giá động', async () => {
    const t = await setup({
      responses: [jsonResponse({ data: [{ id: 'a/b', pricing: { prompt: '0.000002', completion: '0.000004' } }, { id: 'c/embed-x' }] })],
      serverKeys: { openrouter: 1 }
    });
    const row = await t.client.loadModels('openrouter');
    assert.deepEqual(row.models, ['a/b']);
    assert.equal(row.source, 'remote');
    assert.ok(await t.db.get('providers', 'openrouter'));
    assert.deepEqual(t.client.getProviderPricing().openrouter['a/b'], { in: 2, out: 4 });
  });

  test('ping: lỗi được trả về và ghi log, không ném', async () => {
    const t = await setup({ responses: [jsonResponse({ error: { status: 401, message: 'Invalid API key', upstream: true } }, 401)], serverKeys: { deepseek: 1 } });
    const r = await t.client.ping('deepseek');
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    const logs = await t.logger.list({ kind: 'ping' });
    assert.equal(logs[0].level, 'error');
  });
});
