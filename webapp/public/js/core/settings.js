/**
 * settings.js — Cài đặt ứng dụng, lưu bền trong IndexedDB (store "settings", key "app").
 * Mọi tham số đều sửa được trong màn hình Cài đặt. Giá trị mặc định ghi rõ bên dưới.
 */

export const SETTINGS_KEY = 'app';

/** Model gợi ý cho stream_options.include_usage — CHƯA XÁC MINH với từng provider, sửa được. */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  timeZone: 'Asia/Ho_Chi_Minh',

  // Gọi AI
  temperature: 0.7,
  maxTokens: 8192,
  maxRetries: 2,
  backoffBaseMs: 1000,
  backoffMaxMs: 16000,
  maxContinueRounds: 4,
  continuePrompt: 'CONTINUE EXACTLY where you stopped. Do NOT repeat any previous text. Do NOT restart section markers. Output only the continuation.',
  streamByDefault: true,

  // Cache khớp tuyệt đối (chỉ lưu kết quả hoàn tất finish_reason=stop)
  cacheEnabled: true,
  cacheTtlHours: 6,

  // Fallback: mặc định TẮT. Chỉ dùng provider có key.
  fallbackEnabled: false,
  fallbackChain: [], // [{provider, model}]

  // Ngân sách (chỉ CẢNH BÁO + xác nhận, không chặn cứng)
  dailyBudgetUsd: 5,
  projectBudgetUsd: 2,
  confirmOverBudget: 'once', // 'once' = hỏi 1 lần/ngày/dự án · 'each' = hỏi mỗi lần gọi · 'never'

  // Bảng giá người dùng nhập: { "provider:model": { in: USD/1M, out: USD/1M } }
  pricing: {},

  // Vault
  vaultAutoLockMinutes: 15,

  // Provider: chế độ key và tùy chọn kỹ thuật
  // keyMode: 'auto' (key trình duyệt nếu có, không thì key server) | 'server' | 'client'
  providerOptions: {
    gemini: { keyMode: 'auto', streamUsage: true, selectedModel: '', extraModels: [] },
    openrouter: { keyMode: 'auto', streamUsage: true, selectedModel: '', extraModels: [] },
    mistral: { keyMode: 'auto', streamUsage: false, selectedModel: '', extraModels: [] },
    deepseek: { keyMode: 'auto', streamUsage: true, selectedModel: '', extraModels: [] },
    nvidia: { keyMode: 'auto', streamUsage: false, selectedModel: '', extraModels: [] },
    grok: { keyMode: 'auto', streamUsage: true, selectedModel: '', extraModels: [] }
  },
  activeProviders: [],

  // Lọc model không phải chat khi tải danh sách (regex, sửa được)
  modelFilterRegex: 'embed|image|tts|audio|video|moderation|whisper|dall|aqa|imagen|veo|rerank|guard',

  // Model cho từng vai trò: "provider:model" ('' = dùng model Orchestrator)
  roles: { architect: '', diagram: '', contract: '', code: '', review: '', seed: '', readme: '', analyze: '', playground: '' },

  // Lịch sử
  maxVersionsPerProject: 30,
  lastBackupAt: 0,
  currentProjectId: '',
  limitsAcknowledged: false,

  // Banner tác giả chèn vào file xuất ra — MẶC ĐỊNH TẮT
  authorBanner: { enabled: false, author: '', contact: '', tagline: '' }
});

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (!base || typeof base !== 'object') return over === undefined ? base : over;
  const out = { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function mergeSettings(saved) {
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved || {});
}

/** @param {{db:object}} opts */
export function createSettingsStore({ db }) {
  let current = mergeSettings(null);
  const listeners = new Set();
  return {
    async load() {
      const row = await db.get('settings', SETTINGS_KEY);
      current = mergeSettings(row?.value);
      return current;
    },
    get() { return current; },
    async update(patch) {
      current = deepMerge(current, patch);
      await db.put('settings', { key: SETTINGS_KEY, value: current, updatedAt: Date.now() });
      for (const fn of listeners) { try { fn(current); } catch (e) { console.error('[settings] listener lỗi', e); } }
      return current;
    },
    /** Thay HẲN 1 khóa cấp 1 (không trộn) — dùng khi xóa phần tử trong object/mảng. */
    async replace(key, value) {
      current = { ...current, [key]: value };
      await db.put('settings', { key: SETTINGS_KEY, value: current, updatedAt: Date.now() });
      for (const fn of listeners) { try { fn(current); } catch (e) { console.error('[settings] listener lỗi', e); } }
      return current;
    },
    async reset() {
      current = mergeSettings(null);
      await db.put('settings', { key: SETTINGS_KEY, value: current, updatedAt: Date.now() });
      for (const fn of listeners) { try { fn(current); } catch (e) { console.error('[settings] listener lỗi', e); } }
      return current;
    },
    providerOpt(pid) {
      return { keyMode: 'auto', streamUsage: false, selectedModel: '', extraModels: [], ...(current.providerOptions?.[pid] || {}) };
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
