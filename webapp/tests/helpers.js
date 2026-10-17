// Tiện ích dùng chung cho test.
import http from 'node:http';

/** Khởi động app trên cổng ngẫu nhiên, trả {url, close}. */
export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

/** Tạo Response JSON giả. */
export function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Tạo Response SSE giả từ danh sách chunk chuỗi. */
export function sseResponse(chunks, { status = 200, delayMs = 0, headers = {} } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        ctrl.enqueue(enc.encode(c));
      }
      ctrl.close();
    }
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** Đồng hồ giả điều khiển được. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

export const silentLogger = () => {};
