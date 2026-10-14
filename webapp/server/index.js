/**
 * server/index.js — Proxy LLM nhỏ gọn cho AI System Architect (dùng cá nhân). v0.2.0
 *
 * KHÔNG dependency ngoài: chỉ dùng node:http, fetch có sẵn của Node >= 20.12.
 *
 * Endpoint (giữ nguyên như cũ):
 *   GET  /api/health                     -> trạng thái + metadata provider (không lộ key/URL)
 *   GET  /api/llm/:provider/models       -> /models của provider (đã chuẩn hóa/lọc; ?all=1 để xem đủ)
 *   POST /api/llm/:provider/chat         -> /chat/completions (hỗ trợ stream SSE)
 *   GET  /docs/LIMITATIONS.md            -> nội dung trang "Giới hạn"
 *   GET  /*                              -> file tĩnh trong public/
 *
 * Bảo mật:
 *   - Allowlist provider + 2 thao tác cố định (xem providers.js) => không SSRF/open proxy.
 *   - Key: (a) server giữ trong .env  (b) client gửi header X-Provider-Key — KHÔNG lưu, KHÔNG log.
 *   - ACCESS_TOKEN tùy chọn (header X-Access-Token). Bắt buộc nếu nghe ngoài localhost.
 *   - Không bật CORS. Request /api có Origin khác host bị từ chối.
 *   - CSP chặt: script-src 'self'.
 *
 * Độ bền (v0.2.0):
 *   - Lỗi luôn có dạng {error:{status,message,provider, kind, hint, ...}} (thêm trường, không đổi cũ).
 *   - Tự thử lại lỗi tạm thời (5xx/408) với backoff + jitter, CHỈ khi chưa gửi byte nào về client.
 *   - Cooldown theo (key, model): một model hết quota không khóa các model khác.
 *   - Lỗi giữa luồng SSE được báo bằng sự kiện "proxy_error".
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS, getProvider, buildUpstreamUrl, readServerKeys, publicMeta,
  normalizeModelId, shapeModelsResponse
} from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_VERSION = '0.2.0';

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */
export function loadConfig(env = process.env) {
  const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 3000),
    accessToken: env.ACCESS_TOKEN || '',
    allowInsecurePublic: env.ALLOW_INSECURE_PUBLIC === '1',
    bodyLimitBytes: num(env.BODY_LIMIT_MB, 25) * 1024 * 1024,
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 120),
    timeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 300000),              // không-stream: model suy luận cần lâu
    firstByteMs: num(env.STREAM_FIRST_BYTE_TIMEOUT_MS, 180000),   // chờ token ĐẦU TIÊN (stream)
    streamIdleMs: num(env.STREAM_IDLE_TIMEOUT_MS, 60000),         // im lặng GIỮA các chunk
    keyCooldownMs: num(env.KEY_COOLDOWN_MS, 65000),
    invalidKeyCooldownMs: num(env.INVALID_KEY_COOLDOWN_MS, 600000),
    quotaCooldownMs: num(env.QUOTA_COOLDOWN_MS, 1800000),         // hết quota theo ngày/credit
    maxRetries: num(env.UPSTREAM_MAX_RETRIES, 2),
    retryBaseMs: num(env.RETRY_BASE_MS, 800),
    modelAutoFallback: env.MODEL_AUTOFALLBACK !== '0',
    strictStreamEnd: env.STRICT_STREAM_END !== '0',
    strictHostCheck: env.STRICT_HOST_CHECK !== '0',
    allowedHosts: String(env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    logRequests: env.LOG_REQUESTS !== '0'
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export function isLoopbackHost(h) { return LOOPBACK.has(String(h)); }

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // KHÔNG có 'unsafe-inline'. SVG Mermaid được hiển thị qua <img src=blob:> (tài liệu riêng).
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

/**
 * CSP riêng cho khung xem trước HTML do AI sinh. Khung này luôn được nhúng bằng
 * <iframe sandbox="allow-scripts"> (KHÔNG allow-same-origin) ⇒ origin mờ, không đọc được
 * IndexedDB/khóa của app. connect-src 'none' ⇒ không gửi dữ liệu ra ngoài.
 */
const PREVIEW_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN'
};
const PREVIEW_PATHS = new Set(['/preview-frame.html', '/preview-frame.js']);
/** Khung render Mermaid: script CHỈ 'self'; nới style inline (Mermaid cần để đo chữ); không mạng. */
const MERMAID_FRAME_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const MERMAID_FRAME_PATH = '/mermaid-frame.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/** Lỗi chuẩn: {error:{status,message,provider,...extra}} */
export function sendError(res, status, message, provider = null, extra = {}) {
  if (res.headersSent) { try { res.end(); } catch (_e) { /* socket đã đóng */ } return; }
  const body = JSON.stringify({ error: { status, message, provider, ...extra } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

/** So sánh hằng thời gian để chống timing attack. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Che key nếu upstream lỡ phản hồi lại nó trong thông báo lỗi. */
export function redact(text, secrets) {
  let out = String(text || '');
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

/** Giá trị an toàn để đặt vào header HTTP. */
const hv = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 300);

/** Đọc body có giới hạn kích thước (vẫn trả được 413 rõ ràng cho client). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    const chunks = [];
    let size = 0;
    let failed = false;
    const tooBig = () => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      reject(Object.assign(new Error('Body quá lớn'), { status: 413 }));
    };
    if (declared > limit) tooBig();
    req.on('data', (c) => {
      size += c.length;
      if (failed) { if (size > limit * 2) req.destroy(); return; } // xả bớt để còn gửi được 413
      if (size > limit) { tooBig(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

/** Trích thông báo lỗi dễ đọc từ phản hồi upstream. */
export function extractUpstreamMessage(text) {
  const t = String(text || '').slice(0, 4000);
  if (/^\s*</.test(t)) return 'Provider/CDN trả về trang HTML thay vì JSON (thường là lỗi 5xx hoặc bị chặn ở lớp trung gian).';
  try {
    const j = JSON.parse(t);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (e) {
      if (typeof e === 'string') return e;
      if (e.message) {
        const md = e.metadata || {};
        const who = md.provider_name ? ` [${md.provider_name}]` : '';
        const raw = md.raw ? ' — ' + (typeof md.raw === 'string' ? md.raw : JSON.stringify(md.raw)).slice(0, 300) : '';
        return String(e.message) + who + raw;
      }
    }
    if (j.message) return String(j.message);
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    if (j.title) return String(j.title);
  } catch (_e) { /* không phải JSON — dùng text thô */ }
  return t.slice(0, 500) || 'Lỗi không rõ từ provider';
}

/** Phân loại lỗi upstream → {kind, hint} để giao diện hiện thông báo rõ ràng. */
export function classifyUpstreamError(status, message = '') {
  const m = String(message).toLowerCase();
  const T = (re) => re.test(m);
  const R = (kind, hint) => ({ kind, hint });

  if (T(/location is not supported|not available in your (country|region)|unsupported (country|region)|region.{0,20}not supported/))
    return R('region', 'Provider không phục vụ khu vực của máy chủ này. Thử đổi mạng/vùng.');
  if (status === 429) {
    if (T(/per ?day|daily|insufficient_quota|out of credits|no credits|billing/))
      return R('quota', 'Hết hạn mức (theo ngày/credit) của model này. Đợi reset, đổi model/key, hoặc nâng gói.');
    return R('rate_limit', 'Vượt giới hạn tốc độ (RPM/TPM). Giảm tần suất, thêm key để xoay vòng, hoặc đổi model.');
  }
  if (status === 401 || T(/api[ _-]?key (is )?(not valid|invalid|expired)|api_key_invalid|invalid[_ ]api[_ ]key|incorrect api key|invalid (token|authentication)/))
    return R('auth', 'API key sai, hết hạn hoặc bị thu hồi. Kiểm tra lại key của provider.');
  if (status === 402 || T(/insufficient (balance|credit|funds)|payment required|out of credits|no credits|any credits|(add|purchase|buy) (more )?credits|balance is (too )?low/))
    return R('payment', 'Tài khoản hết số dư/credit. Nạp thêm hoặc dùng key khác.');
  if (status === 403 && T(/moderat|safety|policy|flagged/))
    return R('content_filter', 'Nội dung bị bộ lọc an toàn của provider chặn. Điều chỉnh yêu cầu.');
  if (status === 403)
    return R('forbidden', 'Key không có quyền dùng model này (model có thể bị giới hạn truy cập cho tài khoản). Chọn model khác.');
  if ((status === 400 || status === 422) && T(/(unsupported|unknown|unrecognized|invalid|not (supported|permitted|allowed)).{0,40}(param|field|argument|option|name)|(param|field|argument).{0,60}(not supported|unsupported|not permitted|not allowed)|extra inputs|additional properties/))
    return R('bad_param', 'Provider/model không hỗ trợ một tham số trong yêu cầu. Bỏ tham số đó (proxy tự thử bỏ tham số tùy chọn).');
  if (status === 404 || ((status === 400 || status === 422) && T(/model.{0,60}(not found|not ?exist|deprecat|decommission|no longer|unknown|invalid)|(not found|not ?exist).{0,40}model|invalid model|not a valid model/)))
    return R('model_not_found', 'Model không tồn tại, đã bị gỡ hoặc tài khoản không có quyền. Bấm "Tải models" và chọn model hiện có.');
  if (status === 413 || ((status === 400 || status === 422) && T(/context (length|window)|maximum context|too many tokens|token limit|too long|exceeds the (maximum|limit)/)))
    return R('context_length', 'Hội thoại/tệp vượt giới hạn ngữ cảnh của model. Rút gọn hoặc chọn model có ngữ cảnh dài hơn.');
  if (status === 408 || status === 504) return R('timeout', 'Provider phản hồi quá chậm. Thử lại hoặc chọn model nhanh hơn.');
  if (status === 503 || status === 529 || T(/overloaded/))
    return R('overloaded', 'Provider đang quá tải tạm thời. Đợi vài giây rồi thử lại hoặc đổi model.');
  if (status >= 500) return R('upstream', 'Lỗi phía provider. Thử lại sau hoặc đổi model/provider.');
  return R('bad_request', 'Yêu cầu bị provider từ chối. Xem chi tiết trong thông báo.');
}

/** Mô tả lỗi mạng bằng tiếng Việt thay vì "fetch failed". */
function describeNetworkError(e) {
  const code = e?.cause?.code || e?.code || '';
  const map = {
    ENOTFOUND: 'Không phân giải được tên miền của provider (lỗi DNS/mạng).',
    EAI_AGAIN: 'DNS tạm thời không phản hồi.',
    ECONNREFUSED: 'Provider từ chối kết nối.',
    ECONNRESET: 'Kết nối tới provider bị ngắt giữa chừng.',
    ETIMEDOUT: 'Kết nối tới provider quá hạn.',
    UND_ERR_CONNECT_TIMEOUT: 'Kết nối tới provider quá hạn.'
  };
  if (map[code]) return map[code];
  if (/^CERT_|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'Lỗi chứng chỉ TLS khi kết nối provider.';
  return !e?.message || e.message === 'fetch failed' ? 'Không kết nối được tới provider.' : String(e.message);
}

const OPTIONAL_PARAMS = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty',
  'logprobs', 'top_logprobs', 'seed', 'stop', 'logit_bias', 'parallel_tool_calls', 'reasoning_effort', 'stream_options'];

/** Tìm tham số tùy chọn mà provider vừa từ chối (để bỏ đi và thử lại). */
function findRejectedParam(message, payload) {
  const m = String(message).toLowerCase();
  return OPTIONAL_PARAMS.find((p) => p in payload && new RegExp(`(^|[^a-z_])${p}([^a-z_]|$)`).test(m)) || null;
}

/** Một số provider ghi sẵn thời gian chờ trong thông báo ("Please retry in 23.4s"). */
function retryFromMessage(message) {
  const mt = /retry (?:in|after)\s+([\d.]+)\s*s/i.exec(String(message));
  return mt ? Math.min(Math.ceil(Number(mt[1]) * 1000) + 500, 3600000) : 0;
}

/** Báo lỗi giữa luồng SSE (header 200 đã gửi) bằng một sự kiện riêng. */
function sseProxyError(res, status, message, providerId, kind, hint) {
  try {
    res.write(`event: proxy_error\ndata: ${JSON.stringify({ error: { status, message, provider: providerId, source: 'proxy', kind, hint } })}\n\n`);
    res.end();
  } catch (_e) { /* socket đã đóng */ }
}

/* ------------------------------------------------------------------ */
/* Rate limit đơn giản trong bộ nhớ (cửa sổ trượt 60s theo IP)         */
/* ------------------------------------------------------------------ */
export function createRateLimiter(perMin, now = () => Date.now()) {
  const hits = new Map();
  return {
    check(ip) {
      if (!perMin || perMin <= 0) return { ok: true };
      const t = now();
      const arr = (hits.get(ip) || []).filter((x) => t - x < 60000);
      if (arr.length >= perMin) {
        hits.set(ip, arr);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60000 - (t - arr[0])) / 1000)) };
      }
      arr.push(t);
      hits.set(ip, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 60000) hits.delete(k);
      return { ok: true };
    }
  };
}

