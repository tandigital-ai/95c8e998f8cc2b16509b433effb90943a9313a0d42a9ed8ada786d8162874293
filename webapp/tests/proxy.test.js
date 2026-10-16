import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, redact, extractUpstreamMessage, createRateLimiter, isLoopbackHost } from '../server/index.js';
import { buildUpstreamUrl, getProvider, readServerKeys, PROVIDERS } from '../server/providers.js';
import { listen, jsonResponse, sseResponse, silentLogger } from './helpers.js';

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

async function withApp({ env = {}, fetchImpl, config = {} }, run) {
  const app = createApp({ env: { LOG_REQUESTS: '0', ...env }, fetchImpl, logger: silentLogger, config });
  const srv = await listen(app);
  try { await run(srv.url); } finally { await srv.close(); }
}

describe('providers allowlist', () => {
  test('chỉ dựng URL cho provider + thao tác hợp lệ', () => {
    assert.equal(buildUpstreamUrl('deepseek', 'chat'), 'https://api.deepseek.com/chat/completions');
    assert.equal(buildUpstreamUrl('gemini', 'models'), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
    assert.equal(buildUpstreamUrl('evil', 'chat'), null);
    assert.equal(buildUpstreamUrl('deepseek', 'embeddings'), null);
    assert.equal(buildUpstreamUrl('__proto__', 'chat'), null);
    assert.equal(buildUpstreamUrl('constructor', 'chat'), null);
    assert.equal(getProvider('../x'), null);
  });
  test('mọi provider đều https', () => {
    for (const id of Object.keys(PROVIDERS)) {
      assert.match(buildUpstreamUrl(id, 'chat'), /^https:\/\//);
      assert.match(buildUpstreamUrl(id, 'models'), /^https:\/\//);
    }
  });
  test('đọc nhiều key server từ env', () => {
    assert.deepEqual(readServerKeys({ KEY_GEMINI: 'aaa, bbb ,,ccc' }, 'gemini'), ['aaa', 'bbb', 'ccc']);
    assert.deepEqual(readServerKeys({}, 'gemini'), []);
  });
});

describe('proxy HTTP', () => {
  test('từ chối provider lạ và path lạ, KHÔNG gọi upstream', async () => {
    const f = mockFetch(() => jsonResponse({}));
    await withApp({ fetchImpl: f, env: { KEY_DEEPSEEK: 'sk-server-123456' } }, async (url) => {
      let r = await fetch(url + '/api/llm/evil/chat', { method: 'POST', body: '{}' });
      assert.equal(r.status, 404);
      const j = await r.json();
      assert.equal(j.error.status, 404);
      assert.equal(j.error.provider, 'evil');
      r = await fetch(url + '/api/llm/deepseek/embeddings', { method: 'POST', body: '{}' });
      assert.equal(r.status, 404);
      r = await fetch(url + '/api/llm/deepseek/chat/extra', { method: 'POST', body: '{}' });
      assert.equal(r.status, 404);
      r = await fetch(url + '/api/llm/deepseek/models', { method: 'POST' });
      assert.equal(r.status, 405);
      r = await fetch(url + '/api/llm/deepseek/chat', { method: 'GET' });
      assert.equal(r.status, 405);
      r = await fetch(url + '/api/other');
      assert.equal(r.status, 404);
    });
    assert.equal(f.calls.length, 0);
  });

  test('client không thể điều khiển URL upstream', async () => {
    const f = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
    await withApp({ fetchImpl: f, env: { KEY_DEEPSEEK: 'sk-server-123456' } }, async (url) => {
      const r = await fetch(url + '/api/llm/deepseek/chat?url=http://169.254.169.254/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Upstream-Url': 'http://evil.example' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], baseUrl: 'http://evil' })
      });
      assert.equal(r.status, 200);
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.deepseek.com/chat/completions');
  });

  test('chặn Origin lạ (không CORS) và OPTIONS', async () => {
    const f = mockFetch(() => jsonResponse({}));
    await withApp({ fetchImpl: f }, async (url) => {
      let r = await fetch(url + '/api/llm/deepseek/models', { headers: { Origin: 'https://evil.example' } });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      r = await fetch(url + '/api/llm/deepseek/chat', { method: 'OPTIONS' });
      assert.equal(r.status, 405);
    });
    assert.equal(f.calls.length, 0);
  });

  test('ACCESS_TOKEN: thiếu/sai => 401, đúng => qua', async () => {
    const f = mockFetch(() => jsonResponse({ data: [{ id: 'm1' }] }));
    await withApp({ fetchImpl: f, env: { ACCESS_TOKEN: 'secret-token', KEY_MISTRAL: 'k-1234567890' } }, async (url) => {
      let r = await fetch(url + '/api/llm/mistral/models');
      assert.equal(r.status, 401);
      r = await fetch(url + '/api/llm/mistral/models', { headers: { 'X-Access-Token': 'wrong' } });
      assert.equal(r.status, 401);
      r = await fetch(url + '/api/llm/mistral/models', { headers: { 'X-Access-Token': 'secret-token' } });
      assert.equal(r.status, 200);
      // health luôn mở và báo token đang bật
      r = await fetch(url + '/api/health');
      const h = await r.json();
      assert.equal(h.accessTokenRequired, true);
    });
    assert.equal(f.calls.length, 1);
  });

  test('key server được dùng; key client (X-Provider-Key) được ưu tiên và không lưu', async () => {
    const f = mockFetch(() => jsonResponse({ data: [] }));
    await withApp({ fetchImpl: f, env: { KEY_GROK: 'xai-server-key-1' } }, async (url) => {
      let r = await fetch(url + '/api/llm/grok/models');
      assert.equal(r.headers.get('x-key-source'), 'server');
      r = await fetch(url + '/api/llm/grok/models', { headers: { 'X-Provider-Key': 'xai-client-key-9' } });
      assert.equal(r.headers.get('x-key-source'), 'client');
    });
    assert.equal(f.calls[0].init.headers.Authorization, 'Bearer xai-server-key-1');
    assert.equal(f.calls[1].init.headers.Authorization, 'Bearer xai-client-key-9');
  });

  test('không có key => 401 JSON chuẩn, không gọi upstream', async () => {
    const f = mockFetch(() => jsonResponse({}));
    await withApp({ fetchImpl: f }, async (url) => {
      const r = await fetch(url + '/api/llm/nvidia/models');
      assert.equal(r.status, 401);
      const j = await r.json();
      assert.equal(j.error.provider, 'nvidia');
      assert.match(j.error.message, /KEY_NVIDIA/);
    });
    assert.equal(f.calls.length, 0);
  });

  test('xoay key server khi 429 rồi thành công', async () => {
    const f = mockFetch((u, init, n) => (n === 1 ? jsonResponse({ error: { message: 'rate' } }, 429) : jsonResponse({ data: [{ id: 'a' }] })));
    await withApp({ fetchImpl: f, env: { KEY_OPENROUTER: 'or-key-aaaaaa,or-key-bbbbbb' } }, async (url) => {
      const r = await fetch(url + '/api/llm/openrouter/models');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-key-attempts'), '2');
    });
    const auths = f.calls.map((c) => c.init.headers.Authorization);
    assert.equal(new Set(auths).size, 2);
  });

  test('lỗi upstream trả {error:{status,message,provider}} và che key', async () => {
    const f = mockFetch(() => jsonResponse({ error: { message: 'Invalid key sk-leaky-123456789' } }, 400));
    await withApp({ fetchImpl: f }, async (url) => {
      const r = await fetch(url + '/api/llm/deepseek/chat', {
        method: 'POST', headers: { 'X-Provider-Key': 'sk-leaky-123456789' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.error.status, 400);
      assert.equal(j.error.provider, 'deepseek');
      assert.ok(!j.error.message.includes('sk-leaky-123456789'));
      assert.match(j.error.message, /REDACTED/);
    });
  });

  test('validate body: JSON hỏng, thiếu model/messages', async () => {
    const f = mockFetch(() => jsonResponse({}));
    await withApp({ fetchImpl: f, env: { KEY_DEEPSEEK: 'k-1234567890' } }, async (url) => {
      let r = await fetch(url + '/api/llm/deepseek/chat', { method: 'POST', body: '{bad' });
      assert.equal(r.status, 400);
      r = await fetch(url + '/api/llm/deepseek/chat', { method: 'POST', body: JSON.stringify({ messages: [{}] }) });
      assert.equal(r.status, 400);
      r = await fetch(url + '/api/llm/deepseek/chat', { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
      assert.equal(r.status, 400);
    });
    assert.equal(f.calls.length, 0);
  });

  test('giới hạn kích thước body => 413', async () => {
    const f = mockFetch(() => jsonResponse({}));
    await withApp({ fetchImpl: f, env: { KEY_DEEPSEEK: 'k-1234567890', BODY_LIMIT_MB: '0.001' } }, async (url) => {
      const big = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'a'.repeat(5000) }] });
      const r = await fetch(url + '/api/llm/deepseek/chat', { method: 'POST', body: big });
      assert.equal(r.status, 413);
    });
    assert.equal(f.calls.length, 0);
  });

  test('stream SSE được chuyển tiếp từng chunk', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Xin "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"chào"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ];
    const f = mockFetch(() => sseResponse(chunks, { delayMs: 5 }));
    await withApp({ fetchImpl: f, env: { KEY_GEMINI: 'g-1234567890' } }, async (url) => {
      const r = await fetch(url + '/api/llm/gemini/chat', {
        method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /event-stream/);
      const text = await r.text();
      assert.equal(text, chunks.join(''));
    });
    assert.equal(f.calls[0].init.headers.Accept, 'text/event-stream');
  });

  test('stream im lặng quá lâu => sự kiện proxy_error', async () => {
    const f = mockFetch(() => {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(ctrl) { ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await withApp({ fetchImpl: f, env: { KEY_GEMINI: 'g-1234567890', STREAM_IDLE_TIMEOUT_MS: '80' } }, async (url) => {
      const r = await fetch(url + '/api/llm/gemini/chat', {
        method: 'POST', body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
      });
      const text = await r.text();
      assert.match(text, /event: proxy_error/);
    });
  });

  test('timeout không stream => 504', async () => {
    const f = mockFetch((u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    await withApp({ fetchImpl: f, env: { KEY_GEMINI: 'g-1234567890', UPSTREAM_TIMEOUT_MS: '60' } }, async (url) => {
      const r = await fetch(url + '/api/llm/gemini/chat', {
        method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.equal(r.status, 504);
    });
  });

  test('header bảo mật + static an toàn', async () => {
    await withApp({ fetchImpl: mockFetch(() => jsonResponse({})) }, async (url) => {
      let r = await fetch(url + '/');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      r = await fetch(url + '/%2e%2e/server/.env.example');
      assert.ok([403, 404].includes(r.status));
      r = await fetch(url + '/..%2f..%2fpackage.json');
      assert.ok([403, 404].includes(r.status));
      r = await fetch(url + '/docs/LIMITATIONS.md');
      assert.equal(r.status, 200);
      r = await fetch(url + '/api/health');
      const h = await r.json();
      assert.equal(h.ok, true);
      assert.ok(!JSON.stringify(h).includes('https://api.'));
    });
  });

  test('rate limit trong bộ nhớ', async () => {
    await withApp({ fetchImpl: mockFetch(() => jsonResponse({})), env: { RATE_LIMIT_PER_MIN: '2' } }, async (url) => {
      await fetch(url + '/api/health');
      await fetch(url + '/api/health');
      const r = await fetch(url + '/api/health');
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
    });
  });
});

describe('tiện ích proxy', () => {
  test('redact', () => {
    assert.equal(redact('key=abcdef123 end', ['abcdef123']), 'key=[REDACTED] end');
    assert.equal(redact('abc', ['ab']), 'abc');
  });
  test('extractUpstreamMessage', () => {
    assert.equal(extractUpstreamMessage('{"error":{"message":"bad"}}'), 'bad');
    assert.equal(extractUpstreamMessage('[{"error":{"message":"g"}}]'), 'g');
    assert.equal(extractUpstreamMessage('plain'), 'plain');
  });
  test('rate limiter cửa sổ trượt', () => {
    let t = 0;
    const rl = createRateLimiter(2, () => t);
    assert.ok(rl.check('a').ok);
    assert.ok(rl.check('a').ok);
    assert.equal(rl.check('a').ok, false);
    t = 61000;
    assert.ok(rl.check('a').ok);
  });
  test('isLoopbackHost', () => {
    assert.ok(isLoopbackHost('127.0.0.1'));
    assert.equal(isLoopbackHost('0.0.0.0'), false);
  });
});
