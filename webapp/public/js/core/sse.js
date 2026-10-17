/**
 * sse.js — Bộ đọc Server-Sent Events kiểu OpenAI (chat.completion.chunk). Hàm thuần, có test.
 *
 * Xử lý:
 *  - "data: {...}" nhiều dòng, CRLF, comment ":" (keep-alive), "data: [DONE]"
 *  - finish_reason ở chunk cuối, usage ở chunk riêng (stream_options.include_usage)
 *  - "event: proxy_error" do proxy chèn khi luồng upstream bị đứt
 *  - chunk {"error": {...}} do provider trả giữa luồng
 */

export class StreamError extends Error {
  constructor(message, { status = 502, code = 'STREAM_ERROR', provider = null } = {}) {
    super(message);
    this.name = 'StreamError';
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

/** Tách bộ đệm thành các sự kiện SSE hoàn chỉnh. Trả {events, rest}. */
export function splitSSE(buffer) {
  const norm = buffer.replace(/\r\n?/g, '\n');
  const parts = norm.split('\n\n');
  const rest = parts.pop();
  const events = [];
  for (const block of parts) {
    if (!block.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      let value = i === -1 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Tạo bộ tích lũy trạng thái luồng.
 * @param {{onDelta?:(delta:string, full:string)=>void}} opts
 */
export function createStreamAccumulator({ onDelta } = {}) {
  const state = { content: '', finishReason: null, usage: null, done: false, model: null, id: null, chunks: 0 };
  return {
    state,
    /** Xử lý 1 sự kiện. Ném StreamError nếu luồng báo lỗi. */
    handle(ev) {
      if (ev.event === 'proxy_error') {
        let msg = 'Luồng bị proxy ngắt';
        let status = 504;
        try { const j = JSON.parse(ev.data); msg = j.error?.message || msg; status = j.error?.status || status; } catch (_e) { /* dữ liệu lỗi không phải JSON */ }
        throw new StreamError(msg, { status, code: 'STREAM_INTERRUPTED' });
      }
      const d = ev.data.trim();
      if (!d) return;
      if (d === '[DONE]') { state.done = true; return; }
      let j;
      try { j = JSON.parse(d); } catch (_e) {
        throw new StreamError('Provider gửi dữ liệu stream không phải JSON: ' + d.slice(0, 120), { code: 'STREAM_PARSE' });
      }
      if (j.error) {
        const e = j.error;
        throw new StreamError(typeof e === 'string' ? e : e.message || 'Provider báo lỗi giữa luồng', { status: Number(e.code) || Number(e.status) || 502, code: 'STREAM_PROVIDER_ERROR' });
      }
      state.chunks++;
      if (j.model) state.model = j.model;
      if (j.id) state.id = j.id;
      if (j.usage) state.usage = j.usage;
      const ch = Array.isArray(j.choices) ? j.choices[0] : null;
      if (ch) {
        const delta = ch.delta?.content ?? ch.message?.content ?? ch.text ?? '';
        if (typeof delta === 'string' && delta) {
          state.content += delta;
          if (onDelta) onDelta(delta, state.content);
        }
        if (ch.finish_reason) state.finishReason = ch.finish_reason;
      }
    }
  };
}

/**
 * Đọc toàn bộ ReadableStream SSE.
 * @returns {Promise<{content,finishReason,usage,done,chunks}>}
 */
export async function readSSEStream(body, { onDelta, signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const acc = createStreamAccumulator({ onDelta });
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = splitSSE(buf);
      buf = rest;
      for (const ev of events) acc.handle(ev);
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const { events } = splitSSE(buf + '\n\n');
      for (const ev of events) acc.handle(ev);
    }
  } catch (e) {
    // Giữ lại phần nội dung đã nhận để bên gọi quyết định (không vứt bỏ âm thầm).
    if (e && typeof e === 'object') e.partial = acc.state.content;
    throw e;
  } finally {
    try { reader.releaseLock(); } catch (_e) { /* reader đã giải phóng */ }
  }
  return acc.state;
}
