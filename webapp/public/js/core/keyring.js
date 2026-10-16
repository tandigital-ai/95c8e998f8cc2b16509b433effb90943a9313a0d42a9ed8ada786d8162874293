/**
 * keyring.js — Quản lý nhiều API key phía trình duyệt cho từng provider.
 *
 * - Key thật nằm trong vault (mã hóa hoặc chỉ RAM). Keyring chỉ giữ THỐNG KÊ dùng trong RAM.
 * - Chọn key: "round-robin theo mức dùng" = key ít được dùng nhất trong 60s gần nhất,
 *   hòa thì key lâu chưa dùng nhất.
 * - 429 => cooldown 65s (hoặc theo Retry-After nếu dài hơn).
 * - 401/403 => đánh dấu "không hợp lệ" và tạm ngưng 10 phút.
 * - UI chỉ thấy bản che (abcd••••wxyz), KHÔNG BAO GIỜ thấy key thật.
 */

export const COOLDOWN_429_MS = 65000;
export const INVALID_COOLDOWN_MS = 10 * 60 * 1000;
const WINDOW_MS = 60000;

/** Che key: abcd••••wxyz. Key ngắn chỉ hiện 2 ký tự cuối. */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length < 12) return '••••' + k.slice(-2);
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

function randomId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID();
  const u = new Uint8Array(16);
  cryptoImpl.getRandomValues(u);
  return [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class KeyringError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'KeyringError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * @param {{vault:object, now?:()=>number, cryptoImpl?:Crypto}} opts
 */
export function createKeyring({ vault, now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  /** stats[keyId] = { hits:number[], lastUsed, cooldownUntil, invalid, lastStatus } */
  const stats = new Map();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error('[keyring] listener lỗi', e); } } };

  const st = (id) => {
    if (!stats.has(id)) stats.set(id, { hits: [], lastUsed: 0, cooldownUntil: 0, invalid: false, lastStatus: null });
    return stats.get(id);
  };
  const recentUses = (s, t) => { s.hits = s.hits.filter((x) => t - x < WINDOW_MS); return s.hits.length; };

  function keysOf(providerId) {
    if (!vault.isUnlocked) return null;
    return vault.getSecrets().providers[providerId] || [];
  }

  return {
    /** Vault mở chưa (nếu chưa, keyring không có key client nào). */
    get available() { return vault.isUnlocked; },

    count(providerId) {
      const ks = keysOf(providerId);
      return ks ? ks.length : 0;
    },

    /** Danh sách đã che cho UI. */
    listMasked(providerId) {
      const ks = keysOf(providerId);
      if (!ks) return [];
      const t = now();
      return ks.map((k) => {
        const s = st(k.id);
        const cooling = s.cooldownUntil > t;
        return {
          id: k.id,
          label: k.label,
          masked: maskKey(k.key),
          usesLastMinute: recentUses(s, t),
          lastUsed: s.lastUsed,
          cooldownUntil: s.cooldownUntil,
          status: s.invalid ? 'invalid' : cooling ? 'cooldown' : 'ready',
          lastStatus: s.lastStatus
        };
      });
    },

    /** Thêm key (có thể nhiều key, mỗi dòng 1 key). Trả số key thêm mới (bỏ trùng). */
    async addKeys(providerId, rawText, label = '') {
      const lines = String(rawText || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) throw new KeyringError('EMPTY', 'Chưa nhập key nào.');
      for (const l of lines) {
        if (/\s/.test(l) || l.length < 8 || l.length > 512) throw new KeyringError('BAD_KEY', `Key "${maskKey(l)}" có vẻ không hợp lệ (độ dài/khoảng trắng).`);
      }
      const sec = vault.getSecrets();
      const list = sec.providers[providerId] || [];
      const existing = new Set(list.map((k) => k.key));
      let added = 0;
      for (const l of lines) {
        if (existing.has(l)) continue;
        list.push({ id: randomId(cryptoImpl), key: l, label, addedAt: now() });
        existing.add(l);
        added++;
      }
      sec.providers[providerId] = list;
      await vault.setSecrets(sec);
      emit();
      return { added, duplicates: lines.length - added, total: list.length };
    },

    async removeKey(providerId, keyId) {
      const sec = vault.getSecrets();
      const list = sec.providers[providerId] || [];
      const next = list.filter((k) => k.id !== keyId);
      if (next.length === list.length) throw new KeyringError('NOT_FOUND', 'Không tìm thấy key.');
      sec.providers[providerId] = next;
      stats.delete(keyId);
      await vault.setSecrets(sec);
      emit();
    },

    async clearProvider(providerId) {
      const sec = vault.getSecrets();
      for (const k of sec.providers[providerId] || []) stats.delete(k.id);
      delete sec.providers[providerId];
      await vault.setSecrets(sec);
      emit();
    },

    /**
     * Chọn key để gọi. CHỈ dùng nội bộ (llmClient). Trả {id, key, masked} hoặc null.
     * @param {string} providerId
     * @param {Set<string>} [exclude] id các key đã thử trong lần gọi này
     */
    pick(providerId, exclude = new Set()) {
      const ks = keysOf(providerId);
      if (!ks || !ks.length) return null;
      const t = now();
      const cands = ks
        .filter((k) => !exclude.has(k.id))
        .map((k) => ({ k, s: st(k.id) }))
        .filter(({ s }) => s.cooldownUntil <= t);
      if (!cands.length) return null;
      cands.sort((a, b) => recentUses(a.s, t) - recentUses(b.s, t) || a.s.lastUsed - b.s.lastUsed);
      const { k, s } = cands[0];
      s.hits.push(t);
      s.lastUsed = t;
      return { id: k.id, key: k.key, masked: maskKey(k.key) };
    },

    /** Báo kết quả sau mỗi request để cập nhật cooldown. */
    report(providerId, keyId, status, { retryAfterMs = 0 } = {}) {
      if (!keyId) return;
      const s = st(keyId);
      s.lastStatus = status;
      if (status === 429) s.cooldownUntil = now() + Math.max(COOLDOWN_429_MS, retryAfterMs || 0);
      else if (status === 401 || status === 403) { s.invalid = true; s.cooldownUntil = now() + INVALID_COOLDOWN_MS; }
      else if (status >= 200 && status < 300) { s.invalid = false; }
      emit();
    },

    /** ms tới khi có key hết cooldown (null nếu không có key). */
    nextAvailableIn(providerId) {
      const ks = keysOf(providerId);
      if (!ks || !ks.length) return null;
      const t = now();
      return Math.max(0, Math.min(...ks.map((k) => st(k.id).cooldownUntil)) - t);
    },

    /** Xóa cooldown thủ công (nút "Thử lại ngay"). */
    resetCooldown(keyId) {
      const s = st(keyId);
      s.cooldownUntil = 0;
      s.invalid = false;
      emit();
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
