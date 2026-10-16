/**
 * llmClient.js — Cổng gọi LLM phía trình duyệt, đi qua proxy cùng origin (/api/llm/...).
 *
 * Tính năng:
 *  - chat() (không stream) và stream() (SSE thật, có onDelta)
 *  - Chọn key: trình duyệt (vault/keyring) hoặc key server (.env) theo cấu hình từng provider
 *  - Retry + exponential backoff (+ jitter, tôn trọng Retry-After); 429 => đổi key ngay
 *  - Fallback chain (cấu hình được, MẶC ĐỊNH TẮT, chỉ dùng provider có key, có thể hỏi xác nhận)
 *  - Cache khớp tuyệt đối trong IndexedDB có TTL — chỉ lưu kết quả HOÀN TẤT (finish_reason=stop)
 *  - Hủy bằng AbortController
 *  - Tự nối khi finish_reason=length (tối đa N vòng) — vẫn bị cắt => truncated=true, KHÔNG cache
 *  - Đọc usage của provider; thiếu thì ước lượng (ký tự/4) và gắn nhãn "estimated"
 *  - Ghi log MỖI lần gọi upstream (step, provider, model, cached, latency, tokens, cost, status, error)
 */
import { readSSEStream, StreamError } from './sse.js';
import { estimateMessagesTokens, estimateTokens, computeCost, BudgetError } from './budget.js';

export const COMPLETE_FINISH = new Set(['stop', 'end_turn', 'STOP', 'eos', 'stop_sequence']);

