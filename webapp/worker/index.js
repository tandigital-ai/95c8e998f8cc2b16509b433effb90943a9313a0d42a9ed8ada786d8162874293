/**
 * Cloudflare Worker — cùng API với server/index.js:
 *   GET  /api/health
 *   GET  /api/llm/:provider/models
 *   POST /api/llm/:provider/chat   (SSE pass-through nguyên vẹn khi stream:true)
 * File tĩnh (public/) do Workers Static Assets phục vụ (binding ASSETS, xem wrangler.toml).
 * Key: secret KEY_<PROVIDER>=k1,k2 hoặc header X-Provider-Key (không lưu, không log).
 * ACCESS_TOKEN (secret) — KHUYẾN NGHỊ đặt vì Worker luôn public.
 * Giới hạn so với proxy Node: rate-limit chỉ theo từng isolate (bộ nhớ), cooldown key không chia sẻ giữa isolate.
 */
import { PROVIDERS, getProvider, buildUpstreamUrl, readServerKeys, publicMeta } from '../server/providers.js';

const APP_VERSION = '0.1.0';
const BODY_LIMIT = 25 * 1024 * 1024;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PREVIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const MERMAID_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const hits = new Map(); // rate-limit đơn giản theo isolate
const cooldown = new Map(); // `${pid}:${i}` -> until
const usage = new Map();

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}
const err = (status, message, provider = null, extra) => json(status, { error: { status, message, provider } }, extra);

function withSecurity(res, pathname) {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', pathname.startsWith('/preview-frame') ? PREVIEW_CSP : pathname === '/mermaid-frame.html' ? MERMAID_CSP : CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  if (!pathname.startsWith('/preview-frame') && pathname !== '/mermaid-frame.html') h.set('X-Frame-Options', 'SAMEORIGIN');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function rateOk(ip, limit) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= limit) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  return true;
}

function pickServerKey(env, pid) {
  const keys = readServerKeys(env, pid);
  const now = Date.now();
  const avail = keys.map((k, i) => ({ k, i })).filter(({ i }) => (cooldown.get(`${pid}:${i}`) || 0) <= now);
  if (!avail.length) return null;
  avail.sort((a, b) => (usage.get(`${pid}:${a.i}`) || 0) - (usage.get(`${pid}:${b.i}`) || 0));
  const c = avail[0];
  usage.set(`${pid}:${c.i}`, (usage.get(`${pid}:${c.i}`) || 0) + 1);
  return c;
}

async function upstreamMessage(r) {
  const t = await r.text().catch(() => '');
  try { const j = JSON.parse(t); return String(j.error?.message || j.message || j.detail || t).slice(0, 600); } catch { return t.slice(0, 600) || r.statusText; }
}

async function handleApi(req, env, url) {
  const origin = req.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return err(403, 'Origin không được phép (không CORS)');
  if (req.method === 'OPTIONS') return err(405, 'Không hỗ trợ CORS');
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (!rateOk(ip, Number(env.RATE_LIMIT_PER_MIN || 120))) return err(429, 'Quá nhiều request tới proxy', null, { 'Retry-After': '60' });

  if (url.pathname === '/api/health') {
    return json(200, {
      ok: true, version: APP_VERSION, runtime: 'cloudflare-worker', time: new Date().toISOString(),
      accessTokenRequired: !!env.ACCESS_TOKEN,
      limits: { bodyLimitBytes: BODY_LIMIT, timeoutMs: 120000, streamIdleMs: 60000, rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 120) },
      providers: Object.keys(PROVIDERS).map((id) => publicMeta(id, readServerKeys(env, id).length))
    });
  }
  if (env.ACCESS_TOKEN && req.headers.get('X-Access-Token') !== env.ACCESS_TOKEN) return err(401, 'Thiếu hoặc sai Access Token của proxy (X-Access-Token)');

  const m = url.pathname.match(/^\/api\/llm\/([a-z0-9-]+)\/(chat|models)$/);
  if (!m) return err(404, 'Không tìm thấy endpoint');
  const [, pid, op] = m;
  const p = getProvider(pid);
  if (!p) return err(404, 'Provider không được hỗ trợ: ' + pid, pid);
  if ((op === 'chat' && req.method !== 'POST') || (op === 'models' && req.method !== 'GET')) return err(405, 'Method không được phép', pid);
  const target = buildUpstreamUrl(pid, op);
  if (!target) return err(400, 'Đường dẫn upstream không hợp lệ', pid);

  let body = null;
  if (op === 'chat') {
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > BODY_LIMIT) return err(413, 'Body vượt 25MB', pid);
    body = await req.text();
    if (body.length > BODY_LIMIT) return err(413, 'Body vượt 25MB', pid);
    try { JSON.parse(body); } catch { return err(400, 'Body không phải JSON hợp lệ', pid); }
  }

  const clientKey = req.headers.get('X-Provider-Key');
  const attempts = clientKey ? 1 : Math.max(1, readServerKeys(env, pid).length);
  let last = null;
  for (let a = 0; a < attempts; a++) {
    let key = clientKey, idx = null, source = 'client';
    if (!key) {
      const c = pickServerKey(env, pid);
      if (!c) return err(last?.status || 503, last?.message || `Không có key khả dụng cho ${pid} (thêm secret KEY_${pid.toUpperCase()} hoặc nhập key trong app)`, pid);
      key = c.k; idx = c.i; source = 'server';
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    let r;
    try {
      r = await fetch(target, {
        method: op === 'chat' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: op === 'chat' ? 'text/event-stream, application/json' : 'application/json', ...(p.extraHeaders || {}) },
        body, signal: ctl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      return err(e.name === 'AbortError' ? 504 : 502, (e.name === 'AbortError' ? 'Upstream quá thời gian' : 'Không kết nối được upstream: ' + e.message), pid);
    }
    const hdr = { 'X-Key-Source': source, 'X-Key-Attempts': String(a + 1), ...(idx != null ? { 'X-Key-Index': String(idx) } : {}) };
    if (!r.ok) {
      clearTimeout(timer);
      const message = await upstreamMessage(r);
      last = { status: r.status, message };
      if (source === 'server' && (r.status === 429 || r.status === 401 || r.status === 403)) {
        cooldown.set(`${pid}:${idx}`, Date.now() + (r.status === 429 ? 65000 : 600000));
        continue;
      }
      return err(r.status, message, pid, hdr);
    }
    const ct = r.headers.get('Content-Type') || 'application/json';
    if (ct.includes('text/event-stream')) clearTimeout(timer); // stream: trình duyệt tự hủy khi người dùng bấm Hủy
    else setTimeout(() => clearTimeout(timer), 0);
    return new Response(r.body, { status: 200, headers: { 'Content-Type': ct, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...hdr } });
  }
  return err(last?.status || 502, last?.message || 'Mọi key server đều lỗi', pid);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, env, url); } catch (e) { return err(500, 'Lỗi Worker: ' + (e?.message || e)); }
    }
    if (url.pathname === '/docs/LIMITATIONS.md') url.pathname = '/docs-LIMITATIONS.md';
    const res = await env.ASSETS.fetch(new Request(url, req));
    return withSecurity(res, url.pathname);
  }
};
