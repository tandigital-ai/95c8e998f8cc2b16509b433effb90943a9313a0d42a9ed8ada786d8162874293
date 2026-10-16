/**
 * providers.js — ALLOWLIST provider phía server (chống SSRF / open proxy). v0.3.0
 *
 * - Client CHỈ gửi providerId. Base URL và path do server tra ở đây.
 * - Chỉ cho phép 2 thao tác: "chat" (POST /chat/completions) và "models" (GET /models).
 * - fallbackModels chỉ là GỢI Ý hiển thị. Danh sách thật lấy động qua /models.
 * - failoverModels: thứ tự model DỰ PHÒNG khi model đang dùng bị 429 / 503 / 404 / 402.
 *   Xếp theo nguyên tắc "rẻ & ổn định trước" (flash/small trước pro/large).
 * - freeModels: gợi ý model MIỄN PHÍ (dùng khi tài khoản hết credit — lỗi 402).
 *   Danh sách thật được ưu tiên lấy từ pricing trong /models.
 * - modelAliases: bảng "model cũ → model thay thế chính thức". Proxy CHỈ dùng khi provider
 *   báo model cũ không còn tồn tại (không tự đổi model khi model vẫn chạy bình thường).
 *
 * Muốn thêm provider OpenAI-compatible khác: thêm 1 mục vào PROVIDERS, đặt key vào
 * .env dạng KEY_<ID_IN_HOA>=k1,k2 — không cần sửa chỗ nào khác.
 */

/** @typedef {{id:string,name:string,baseUrl:string,chatPath:string,modelsPath:string,
 *   extraHeaders?:Record<string,string>,fallbackModels:string[],failoverModels?:string[],
 *   freeModels?:string[],fallbackVerified?:boolean,fallbackCheckedAt?:string,
 *   modelAliases?:Record<string,string>,docsUrl?:string,notes?:string}} ProviderDef */

/** @type {Readonly<Record<string, ProviderDef>>} */
export const PROVIDERS = Object.freeze({
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    // Endpoint tương thích OpenAI của Gemini
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    // Đối chiếu trang models + deprecations của Google ngày 09/10/2026.
    fallbackModels: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
    // Dòng "pro" hay 429/503 ở free tier ⇒ ưu tiên flash khi phải đổi model.
    failoverModels: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
    freeModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'],
    fallbackVerified: true,
    fallbackCheckedAt: '2026-10-09',
    modelAliases: {
      'gemini-2.0-flash': 'gemini-3.6-flash',
      'gemini-2.0-flash-001': 'gemini-3.6-flash',
      'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite',
      'gemini-2.0-flash-lite-001': 'gemini-3.1-flash-lite',
      'gemini-3-flash-preview': 'gemini-3.6-flash',
      'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
      // Google hạn chế truy cập dòng 2.5 với dự án/key mới → nếu bị báo "không tìm thấy" thì chuyển sang bản mới.
      'gemini-2.5-flash': 'gemini-3.8-flash',
      'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
      'gemini-2.5-pro': 'gemini-3.1-pro-preview'
    },
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    notes: 'Dùng endpoint OpenAI-compatible. Lấy key tại Google AI Studio. Dòng "pro" ở gói miễn phí rất hay 429/503 — proxy sẽ tự chuyển sang "flash".'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    extraHeaders: { 'X-Title': 'AI System Architect (personal)' },
    fallbackModels: ['openrouter/auto'],
    failoverModels: ['openrouter/auto'],
    // Gợi ý TĨNH: tên model free của OpenRouter thay đổi liên tục.
    // Bấm "Tải models" trong app để proxy lấy danh sách free THẬT (pricing = 0).
    freeModels: [
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-coder:free',
      'mistralai/mistral-small-3.2-24b-instruct:free',
      'google/gemma-3-27b-it:free'
    ],
    docsUrl: 'https://openrouter.ai/docs',
    notes: 'Tài khoản chưa nạp credit chỉ dùng được model có hậu tố ":free" (và số dư không được âm). Danh sách model kèm giá — app dùng giá này nếu có.'
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    fallbackModels: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    failoverModels: ['mistral-small-latest', 'codestral-latest', 'mistral-large-latest'],
    freeModels: ['mistral-small-latest'],
    docsUrl: 'https://docs.mistral.ai/'
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    // deepseek-chat / deepseek-reasoner đã bị ngừng. Tên hiện hành theo trang pricing của DeepSeek.
    fallbackModels: ['deepseek-flash', 'deepseek-v4-pro'],
    failoverModels: ['deepseek-flash', 'deepseek-v4-pro'],
    freeModels: [],
    fallbackVerified: true,
    fallbackCheckedAt: '2026-10-09',
    modelAliases: {
      'deepseek-chat': 'deepseek-flash',
      'deepseek-reasoner': 'deepseek-flash'
    },
    docsUrl: 'https://api-docs.deepseek.com/',
    notes: 'deepseek-flash mặc định chạy chế độ suy luận (thinking) nên token đầu tiên có thể đến chậm.'
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    fallbackModels: ['meta/llama-3.3-70b-instruct'],
    failoverModels: ['meta/llama-3.3-70b-instruct'],
    freeModels: ['meta/llama-3.3-70b-instruct'],
    docsUrl: 'https://docs.api.nvidia.com/',
    notes: 'Danh mục model NIM thay đổi thường xuyên — hãy bấm "Tải models" để lấy danh sách thật.'
  },
  grok: {
    id: 'grok',
    name: 'Grok (xAI)',
    baseUrl: 'https://api.x.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    fallbackModels: ['grok-4.7'],
    failoverModels: ['grok-4.7'],
    freeModels: [],
    fallbackVerified: true,
    fallbackCheckedAt: '2026-10-09',
    docsUrl: 'https://docs.x.ai/',
    notes: 'Nên bấm "Tải models" để lấy tên model thật theo tài khoản.'
  }
});