export class LLMError extends Error {
  /**
   * @param {string} code NO_KEY|HTTP|NETWORK|ABORTED|RATE_LIMITED|TIMEOUT|BAD_RESPONSE|STREAM|BUDGET_DECLINED|PROXY_AUTH
   */
  constructor(code, message, { status = null, provider = null, model = null, retryable = false, retryAfterMs = 0, partialContent = '', cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.partialContent = partialContent;
    if (cause) this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Hàm thuần (có test)                                                 */
/* ------------------------------------------------------------------ */

/** Backoff lũy thừa có jitter ±20%, tôn trọng Retry-After. */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 16000, retryAfterMs = 0, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = exp * (0.8 + random() * 0.4);
  return Math.round(Math.min(maxMs, Math.max(jitter, retryAfterMs || 0)));
}

/** Lỗi HTTP nào đáng thử lại. */
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Ghép phần nối tiếp: bỏ đoạn lặp lại ở đầu `next` nếu trùng phần cuối `prev` (>= minOverlap ký tự).
 */
export function mergeContinuation(prev, next, { minOverlap = 20, maxScan = 600 } = {}) {
  if (!prev) return next || '';
  if (!next) return prev;
  const max = Math.min(maxScan, prev.length, next.length);
  for (let k = max; k >= minOverlap; k--) {
    if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
  }
  return prev + next;
}

/** Tạo messages cho vòng nối: giữ NGUYÊN messages gốc (kể cả ảnh/tệp) + toàn bộ phần đã sinh. */
export function buildContinueMessages(baseMessages, accumulated, continuePrompt) {
  return [...baseMessages, { role: 'assistant', content: accumulated }, { role: 'user', content: continuePrompt }];
}

/** Phân tích danh sách model trả về từ /models (định dạng OpenAI-compatible + biến thể). */
export function parseModelsResponse(json, { filterRegex = '' } = {}) {
  let arr = [];
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json?.data)) arr = json.data;
  else if (Array.isArray(json?.models)) arr = json.models;
  let re = null;
  if (filterRegex) {
    try { re = new RegExp(filterRegex, 'i'); } catch (_e) { re = null; }
  }
  const models = [];
  const pricing = {};
  const meta = {};
  const seen = new Set();
  for (const m of arr) {
    const rawId = typeof m === 'string' ? m : m?.id || m?.name || m?.slug || '';
    const id = String(rawId).replace(/^models\//, '').trim();
    if (!id || seen.has(id)) continue;
    if (re && re.test(id)) continue;
    seen.add(id);
    models.push(id);
    if (m && typeof m === 'object') {
      const p = m.pricing;
      if (p && p.prompt !== undefined && p.completion !== undefined) {
        const pin = Number(p.prompt) * 1e6;
        const pout = Number(p.completion) * 1e6;
        if (Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout >= 0) {
          pricing[id] = { in: Math.round(pin * 1e6) / 1e6, out: Math.round(pout * 1e6) / 1e6 };
        }
      }
      const mods = m.architecture?.input_modalities || m.input_modalities;
      meta[id] = {
        contextLength: Number(m.context_length || m.context_window || m.max_context_length || m.top_provider?.context_length) || null,
        vision: Array.isArray(mods) ? mods.includes('image') : null
      };
    }
  }
  models.sort((a, b) => a.localeCompare(b));
  return { models, pricing, meta };
}

/** Băm SHA-256 (hex) để làm khóa cache. */
export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function abortError(signal) {
  const r = signal?.reason;
  return new LLMError('ABORTED', r && r.message && r.message !== 'signal is aborted without reason' ? 'Đã hủy: ' + r.message : 'Đã hủy theo yêu cầu.', { retryable: false });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */
/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {{get:()=>object, providerOpt:(id)=>object}} deps.settings
 * @param {object} deps.keyring
 * @param {object} deps.budget
 * @param {object} deps.logger
 * @param {Function} [deps.fetchImpl]
 * @param {()=>string} [deps.getAccessToken]
 * @param {(providerId)=>number} [deps.getServerKeyCount]
 * @param {(info)=>Promise<boolean>} [deps.confirmFallback]
 * @param {Function} [deps.sleepImpl]
 * @param {()=>number} [deps.now]
 * @param {string} [deps.baseUrl]
 */
export function createLLMClient({
  db, settings, keyring, budget, logger,
  fetchImpl = (...a) => globalThis.fetch(...a),
  getAccessToken = () => '',
  getServerKeyCount = () => 0,
  confirmFallback = null,
  sleepImpl = sleep,
  now = () => Date.now(),
  random = Math.random,
  baseUrl = ''
}) {
  /** Giá động theo provider (vd OpenRouter): { provider: { model: {in,out} } } */
  const providerPricing = {};
  const providerMeta = {};

  /* ---------- key ---------- */
  function keyPlan(provider) {
    const mode = settings.providerOpt(provider).keyMode || 'auto';
    const clientCount = keyring.available ? keyring.count(provider) : 0;
    const serverCount = getServerKeyCount(provider) || 0;
    if (mode === 'client') return clientCount ? 'client' : null;
    if (mode === 'server') return serverCount ? 'server' : null;
    if (clientCount) return 'client';
    if (serverCount) return 'server';
    return null;
  }

  function hasKey(provider) { return keyPlan(provider) !== null; }

  function noKeyError(provider) {
    const mode = settings.providerOpt(provider).keyMode || 'auto';
    const locked = !keyring.available;
    let hint;
    if (mode === 'server') hint = `Chưa có key server: thêm KEY_${provider.toUpperCase()} vào server/.env rồi khởi động lại proxy.`;
    else if (locked) hint = 'Vault đang khóa (hoặc chưa tạo) — mở khóa để dùng key trong trình duyệt, hoặc đặt key trong server/.env.';
    else hint = 'Hãy thêm API key trong panel Providers, hoặc đặt key trong server/.env.';
    return new LLMError('NO_KEY', `Không có API key cho "${provider}". ${hint}`, { provider });
  }

  function headersFor(clientKey) {
    const h = { 'Content-Type': 'application/json' };
    const tok = getAccessToken();
    if (tok) h['X-Access-Token'] = tok;
    if (clientKey) h['X-Provider-Key'] = clientKey;
    return h;
  }

  async function readErrorBody(resp) {
    let text = '';
    try { text = await resp.text(); } catch (_e) { text = ''; }
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) return { message: j.error.message, source: j.error.source || (j.error.upstream ? 'provider' : 'proxy') };
    } catch (_e) { /* không phải JSON */ }
    return { message: text.slice(0, 300) || `HTTP ${resp.status}`, source: 'unknown' };
  }