/* ------------------------------------------------------------------ */
/* Pool key phía server: round-robin theo mức dùng + cooldown          */
/* Cooldown theo (key, model): 429/quota chỉ khóa model đó;            */
/* key sai/hết tiền mới khóa cả key.                                   */
/* ------------------------------------------------------------------ */
export function createServerKeyPool(env, cfg, now = () => Date.now()) {
  const pools = {};
  for (const id of Object.keys(PROVIDERS)) {
    const keys = readServerKeys(env, id);
    pools[id] = keys.map((k, i) => ({ idx: i, key: k, uses: 0, cooldownUntil: 0, lastUsed: 0, modelCd: new Map() }));
  }
  const freeAt = (k, model) => Math.max(k.cooldownUntil, model ? (k.modelCd.get(model) || 0) : 0);
  return {
    count(id) { return (pools[id] || []).length; },
    /** Chọn key ít dùng nhất không bị cooldown, trừ các index trong `exclude`. */
    pick(id, exclude = new Set(), model = '') {
      const pool = pools[id] || [];
      const t = now();
      const avail = pool.filter((k) => !exclude.has(k.idx) && freeAt(k, model) <= t);
      if (!avail.length) return null;
      avail.sort((a, b) => a.uses - b.uses || a.lastUsed - b.lastUsed || a.idx - b.idx);
      const k = avail[0];
      k.uses += 1;
      k.lastUsed = t;
      return k;
    },
    /** model rỗng = khóa cả key; có model = chỉ khóa model đó. */
    cooldown(id, idx, ms, model = '') {
      const k = (pools[id] || [])[idx];
      if (!k) return;
      if (model) k.modelCd.set(model, now() + ms); else k.cooldownUntil = now() + ms;
    },
    /** Thời gian chờ ngắn nhất tới khi có key rảnh (ms). */
    nextAvailableIn(id, model = '') {
      const pool = pools[id] || [];
      if (!pool.length) return null;
      const t = now();
      return Math.max(0, Math.min(...pool.map((k) => freeAt(k, model))) - t);
    }
  };
}