/** Hai thao tác duy nhất được phép. */
export const ALLOWED_OPS = Object.freeze(['chat', 'models']);

const ID_RE = /^[a-z0-9_-]{1,32}$/;

/** Trả về định nghĩa provider hoặc null nếu không nằm trong allowlist. */
export function getProvider(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/**
 * Dựng URL upstream từ allowlist. Không bao giờ nhận URL/path từ client.
 * @param {string} providerId
 * @param {'chat'|'models'} op
 * @returns {string|null}
 */
export function buildUpstreamUrl(providerId, op) {
  const p = getProvider(providerId);
  if (!p || !ALLOWED_OPS.includes(op)) return null;
  const path = op === 'chat' ? p.chatPath : p.modelsPath;
  const url = new URL(p.baseUrl + path);
  // Phòng thủ chiều sâu: host phải trùng host của baseUrl, chỉ https.
  if (url.protocol !== 'https:' || url.host !== new URL(p.baseUrl).host) return null;
  return url.toString();
}

/** Tên biến môi trường chứa key của provider: KEY_GEMINI, KEY_OPENROUTER... */
export function envKeyName(providerId) {
  return 'KEY_' + String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Đọc danh sách key server từ env (phân tách bằng dấu phẩy hoặc xuống dòng). */
export function readServerKeys(env, providerId) {
  const raw = env[envKeyName(providerId)];
  if (!raw) return [];
  return String(raw).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Chuẩn hóa ID model (Gemini đôi khi trả/nhận dạng "models/xxx"). */
export function normalizeModelId(providerId, id) {
  let s = String(id || '').trim();
  if (providerId === 'gemini') s = s.replace(/^models\//, '');
  return s;
}

// Model KHÔNG dùng được với /chat/completions (embedding, giọng nói, ảnh, video, nhạc, agent...).
const NON_CHAT_SUBSTR = /(embed|rerank|whisper|tts|imagen|veo-|lyria|moderation|reward|guard|banana|transcribe|deep-research|antigravity|computer-use|robotics|-image|image-)/i;
const NON_CHAT_TOKEN = /(^|[-_/.:])(live|omni|ocr|stt|aqa|voice|speech|dall-e|sdxl)([-_/.:]|$)/i;

export function isLikelyChatModel(providerId, id) {
  if (providerId === 'openrouter' || providerId === 'deepseek') return true;
  const s = String(id);
  return !(NON_CHAT_SUBSTR.test(s) || NON_CHAT_TOKEN.test(s));
}

/** Giá 0 cho cả input lẫn output ⇒ model miễn phí (dùng được khi tài khoản 0 credit). */
export function isFreePricing(p) {
  if (!p) return false;
  const a = Number(p.prompt);
  const b = Number(p.completion);
  return Number.isFinite(a) && Number.isFinite(b) && a === 0 && b === 0;
}

/**
 * Chuẩn hóa + lọc danh sách /models. showAll=true để xem đầy đủ (thêm ?all=1 vào URL).
 * Bộ lọc không bao giờ làm danh sách rỗng.
 * Trả thêm `pricing` để proxy biết model nào miễn phí (phục vụ failover khi lỗi 402).
 */
export function shapeModelsResponse(providerId, text, showAll = false) {
  let j;
  try { j = JSON.parse(text); } catch (_e) { return { body: text, ids: [], hidden: 0, pricing: {} }; }
  const list = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
  if (!list) return { body: text, ids: [], hidden: 0, pricing: {} };
  const seen = new Set();
  const items = [];
  for (const m of list) {
    const o = typeof m === 'string' ? { id: m } : m;
    if (!o || typeof o.id !== 'string') continue;
    const id = normalizeModelId(providerId, o.id);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ ...o, id });
  }
  let kept = showAll ? items : items.filter((m) => isLikelyChatModel(providerId, m.id));
  if (!kept.length) kept = items;
  const pricing = {};
  for (const m of kept) if (m.pricing) pricing[m.id] = m.pricing;
  return {
    body: JSON.stringify({ ...(Array.isArray(j) ? {} : j), object: 'list', data: kept }),
    ids: kept.map((m) => m.id),
    hidden: items.length - kept.length,
    pricing
  };
}

/**
 * Thứ tự model dự phòng cho failover.
 * @param {string} providerId
 * @param {object} o
 * @param {string[]} [o.liveIds]   danh sách model thật từ lần /models gần nhất
 * @param {object}   [o.pricing]   bảng giá từ /models (để lọc model miễn phí)
 * @param {string[]} [o.envList]   danh sách do người dùng ép trong .env (FAILOVER_<PROVIDER>)
 * @param {boolean}  [o.freeOnly]  chỉ lấy model miễn phí (dùng khi lỗi 402)
 * @param {Set<string>} [o.exclude] model đã thử rồi
 * @returns {string[]}
 */
export function failoverCandidates(providerId, {
  liveIds = [], pricing = {}, envList = [], freeOnly = false, exclude = new Set()
} = {}) {
  const p = getProvider(providerId);
  if (!p) return [];
  let base;
  if (freeOnly) {
    const liveFree = liveIds.filter((id) => isFreePricing(pricing[id]));
    base = [...liveFree, ...(p.freeModels || [])];
  } else if (envList.length) {
    base = envList.slice();
  } else {
    base = [...(p.failoverModels || []), ...p.fallbackModels];
  }
  // Ưu tiên model CHẮC CHẮN tồn tại theo danh sách thật; nếu chưa từng tải /models thì dùng gợi ý tĩnh.
  if (liveIds.length) {
    const verified = base.filter((id) => liveIds.includes(id));
    if (verified.length) base = verified;
  }
  const out = [];
  for (const id of base) {
    if (!id || exclude.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** Metadata công khai cho client (KHÔNG chứa URL, KHÔNG chứa key). */
export function publicMeta(providerId, serverKeyCount) {
  const p = getProvider(providerId);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    fallbackModels: p.fallbackModels.slice(),
    failoverModels: (p.failoverModels || []).slice(),
    freeModels: (p.freeModels || []).slice(),
    fallbackVerified: p.fallbackVerified === true,
    fallbackCheckedAt: p.fallbackCheckedAt || '',
    docsUrl: p.docsUrl || '',
    notes: p.notes || '',
    serverKeyCount: typeof serverKeyCount === 'number' ? serverKeyCount : null
  };
}