  function parseRetryAfter(resp) {
    const h = resp.headers?.get?.('retry-after');
    if (!h) return 0;
    const n = Number(h);
    if (Number.isFinite(n)) return Math.min(n * 1000, 120000);
    const d = Date.parse(h);
    return Number.isFinite(d) ? Math.max(0, Math.min(d - now(), 120000)) : 0;
  }

  /* ---------- 1 lần gọi upstream ---------- */
  async function requestOnce({ provider, model, messages, stream, temperature, maxTokens, signal, onDelta, excludeKeys, useStreamUsage }) {
    const plan = keyPlan(provider);
    if (!plan) throw noKeyError(provider);
    let picked = null;
    if (plan === 'client') {
      picked = keyring.pick(provider, excludeKeys);
      if (!picked) {
        const wait = keyring.nextAvailableIn(provider) || 0;
        throw new LLMError('RATE_LIMITED', `Mọi key của "${provider}" đang tạm nghỉ (cooldown). Còn ~${Math.ceil(wait / 1000)}s.`, { provider, model, retryable: true, retryAfterMs: wait, status: 429 });
      }
    }
    const body = { model, messages, temperature, max_tokens: maxTokens, stream: !!stream };
    if (stream && useStreamUsage) body.stream_options = { include_usage: true };

    const started = now();
    let resp;
    try {
      resp = await fetchImpl(`${baseUrl}/api/llm/${encodeURIComponent(provider)}/chat`, {
        method: 'POST', headers: headersFor(picked?.key), body: JSON.stringify(body), signal
      });
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw new LLMError('NETWORK', 'Không kết nối được proxy: ' + (e?.message || e), { provider, model, retryable: true, cause: e });
    }
    const meta = {
      keySource: resp.headers?.get?.('x-key-source') || (picked ? 'client' : 'server'),
      keyIndex: resp.headers?.get?.('x-key-index') ?? null,
      keyId: picked?.id || null,
      keyHint: picked?.masked || null,
      latencyMs: 0,
      sentStreamUsage: !!body.stream_options
    };

    if (!resp.ok) {
      const { message, source } = await readErrorBody(resp);
      const retryAfterMs = parseRetryAfter(resp);
      if (picked) keyring.report(provider, picked.id, resp.status, { retryAfterMs });
      meta.latencyMs = now() - started;
      const isProxyAuth = resp.status === 401 && source === 'proxy';
      const err = new LLMError(isProxyAuth ? 'PROXY_AUTH' : resp.status === 429 ? 'RATE_LIMITED' : resp.status === 504 ? 'TIMEOUT' : 'HTTP',
        `${provider} HTTP ${resp.status}: ${message}`,
        { status: resp.status, provider, model, retryable: isRetryableStatus(resp.status), retryAfterMs });
      err.meta = meta;
      throw err;
    }
    if (picked) keyring.report(provider, picked.id, resp.status);

    if (stream) {
      let emitted = false;
      let st;
      try {
        st = await readSSEStream(resp.body, {
          signal,
          onDelta: (d, full) => { emitted = true; if (onDelta) onDelta(d, full); }
        });
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        const partial = e?.partial || '';
        const err = new LLMError('STREAM', `Luồng ${provider} bị lỗi: ${e?.message || e}`,
          { status: e instanceof StreamError ? e.status : 502, provider, model, retryable: !emitted, partialContent: partial, cause: e });
        err.meta = { ...meta, latencyMs: now() - started };
        err.emitted = emitted;
        throw err;
      }
      meta.latencyMs = now() - started;
      if (!st.done && !st.finishReason) {
        const err = new LLMError('STREAM', `Luồng ${provider} kết thúc bất thường (không có finish_reason/[DONE]).`, { provider, model, retryable: !emitted, partialContent: st.content });
        err.meta = meta;
        err.emitted = emitted;
        throw err;
      }
      return { content: st.content, finishReason: st.finishReason, usage: st.usage, meta, emitted };
    }

    let json;
    try { json = await resp.json(); } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw new LLMError('BAD_RESPONSE', `${provider} trả về dữ liệu không phải JSON.`, { provider, model, retryable: true, cause: e });
    }
    meta.latencyMs = now() - started;
    const ch = json?.choices?.[0];
    if (!ch) {
      const err = new LLMError('BAD_RESPONSE', `${provider} trả về phản hồi không có "choices".`, { provider, model, retryable: false });
      err.meta = meta;
      throw err;
    }
    let content = ch.message?.content ?? ch.text ?? '';
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    if (content && onDelta) onDelta(content, content);
    return { content: String(content || ''), finishReason: ch.finish_reason || null, usage: json.usage || null, meta, emitted: !!content };
  }

  /* ---------- usage + log cho 1 lần gọi ---------- */
  function usageOf(r, messages) {
    const u = r.usage;
    const inT = Number(u?.prompt_tokens);
    const outT = Number(u?.completion_tokens);
    if (Number.isFinite(inT) && Number.isFinite(outT)) return { inTokens: inT, outTokens: outT, tokenSource: 'provider' };
    return { inTokens: estimateMessagesTokens(messages).tokens, outTokens: estimateTokens(r.content || ''), tokenSource: 'estimated' };
  }

  async function logCall(entry) {
    try {
      await logger.llm(entry);
    } catch (e) {
      console.error('[llmClient] Ghi log thất bại', e);
    }
  }

  /* ---------- retry 1 provider ---------- */
  async function attemptProvider(req, emitEvent) {
    const s = settings.get();
    const maxRetries = Number.isFinite(req.maxRetries) ? req.maxRetries : s.maxRetries;
    const opt = settings.providerOpt(req.provider);
    let useStreamUsage = req.stream && opt.streamUsage !== false;
    const excludeKeys = new Set();
    let lastErr = null;
    let attempt = 0;
    let keySwaps = 0; // số lần đổi key (chỉ để báo cáo)
    while (attempt <= maxRetries) {
      if (req.signal?.aborted) throw abortError(req.signal);
      try {
        const r = await requestOnce({ ...req, excludeKeys, useStreamUsage });
        return r;
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        lastErr = e;
        const u = { inTokens: estimateMessagesTokens(req.messages).tokens, outTokens: 0, tokenSource: 'estimated' };
        await logCall({
          summary: `${req.step || 'chat'} · ${req.provider}/${req.model} · lỗi ${e.status || e.code}`,
          step: req.step || 'chat', provider: req.provider, model: req.model, projectId: req.projectId || null,
          round: req.round || 0, attempt, cached: false, stream: !!req.stream,
          latencyMs: e.meta?.latencyMs || 0, inTokens: 0, outTokens: 0, tokenSource: u.tokenSource,
          cost: null, status: 'error', error: e.message, errorCode: e.code, httpStatus: e.status,
          keySource: e.meta?.keySource || null, keyHint: e.meta?.keyHint || null
        });
        // Provider không nhận stream_options => thử lại ngay không có nó (1 lần), ghi cảnh báo.
        if (e.status === 400 && useStreamUsage && /stream_options|include_usage/i.test(e.message)) {
          useStreamUsage = false;
          await logger.warn('llm', `${req.provider} không hỗ trợ stream_options.include_usage — đã thử lại không dùng. Nên tắt "streamUsage" cho provider này trong Cài đặt.`, { provider: req.provider });
          continue;
        }
        if (e.emitted) throw e; // đã phát nội dung ra UI => không retry để tránh trùng lặp
        // Key trình duyệt bị 429/401/403 mà còn key khác => đổi key ngay, không tính vào số lần retry
        if (e.meta?.keyId && (e.status === 429 || e.status === 401 || e.status === 403)) {
          excludeKeys.add(e.meta.keyId);
          if (excludeKeys.size < keyring.count(req.provider)) {
            keySwaps++;
            emitEvent({ type: 'key-swap', provider: req.provider, status: e.status });
            continue;
          }
        }
        if (!e.retryable || attempt >= maxRetries) break;
        const wait = backoffDelay(attempt, { baseMs: s.backoffBaseMs, maxMs: s.backoffMaxMs, retryAfterMs: e.retryAfterMs, random });
        emitEvent({ type: 'retry', provider: req.provider, model: req.model, attempt: attempt + 1, maxRetries, waitMs: wait, reason: e.message });
        await sleepImpl(wait, req.signal);
        attempt++;
        excludeKeys.clear();
      }
    }
    if (lastErr && keySwaps) lastErr.keySwaps = keySwaps;
    throw lastErr || new LLMError('HTTP', 'Gọi AI thất bại không rõ lý do', { provider: req.provider });
  }

  /* ---------- cache ---------- */
  async function cacheKeyFor(req, maxRounds) {
    return sha256Hex(JSON.stringify({ v: 1, p: req.provider, m: req.model, msg: req.messages, t: req.temperature, mt: req.maxTokens, r: maxRounds }));
  }

  async function cacheGet(hash) {
    const row = await db.get('cache', hash);
    if (!row) return null;
    if (row.expiresAt <= now()) { await db.delete('cache', hash); return null; }
    return row;
  }

  /* ---------- hàm chính ---------- */
  /**
   * @param {object} req
   * @param {string} req.provider
   * @param {string} req.model
   * @param {Array} req.messages
   * @param {boolean} [req.stream]
   * @param {(delta:string, full:string)=>void} [req.onDelta]  nhận toàn văn tích lũy qua các vòng
   * @param {(ev)=>void} [req.onEvent]
   * @param {AbortSignal} [req.signal]
   * @param {boolean} [req.noCache]
   * @param {boolean} [req.autoContinue=true]
   * @param {number} [req.maxRounds]
   * @param {boolean} [req.allowFallback]  mặc định theo Cài đặt
   * @param {string} [req.step] tên bước để ghi log
   * @param {string} [req.projectId]
   * @param {boolean} [req.skipBudget]
   */
  async function complete(req) {
    const s = settings.get();
    if (!req?.provider || !req?.model) throw new LLMError('BAD_REQUEST', 'Chưa chọn provider/model.');
    if (!Array.isArray(req.messages) || !req.messages.length) throw new LLMError('BAD_REQUEST', 'Thiếu messages.');
    const emitEvent = (ev) => { try { req.onEvent?.(ev); } catch (e) { console.error('[llmClient] onEvent lỗi', e); } };
    const base = {
      provider: req.provider,
      model: req.model,
      messages: req.messages,
      stream: req.stream ?? s.streamByDefault,
      temperature: req.temperature ?? s.temperature,
      maxTokens: req.maxTokens ?? s.maxTokens,
      signal: req.signal,
      step: req.step || 'chat',
      projectId: req.projectId || null,
      maxRetries: req.maxRetries
    };
    const autoContinue = req.autoContinue !== false;
    const maxRounds = Math.max(1, autoContinue ? (req.maxRounds ?? s.maxContinueRounds) : 1);
    const useCache = s.cacheEnabled && !req.noCache;

    // ---- 1) Cache ----
    let hash = null;
    if (useCache) {
      hash = await cacheKeyFor(base, maxRounds);
      const hit = await cacheGet(hash);
      if (hit) {
        const r = { ...hit.result, cached: true, cachedAt: hit.createdAt };
        if (req.onDelta && r.content) req.onDelta(r.content, r.content);
        await logCall({
          summary: `${base.step} · ${base.provider}/${base.model} · cache`, step: base.step, provider: base.provider, model: base.model,
          projectId: base.projectId, cached: true, stream: false, latencyMs: 0, inTokens: 0, outTokens: 0, tokenSource: 'provider',
          cost: 0, status: 'ok', finishReason: r.finishReason
        });
        await budget.record({ provider: base.provider, model: base.model, inTokens: 0, outTokens: 0, tokenSource: 'provider', cost: 0, cached: true, projectId: base.projectId });
        return r;
      }
    }

    // ---- 2) Ngân sách (cảnh báo mềm) ----
    if (!req.skipBudget) {
      const inEst = estimateMessagesTokens(base.messages).tokens;
      const est = computeCost(inEst, base.maxTokens, budget.price(base.provider, base.model));
      try {
        await budget.guard({ projectId: base.projectId, estimatedCost: est.cost, label: `${base.step} (${base.provider}/${base.model})` });
      } catch (e) {
        if (e instanceof BudgetError) throw new LLMError('BUDGET_DECLINED', e.message, { provider: base.provider, model: base.model });
        throw e;
      }
    }

    // ---- 3) Gọi + tự nối ----
    let provider = base.provider;
    let model = base.model;
    let fallbackFrom = null;
    let content = '';
    let finishReason = null;
    let rounds = 0;
    let inTokens = 0;
    let outTokens = 0;
    const tokenSources = new Set();
    let knownCost = 0;
    let unknownCost = false;
    let roundError = null;
    let totalLatency = 0;
    let keySource = null;

    for (let round = 0; round < maxRounds; round++) {
      if (req.signal?.aborted) throw abortError(req.signal);
      const messages = round === 0 ? base.messages : buildContinueMessages(base.messages, content, s.continuePrompt);
      const prefix = content;
      const onDelta = req.onDelta
        ? (_d, full) => req.onDelta(_d, mergeContinuation(prefix, full))
        : undefined;
      if (round > 0) emitEvent({ type: 'continue', round, maxRounds, provider, model });

      let r;
      try {
        r = await attemptProvider({ ...base, provider, model, messages, onDelta, round }, emitEvent);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        if (round > 0) {
          // Đã có nội dung từ vòng trước: không vứt bỏ, nhưng đánh dấu bị cắt + lỗi rõ ràng.
          roundError = e;
          if (e.partialContent) content = mergeContinuation(content, e.partialContent);
          finishReason = 'length';
          break;
        }
        // ---- Fallback (chỉ ở vòng đầu) ----
        const allow = req.allowFallback ?? s.fallbackEnabled;
        const chain = (s.fallbackChain || []).filter((f) => f && f.provider && f.model && !(f.provider === provider && f.model === model));
        if (!allow || !chain.length || e.code === 'PROXY_AUTH' || e.code === 'BAD_REQUEST') throw e;
        let fbResult = null;
        let lastFbErr = e;
        for (const fb of chain) {
          if (!hasKey(fb.provider)) continue;
          if (confirmFallback) {
            const ok = await confirmFallback({ from: { provider, model }, to: fb, error: e.message, step: base.step });
            if (!ok) throw e;
          }
          emitEvent({ type: 'fallback', from: { provider, model }, to: fb, reason: e.message });
          await logger.warn('llm', `Fallback ${provider}/${model} → ${fb.provider}/${fb.model}: dữ liệu bước "${base.step}" đã được gửi sang provider khác.`, { from: provider, to: fb.provider, step: base.step, projectId: base.projectId });
          try {
            fbResult = await attemptProvider({ ...base, provider: fb.provider, model: fb.model, messages, onDelta, round }, emitEvent);
            fallbackFrom = { provider, model, error: e.message };
            provider = fb.provider;
            model = fb.model;
            break;
          } catch (fe) {
            if (fe.code === 'ABORTED') throw fe;
            lastFbErr = fe;
          }
        }
        if (!fbResult) {
          const err = new LLMError(lastFbErr.code || 'HTTP', `Tất cả provider (kể cả fallback) đều thất bại. Lỗi cuối: ${lastFbErr.message}`, { status: lastFbErr.status, provider });
          throw err;
        }
        r = fbResult;
      }

      rounds++;
      const u = usageOf(r, messages);
      tokenSources.add(u.tokenSource);
      inTokens += u.inTokens;
      outTokens += u.outTokens;
      const c = computeCost(u.inTokens, u.outTokens, budget.price(provider, model));
      if (c.cost === null) unknownCost = true; else knownCost += c.cost;
      totalLatency += r.meta.latencyMs;
      keySource = r.meta.keySource;
      content = round === 0 ? r.content : mergeContinuation(content, r.content);
      finishReason = r.finishReason;
      const willContinue = finishReason === 'length' && round + 1 < maxRounds;
      const status = finishReason === 'length' && !willContinue ? 'truncated' : 'ok';
      await logCall({
        summary: `${base.step} · ${provider}/${model}${round ? ` · vòng ${round + 1}` : ''} · ${finishReason || 'không rõ finish'}`,
        step: base.step, provider, model, projectId: base.projectId, round, cached: false, stream: !!base.stream,
        latencyMs: r.meta.latencyMs, inTokens: u.inTokens, outTokens: u.outTokens, tokenSource: u.tokenSource,
        cost: c.cost, priceSource: c.priceSource, status, finishReason, keySource: r.meta.keySource, keyHint: r.meta.keyHint,
        fallbackFrom: fallbackFrom ? `${fallbackFrom.provider}/${fallbackFrom.model}` : null
      });
      await budget.record({ provider, model, inTokens: u.inTokens, outTokens: u.outTokens, tokenSource: u.tokenSource, cost: c.cost, cached: false, projectId: base.projectId });
      if (finishReason !== 'length') break;
    }

    const truncated = finishReason === 'length';
    const tokenSource = tokenSources.size === 1 ? [...tokenSources][0] : tokenSources.size ? 'mixed' : 'estimated';
    const result = {
      content,
      finishReason,
      complete: COMPLETE_FINISH.has(finishReason),
      truncated,
      rounds,
      provider,
      model,
      requested: { provider: base.provider, model: base.model },
      fallbackFrom,
      cached: false,
      usage: { inTokens, outTokens, tokenSource },
      cost: unknownCost ? null : Math.round(knownCost * 1e8) / 1e8,
      costKnownPart: Math.round(knownCost * 1e8) / 1e8,
      costUnknown: unknownCost,
      latencyMs: totalLatency,
      keySource,
      error: roundError ? roundError.message : null
    };
    if (truncated) {
      await logger.warn('llm', `Kết quả bước "${base.step}" BỊ CẮT sau ${rounds} vòng (finish_reason=length).`, { step: base.step, provider, model, projectId: base.projectId, rounds, error: result.error });
    }
    // Chỉ cache kết quả hoàn tất, không fallback, không lỗi
    if (useCache && hash && result.complete && !truncated && !fallbackFrom) {
      const ttl = Math.max(0, Number(s.cacheTtlHours) || 0) * 3600000;
      if (ttl > 0) {
        try {
          await db.put('cache', { hash, provider, model, step: base.step, createdAt: now(), expiresAt: now() + ttl, result: { ...result } });
        } catch (e) {
          await logger.warn('cache', 'Không ghi được cache: ' + e.message, { step: base.step });
        }
      }
    }
    return result;
  }

  /* ---------- models / ping ---------- */
  async function fetchModelsRaw(provider, signal) {
    const plan = keyPlan(provider);
    if (!plan) throw noKeyError(provider);
    const picked = plan === 'client' ? keyring.pick(provider) : null;
    if (plan === 'client' && !picked) {
      const wait = keyring.nextAvailableIn(provider) || 0;
      throw new LLMError('RATE_LIMITED', `Mọi key của "${provider}" đang cooldown (~${Math.ceil(wait / 1000)}s).`, { provider, status: 429 });
    }
    const started = now();
    let resp;
    try {
      resp = await fetchImpl(`${baseUrl}/api/llm/${encodeURIComponent(provider)}/models`, { method: 'GET', headers: headersFor(picked?.key), signal });
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw new LLMError('NETWORK', 'Không kết nối được proxy: ' + (e?.message || e), { provider, cause: e });
    }
    const latencyMs = now() - started;
    if (picked) keyring.report(provider, picked.id, resp.status, { retryAfterMs: parseRetryAfter(resp) });
    if (!resp.ok) {
      const { message, source } = await readErrorBody(resp);
      throw new LLMError(resp.status === 401 && source === 'proxy' ? 'PROXY_AUTH' : 'HTTP', `${provider} HTTP ${resp.status}: ${message}`, { status: resp.status, provider });
    }
    let json;
    try { json = await resp.json(); } catch (e) {
      throw new LLMError('BAD_RESPONSE', `${provider}: danh sách model không phải JSON.`, { provider, cause: e });
    }
    return { json, latencyMs, keySource: resp.headers?.get?.('x-key-source') || plan, keyHint: picked?.masked || null };
  }

  return {
    complete,
    /** Không stream. */
    chat: (req) => complete({ ...req, stream: false }),
    /** Stream SSE thật. */
    stream: (req) => complete({ ...req, stream: true }),
    hasKey,
    keyPlan,

    /** Kiểm tra kết nối (gọi /models — không tốn token). */
    async ping(provider, { signal } = {}) {
      try {
        const r = await fetchModelsRaw(provider, signal);
        const n = parseModelsResponse(r.json).models.length;
        await logger.info('ping', `${provider}: OK (${r.latencyMs}ms, ${n} model)`, { provider, latencyMs: r.latencyMs, keySource: r.keySource });
        return { ok: true, latencyMs: r.latencyMs, modelCount: n, keySource: r.keySource, message: `Kết nối OK · ${r.latencyMs}ms` };
      } catch (e) {
        await logger.error('ping', `${provider}: ${e.message}`, { provider, code: e.code, status: e.status });
        return { ok: false, status: e.status, code: e.code, message: e.message };
      }
    },

    /** Tải danh sách model thật từ provider và lưu vào IndexedDB. */
    async loadModels(provider, { signal } = {}) {
      const s = settings.get();
      const r = await fetchModelsRaw(provider, signal);
      const parsed = parseModelsResponse(r.json, { filterRegex: s.modelFilterRegex });
      providerPricing[provider] = parsed.pricing;
      providerMeta[provider] = parsed.meta;
      const row = { providerId: provider, models: parsed.models, pricing: parsed.pricing, meta: parsed.meta, source: 'remote', fetchedAt: now() };
      await db.put('providers', row);
      await logger.info('models', `${provider}: tải ${parsed.models.length} model (${Object.keys(parsed.pricing).length} có giá)`, { provider, count: parsed.models.length });
      return row;
    },

    /** Nạp danh sách model đã lưu (khi khởi động). */
    async restoreModelCache() {
      const rows = await db.getAll('providers');
      for (const row of rows) {
        providerPricing[row.providerId] = row.pricing || {};
        providerMeta[row.providerId] = row.meta || {};
      }
      return rows;
    },

    getProviderPricing: () => providerPricing,
    getModelMeta: (provider, model) => providerMeta[provider]?.[model] || null,

    async clearCache() { await db.clear('cache'); },
    async cacheStats() {
      const rows = await db.getAll('cache');
      const t = now();
      return { entries: rows.length, expired: rows.filter((r) => r.expiresAt <= t).length };
    },
    async purgeExpiredCache() {
      return db.deleteWhere('cache', { index: 'expiresAt', query: { upper: now() } });
    }
  };
}