function parseRetryAfter(h) {
  if (!h) return 0;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(n * 1000, 3600000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, Math.min(d - Date.now(), 3600000)) : 0;
}

/* ------------------------------------------------------------------ */
/* Ứng dụng                                                            */
/* ------------------------------------------------------------------ */
/**
 * @param {object} opts
 * @param {object} [opts.env]        biến môi trường (mặc định process.env)
 * @param {Function} [opts.fetchImpl] fetch (cho phép mock trong test)
 * @param {string} [opts.publicDir]
 * @param {string} [opts.docsDir]
 * @param {Function} [opts.logger]
 */
export function createApp(opts = {}) {
  const env = opts.env || process.env;
  const cfg = { ...loadConfig(env), ...(opts.config || {}) };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, '..', 'public'));
  const docsDir = path.resolve(opts.docsDir || path.join(__dirname, '..', 'docs'));
  const logger = opts.logger || ((line) => console.log(line));
  const limiter = createRateLimiter(cfg.rateLimitPerMin);
  const keyPool = createServerKeyPool(env, cfg);
  const modelCache = new Map(); // providerId -> { at, ids } (từ lần /models thành công gần nhất)

  function log(req, status, started, note = '') {
    // CHỈ log method + path + status + thời gian. KHÔNG log header/body/key.
    if (!cfg.logRequests) return;
    const p = (req.url || '').split('?')[0];
    logger(`${new Date().toISOString()} ${req.method} ${p} ${status} ${Date.now() - started}ms${note ? ' ' + note : ''}`);
  }

  function clientIp(req) { return req.socket?.remoteAddress || 'unknown'; }

  /** Chặn request cross-origin vào /api (không CORS). */
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin GET thường không gửi Origin; công cụ CLI cũng vậy
    try {
      return new URL(origin).host === req.headers.host;
    } catch (_e) {
      return false;
    }
  }

  /** Chống DNS-rebinding: khi chạy localhost không token, chỉ nhận Host là localhost/127.0.0.1/::1. */
  function hostAllowed(req) {
    if (!cfg.strictHostCheck) return true;
    if (!isLoopbackHost(cfg.host) || cfg.accessToken) return true;
    const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return LOOPBACK.has(h) || cfg.allowedHosts.includes(h);
  }

  /* ---------- static ---------- */
  function serveFile(res, filePath, req, started, cacheControl = 'no-cache') {
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) { sendError(res, 404, 'Không tìm thấy'); log(req, 404, started); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': cacheControl
      });
      if (req.method === 'HEAD') { res.end(); log(req, 200, started); return; }
      const s = fs.createReadStream(filePath);
      s.on('error', () => { try { res.destroy(); } catch (_e) { /* đã đóng */ } });
      s.pipe(res);
      res.on('finish', () => log(req, 200, started));
    });
  }

  function handleStatic(req, res, pathname, started) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(res, 405, 'Method không được phép'); log(req, 405, started); return; }
    if (pathname === '/docs/LIMITATIONS.md') {
      serveFile(res, path.join(docsDir, 'LIMITATIONS.md'), req, started);
      return;
    }
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_e) { sendError(res, 400, 'Đường dẫn không hợp lệ'); log(req, 400, started); return; }
    if (rel.includes('\0')) { sendError(res, 400, 'Đường dẫn không hợp lệ'); log(req, 400, started); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.resolve(publicDir, '.' + rel);
    if (full !== publicDir && !full.startsWith(publicDir + path.sep)) {
      sendError(res, 403, 'Bị từ chối'); log(req, 403, started); return;
    }
    // Không phục vụ file ẩn (.env, .git...)
    if (full.split(path.sep).some((seg) => seg.startsWith('.') && seg.length > 1)) {
      sendError(res, 404, 'Không tìm thấy'); log(req, 404, started); return;
    }
    const cc = rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache';
    serveFile(res, full, req, started, cc);
  }

  /* ---------- health ---------- */
  function handleHealth(req, res, started) {
    const providers = Object.keys(PROVIDERS).map((id) => publicMeta(id, keyPool.count(id)));
    sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      node: process.version,
      time: new Date().toISOString(),
      accessTokenRequired: !!cfg.accessToken,
      limits: {
        bodyLimitBytes: cfg.bodyLimitBytes,
        timeoutMs: cfg.timeoutMs,
        firstByteMs: cfg.firstByteMs,
        streamIdleMs: cfg.streamIdleMs,
        rateLimitPerMin: cfg.rateLimitPerMin
      },
      providers
    });
    log(req, 200, started);
  }

  /* ---------- gợi ý model gần giống khi model bị "không tìm thấy" ---------- */
  function suggestModels(providerId, wanted) {
    const live = modelCache.get(providerId)?.ids || [];
    const pool = live.length ? live : getProvider(providerId).fallbackModels;
    const fam = String(wanted).toLowerCase().split(/[-:/_.]/)[0];
    const near = pool.filter((id) => id.toLowerCase().startsWith(fam)).slice(0, 5);
    return near.length ? near : pool.slice(0, 5);
  }

  /* ---------- thử lại có kiểm soát ---------- */
  const RETRY_STATUS = new Set([408, 500, 502, 503, 504, 529]);
  // Lỗi mạng mà request CHƯA tới được server → luôn an toàn để thử lại.
  const SAFE_NET = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
  const backoff = (n) => Math.round(Math.random() * Math.min(cfg.retryBaseMs * 2 ** n, 8000)) + 200; // full jitter
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

  /** Chỉ chạy TRƯỚC khi có byte nào gửi về client nên không bao giờ làm trùng nội dung. */
  async function fetchWithRetry(url, init, signal, retryAnyNetwork) {
    let attempt = 0;
    for (;;) {
      try {
        const r = await fetchImpl(url, { ...init, signal, redirect: 'error' });
        if (!RETRY_STATUS.has(r.status) || attempt >= cfg.maxRetries) return r;
        const wait = Math.max(parseRetryAfter(r.headers.get('retry-after')), backoff(attempt));
        if (wait > 15000) return r; // provider yêu cầu chờ lâu → báo lỗi luôn, không treo request
        try { await r.body?.cancel(); } catch (_e) { /* bỏ qua */ }
        attempt += 1;
        await sleep(wait, signal);
      } catch (e) {
        if (signal?.aborted || attempt >= cfg.maxRetries) throw e;
        if (!retryAnyNetwork && !SAFE_NET.has(e?.cause?.code)) throw e; // POST + lỗi mạng mơ hồ → không gửi lại
        attempt += 1;
        await sleep(backoff(attempt - 1), signal);
      }
    }
  }

  /* ---------- gọi upstream có xoay key server ---------- */
  /**
   * Với key server: nếu key sai/hết tiền/hết quota/bị giới hạn thì cooldown và thử key khác.
   * Body của các phản hồi lỗi đã bị đọc được lưu trong `text` — không bao giờ đọc body hai lần.
   */
  async function callUpstream({ providerId, op, method, body, clientKey, signal, model = '', stream = false }) {
    const prov = getProvider(providerId);
    const url = buildUpstreamUrl(providerId, op);
    const baseHeaders = { Accept: stream ? 'text/event-stream' : 'application/json', ...(prov.extraHeaders || {}) };
    if (method === 'POST') baseHeaders['Content-Type'] = 'application/json';
    const send = (key) => fetchWithRetry(url,
      { method, headers: { ...baseHeaders, Authorization: 'Bearer ' + key }, body },
      signal, method === 'GET');

    if (clientKey) {
      const resp = await send(clientKey);
      return { resp, text: null, keySource: 'client', keyIndex: null, attempts: 1, secrets: [clientKey] };
    }

    const n = keyPool.count(providerId);
    const tried = new Set();
    const secrets = [];
    let last = null;
    for (let i = 0; i < Math.max(1, n); i++) {
      const k = keyPool.pick(providerId, tried, model);
      if (!k) break;
      tried.add(k.idx);
      secrets.push(k.key);
      const resp = await send(k.key);
      if (![400, 401, 402, 403, 429].includes(resp.status)) {
        return { resp, text: null, keySource: 'server', keyIndex: k.idx, attempts: tried.size, secrets };
      }
      const text = await resp.text().catch(() => '');
      const entry = { resp, text, keySource: 'server', keyIndex: k.idx, attempts: tried.size, secrets };
      const msg = extractUpstreamMessage(text);
      const { kind } = classifyUpstreamError(resp.status, msg);
      const wait = Math.max(parseRetryAfter(resp.headers.get('retry-after')), retryFromMessage(msg));
      if (kind === 'auth' || kind === 'payment') keyPool.cooldown(providerId, k.idx, cfg.invalidKeyCooldownMs);      // khóa cả key
      else if (kind === 'quota') keyPool.cooldown(providerId, k.idx, Math.max(cfg.quotaCooldownMs, wait), model);     // chỉ khóa model
      else if (kind === 'rate_limit') keyPool.cooldown(providerId, k.idx, wait || cfg.keyCooldownMs, model);          // chỉ khóa model
      else if (kind !== 'forbidden' && kind !== 'region') return entry; // lỗi do yêu cầu/model → đổi key vô ích
      last = entry;
    }
    if (last) return last;
    const wait = keyPool.nextAvailableIn(providerId, model);
    const err = new Error(n
      ? `Mọi key server của ${prov.name} đang tạm nghỉ với model "${model || '*'}". Thử lại sau ~${Math.ceil((wait || 0) / 1000)}s hoặc chọn model khác.`
      : `Chưa có API key cho ${prov.name}. Thêm KEY_${providerId.toUpperCase()} vào server/.env hoặc nhập key ở trình duyệt.`);
    err.status = n ? 429 : 401;
    err.kind = n ? 'cooldown' : 'no_key';
    err.retryAfterSec = wait ? Math.ceil(wait / 1000) : undefined;
    throw err;
  }

  function sendUpstreamError(res, status, rawText, providerId, secrets, extra = {}) {
    const message = redact(extractUpstreamMessage(rawText), secrets);
    const { kind, hint } = classifyUpstreamError(status, message);
    sendError(res, status, message, providerId, { upstream: true, kind, hint, ...extra });
  }

  /* ---------- /models ---------- */
  async function handleModels(req, res, providerId, started) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), cfg.timeoutMs);
    res.on('close', () => ac.abort(new Error('client closed')));
    try {
      const clientKey = String(req.headers['x-provider-key'] || '').trim() || null;
      const showAll = new URL(req.url || '/', 'http://localhost').searchParams.get('all') === '1';
      const r = await callUpstream({ providerId, op: 'models', method: 'GET', body: undefined, clientKey, signal: ac.signal });
      const text = r.text ?? await r.resp.text();
      const meta = { 'X-Key-Source': r.keySource, 'X-Key-Attempts': String(r.attempts) };
      if (r.keyIndex !== null) meta['X-Key-Index'] = String(r.keyIndex);
      if (!r.resp.ok) {
        for (const [k, v] of Object.entries(meta)) res.setHeader(k, v);
        sendUpstreamError(res, r.resp.status, text, providerId, r.secrets);
        log(req, r.resp.status, started, providerId);
        return;
      }
      const out = shapeModelsResponse(providerId, text, showAll);
      if (out.ids.length) {
        modelCache.set(providerId, { at: Date.now(), ids: out.ids });
        const missing = getProvider(providerId).fallbackModels.filter((m) => !out.ids.includes(m));
        if (missing.length) meta['X-Fallback-Missing'] = hv(missing.join(',')); // model gợi ý đã biến mất
      }
      if (out.hidden) meta['X-Models-Hidden'] = String(out.hidden);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...meta });
      res.end(out.body);
      log(req, 200, started, providerId);
    } catch (e) {
      const aborted = ac.signal.aborted;
      const status = e.status || (aborted ? 504 : 502);
      if (e.retryAfterSec) res.setHeader('Retry-After', String(e.retryAfterSec));
      sendError(res, status,
        aborted ? `Hết thời gian chờ provider (${Math.round(cfg.timeoutMs / 1000)}s).` : (e.kind ? e.message : describeNetworkError(e)),
        providerId, { source: 'proxy', kind: e.kind || (aborted ? 'timeout' : 'network') });
      log(req, status, started, providerId);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- /chat ---------- */
  async function handleChat(req, res, providerId, started) {
    let raw;
    try {
      raw = await readBody(req, cfg.bodyLimitBytes);
    } catch (e) {
      sendError(res, e.status || 400,
        e.status === 413 ? `Body vượt giới hạn ${Math.round(cfg.bodyLimitBytes / 1048576)}MB (ảnh/tệp đính kèm quá lớn)` : 'Không đọc được body',
        providerId, { source: 'proxy' });
      log(req, e.status || 400, started, providerId);
      return;
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch (_e) {
      sendError(res, 400, 'Body phải là JSON hợp lệ', providerId); log(req, 400, started, providerId); return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendError(res, 400, 'Body phải là object JSON', providerId); log(req, 400, started, providerId); return;
    }
    if (typeof payload.model !== 'string' || !payload.model.trim()) {
      sendError(res, 400, 'Thiếu "model"', providerId); log(req, 400, started, providerId); return;
    }
    if (!Array.isArray(payload.messages) || !payload.messages.length) {
      sendError(res, 400, 'Thiếu "messages"', providerId); log(req, 400, started, providerId); return;
    }
    const isStream = payload.stream === true;
    payload.model = normalizeModelId(providerId, payload.model);
    const requestedModel = payload.model;
    const clientKey = String(req.headers['x-provider-key'] || '').trim() || null;

    const ac = new AbortController();
    let timer = null;
    const armTimer = (ms, why) => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error(why)), ms);
    };
    const firstWaitMs = isStream ? cfg.firstByteMs : cfg.timeoutMs;
    armTimer(firstWaitMs, 'timeout');
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; ac.abort(new Error('client closed')); } });

    const dropped = [];
    let aliasUsed = false;
    let up;
    try {
      for (let guard = 0; ; guard++) {
        up = await callUpstream({
          providerId, op: 'chat', method: 'POST', body: JSON.stringify(payload), clientKey,
          signal: ac.signal, model: payload.model, stream: isStream
        });
        if (up.resp.ok || guard >= 3) break;
        up.text = up.text ?? await up.resp.text().catch(() => '');
        const msg = extractUpstreamMessage(up.text);
        const cls = classifyUpstreamError(up.resp.status, msg);
        if (cls.kind === 'bad_param') {                        // tham số tùy chọn bị từ chối → bỏ đi và thử lại
          const p = findRejectedParam(msg, payload);
          if (p) { delete payload[p]; dropped.push(p); continue; }
        }
        if (cfg.modelAutoFallback && cls.kind === 'model_not_found' && !aliasUsed) { // model đã gỡ → bản thay thế chính thức
          const alt = getProvider(providerId).modelAliases?.[payload.model];
          if (alt && alt !== payload.model) { aliasUsed = true; payload.model = alt; continue; }
        }
        break;
      }
    } catch (e) {
      clearTimeout(timer);
      if (clientGone) { log(req, 499, started, providerId + ' client-closed'); return; }
      const aborted = ac.signal.aborted;
      const status = e.status || (aborted ? 504 : 502);
      if (e.retryAfterSec) res.setHeader('Retry-After', String(e.retryAfterSec));
      sendError(res, status,
        aborted
          ? `Hết thời gian chờ provider (${Math.round(firstWaitMs / 1000)}s). Model suy luận có thể cần lâu hơn: tăng UPSTREAM_TIMEOUT_MS / STREAM_FIRST_BYTE_TIMEOUT_MS hoặc chọn model nhanh hơn.`
          : (e.kind ? e.message : describeNetworkError(e)),
        providerId, { source: 'proxy', kind: e.kind || (aborted ? 'timeout' : 'network') });
      log(req, status, started, providerId);
      return;
    }

    const meta = {
      'X-Key-Source': up.keySource,
      'X-Key-Attempts': String(up.attempts),
      'X-Model-Requested': hv(requestedModel),
      'X-Model-Used': hv(payload.model)
    };
    if (up.keyIndex !== null) meta['X-Key-Index'] = String(up.keyIndex);
    if (aliasUsed) meta['X-Model-Fallback'] = 'alias';
    if (dropped.length) meta['X-Proxy-Dropped-Params'] = dropped.join(',');
    const ra = up.resp.headers.get('retry-after');

    if (!up.resp.ok) {
      const text = up.text ?? await up.resp.text().catch(() => '');
      clearTimeout(timer);
      for (const [k, v] of Object.entries(meta)) res.setHeader(k, v);
      if (ra) res.setHeader('Retry-After', ra);
      const cls = classifyUpstreamError(up.resp.status, extractUpstreamMessage(text));
      sendUpstreamError(res, up.resp.status, text, providerId, up.secrets,
        cls.kind === 'model_not_found' ? { suggestions: suggestModels(providerId, payload.model) } : {});
      log(req, up.resp.status, started, providerId);
      return;
    }

    if (!isStream) {
      try {
        const text = await up.resp.text();
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(text); } catch (_e) { /* không phải JSON */ }
        if (j && j.error && !Array.isArray(j.choices)) {       // lỗi nằm trong HTTP 200 (vd. OpenRouter)
          const code = Number(j.error.code);
          const st = code >= 400 && code <= 599 ? code : 502;
          for (const [k, v] of Object.entries(meta)) res.setHeader(k, v);
          sendUpstreamError(res, st, text, providerId, up.secrets);
          log(req, st, started, providerId + ' error-in-200');
          return;
        }
        const c0 = j?.choices?.[0];
        if (c0 && c0.finish_reason === 'length' && !c0.message?.content && !c0.message?.tool_calls?.length) {
          meta['X-Proxy-Warning'] = 'empty-completion-length'; // model suy luận đã dùng hết max_tokens cho phần "nghĩ"
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...meta });
        res.end(text);
        log(req, 200, started, providerId);
      } catch (e) {
        clearTimeout(timer);
        if (clientGone) { log(req, 499, started, providerId + ' client-closed'); return; }
        const aborted = ac.signal.aborted;
        sendError(res, aborted ? 504 : 502, aborted ? 'Hết thời gian chờ provider' : 'Đứt kết nối khi đọc phản hồi', providerId,
          { source: 'proxy', kind: aborted ? 'timeout' : 'network' });
        log(req, aborted ? 504 : 502, started, providerId);
      }
      return;
    }

    // ---- STREAM SSE: pipe từng chunk; token đầu được chờ lâu hơn, các chunk sau chờ ngắn hơn ----
    res.writeHead(200, {
      'Content-Type': up.resp.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      ...meta
    });
    res.flushHeaders?.();
    const reader = up.resp.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      sseProxyError(res, 502, 'Provider trả luồng rỗng.', providerId, 'upstream', 'Thử lại hoặc đổi model.');
      log(req, 502, started, providerId + ' stream-empty');
      return;
    }
    // reader.read() không tự hủy theo signal => race với abort, rồi cancel reader.
    const abortP = new Promise((_res, rej) => {
      if (ac.signal.aborted) rej(ac.signal.reason);
      ac.signal.addEventListener('abort', () => rej(ac.signal.reason), { once: true });
    });
    abortP.catch(() => { /* được xử lý qua Promise.race bên dưới */ });
    const decoder = new TextDecoder();
    let tail = '';
    let sawEnd = false;
    let first = true;
    try {
      for (;;) {
        armTimer(first ? cfg.firstByteMs : cfg.streamIdleMs, 'idle');
        const { done, value } = await Promise.race([reader.read(), abortP]);
        if (done) break;
        first = false;
        if (!sawEnd) {
          tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
          sawEnd = /data:\s*\[DONE\]/.test(tail) || /"finish_reason"\s*:\s*"[a-z_]+"/.test(tail);
        }
        if (!res.write(Buffer.from(value))) {
          await Promise.race([new Promise((r) => res.once('drain', r)), abortP]); // không treo nếu client ngắt
        }
      }
      clearTimeout(timer);
      if (!sawEnd && cfg.strictStreamEnd) {
        sseProxyError(res, 502,
          'Provider đóng luồng sớm (thiếu [DONE]/finish_reason) — câu trả lời có thể bị cắt.',
          providerId, 'upstream', 'Hãy tạo lại câu trả lời; nếu lặp lại thì đổi model.');
        log(req, 502, started, providerId + ' stream-truncated');
        return;
      }
      res.end();
      log(req, 200, started, providerId + ' stream');
    } catch (_e) {
      clearTimeout(timer);
      reader.cancel().catch(() => { /* upstream đã đóng */ });
      if (clientGone) { log(req, 499, started, providerId + ' stream client-closed'); return; }
      const idle = ac.signal.aborted;
      const sec = Math.round((first ? cfg.firstByteMs : cfg.streamIdleMs) / 1000);
      sseProxyError(res, 504,
        idle ? `Luồng im lặng quá ${sec}s` : 'Đứt kết nối với provider giữa chừng',
        providerId, idle ? 'timeout' : 'network',
        'Câu trả lời có thể đã bị cắt dở. Hãy tạo lại; với model suy luận có thể tăng STREAM_FIRST_BYTE_TIMEOUT_MS.');
      log(req, 504, started, providerId + ' stream-error');
    }
  }

  /* ---------- router ---------- */
  async function route(req, res) {
    const started = Date.now();
    setSecurityHeaders(res);
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch (_e) { sendError(res, 400, 'URL không hợp lệ'); return; }
    const pathname = url.pathname;

    if (PREVIEW_PATHS.has(pathname)) {
      for (const k of Object.keys(SECURITY_HEADERS)) res.removeHeader(k);
      for (const [k, v] of Object.entries(PREVIEW_HEADERS)) res.setHeader(k, v);
    } else if (pathname === MERMAID_FRAME_PATH) {
      for (const k of Object.keys(SECURITY_HEADERS)) res.removeHeader(k);
      for (const [k, v] of Object.entries(MERMAID_FRAME_HEADERS)) res.setHeader(k, v);
    }
    if (!pathname.startsWith('/api/')) { handleStatic(req, res, pathname, started); return; }

    if (req.method === 'OPTIONS') { sendError(res, 405, 'Không hỗ trợ CORS'); log(req, 405, started); return; }
    if (!hostAllowed(req)) {
      sendError(res, 403, 'Host không được phép. Nếu bạn truy cập bằng tên miền riêng, hãy đặt ALLOWED_HOSTS trong server/.env.', null, { source: 'proxy' });
      log(req, 403, started); return;
    }
    if (!originAllowed(req)) { sendError(res, 403, 'Origin không được phép (proxy không bật CORS)'); log(req, 403, started); return; }

    const rl = limiter.check(clientIp(req));
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, `Proxy: quá ${cfg.rateLimitPerMin} request/phút. Thử lại sau ${rl.retryAfterSec}s.`, null, { source: 'proxy', kind: 'rate_limit' });
      log(req, 429, started); return;
    }

    if (pathname === '/api/health') {
      if (req.method !== 'GET') { sendError(res, 405, 'Method không được phép'); log(req, 405, started); return; }
      // health luôn mở để UI biết có cần token hay không; không chứa bí mật.
      handleHealth(req, res, started); return;
    }

    if (cfg.accessToken) {
      const tok = req.headers['x-access-token'];
      if (!tok || !safeEqual(tok, cfg.accessToken)) {
        sendError(res, 401, 'Thiếu hoặc sai Access Token của proxy (X-Access-Token)', null, { source: 'proxy', kind: 'proxy_auth' });
        log(req, 401, started); return;
      }
    }

    const m = pathname.match(/^\/api\/llm\/([^/]+)\/([^/]+)$/);
    if (!m) { sendError(res, 404, 'Endpoint không tồn tại'); log(req, 404, started); return; }
    const providerId = m[1];
    const op = m[2];
    if (!getProvider(providerId)) { sendError(res, 404, 'Provider không nằm trong allowlist', providerId); log(req, 404, started); return; }
    if (op === 'models') {
      if (req.method !== 'GET') { sendError(res, 405, 'Dùng GET cho /models', providerId); log(req, 405, started); return; }
      await handleModels(req, res, providerId, started); return;
    }
    if (op === 'chat') {
      if (req.method !== 'POST') { sendError(res, 405, 'Dùng POST cho /chat', providerId); log(req, 405, started); return; }
      await handleChat(req, res, providerId, started); return;
    }
    sendError(res, 404, 'Thao tác không được phép (chỉ chat | models)', providerId);
    log(req, 404, started);
  }

  /** Lưới an toàn: lỗi bất ngờ trong route không được làm sập cả tiến trình. */
  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      logger(`${new Date().toISOString()} UNHANDLED ${req.method} ${(req.url || '').split('?')[0]} ${e?.name}: ${e?.message}`);
      if (!res.headersSent) sendError(res, 500, 'Lỗi nội bộ của proxy. Xem log máy chủ.', null, { source: 'proxy', kind: 'internal' });
      else { try { res.end(); } catch (_e) { /* đã đóng */ } }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Khởi động                                                           */
/* ------------------------------------------------------------------ */
export function startServer(env = process.env) {
  const cfg = loadConfig(env);
  if (!isLoopbackHost(cfg.host) && !cfg.accessToken && !cfg.allowInsecurePublic) {
    console.error(`[TỪ CHỐI KHỞI ĐỘNG] HOST=${cfg.host} mở ra mạng nhưng chưa đặt ACCESS_TOKEN.\n` +
      'Hãy đặt ACCESS_TOKEN trong server/.env (hoặc dùng HOST=127.0.0.1).');
    process.exit(1);
  }
  const server = http.createServer(createApp({ env }));
  server.headersTimeout = 30000;
  server.requestTimeout = 0; // stream có thể dài; idle timeout đã xử lý riêng
  server.listen(cfg.port, cfg.host, () => {
    const keyInfo = Object.keys(PROVIDERS).map((id) => `${id}:${readServerKeys(env, id).length}`).join(' ');
    console.log(`AI System Architect proxy v${APP_VERSION} — http://${cfg.host}:${cfg.port}`);
    console.log(`Key server (số lượng): ${keyInfo}`);
    console.log(`Access token: ${cfg.accessToken ? 'BẬT' : 'tắt'} · Body tối đa: ${Math.round(cfg.bodyLimitBytes / 1048576)}MB`);
  });
  return server;
}

const SELF = fileURLToPath(import.meta.url);
// PM2 chạy file qua tiến trình bao (argv[1] là ProcessContainerFork) nhưng đặt pm_exec_path = file thật.
const isMain = [process.argv[1], process.env.pm_exec_path].some((p) => p && path.resolve(p) === SELF);
if (isMain) {
  // Một lỗi bất ngờ không được làm chết cả server đang phục vụ các luồng khác.
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.name, e?.message));
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
    else console.warn('Node quá cũ để đọc .env (cần >= 20.12). Bỏ qua server/.env.');
  }
  startServer(process.env);
}
