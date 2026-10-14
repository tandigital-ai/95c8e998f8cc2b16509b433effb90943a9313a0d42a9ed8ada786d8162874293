/**
 * vault.js — Kho bí mật mã hóa cho API key (và Access Token của proxy).
 *
 * - Thuật toán: PBKDF2-SHA256 (>= 600.000 vòng) -> khóa AES-GCM 256-bit.
 * - Salt 16 byte NGẪU NHIÊN cho mỗi vault (và tạo mới khi đổi mật khẩu), lưu cùng ciphertext.
 * - IV 12 byte ngẫu nhiên cho MỖI lần mã hóa.
 * - Passphrase và khóa giải mã CHỈ nằm trong RAM. Không dùng sessionStorage/localStorage.
 * - Tự khóa sau N phút không hoạt động (cấu hình). Khi khóa: xóa bí mật khỏi RAM.
 * - Chế độ "chỉ RAM": không ghi gì xuống ổ đĩa; tải lại trang = mất key (có cảnh báo).
 * - Sai mật khẩu => báo lỗi rõ ràng (AES-GCM xác thực thất bại). KHÔNG bao giờ "đoán" là plaintext.
 */

export const VAULT_ID = 'main';
export const VAULT_FORMAT = 1;
export const MIN_ITERATIONS = 600000;
export const MIN_PASSPHRASE_LENGTH = 8;

export class VaultError extends Error {
  /** @param {'WRONG_PASSWORD'|'NO_VAULT'|'EXISTS'|'LOCKED'|'WEAK_PASSWORD'|'CORRUPT'|'NO_CRYPTO'|'MODE'} code */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Bí mật rỗng mặc định. */
export function emptySecrets() {
  return { version: 1, providers: {}, accessToken: '' };
}

function normalizeSecrets(s) {
  const out = emptySecrets();
  if (!s || typeof s !== 'object') return out;
  if (typeof s.accessToken === 'string') out.accessToken = s.accessToken;
  for (const [pid, arr] of Object.entries(s.providers || {})) {
    if (!Array.isArray(arr)) continue;
    out.providers[pid] = arr
      .filter((k) => k && typeof k.key === 'string' && k.key.trim())
      .map((k) => ({ id: String(k.id || ''), key: k.key.trim(), label: String(k.label || ''), addedAt: Number(k.addedAt) || 0 }));
  }
  return out;
}

/**
 * @param {{db:object, cryptoImpl?:Crypto, now?:()=>number, iterations?:number,
 *          setTimer?:Function, clearTimer?:Function}} opts
 */
export function createVault({
  db,
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
  iterations = MIN_ITERATIONS,
  // unref (chỉ có trong Node): timer không giữ tiến trình sống; trình duyệt bỏ qua.
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t?.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t)
} = {}) {
  if (!cryptoImpl?.subtle) throw new VaultError('NO_CRYPTO', 'Trình duyệt không hỗ trợ Web Crypto (cần HTTPS hoặc localhost).');
  if (!(iterations >= MIN_ITERATIONS)) throw new VaultError('WEAK_PASSWORD', `Số vòng PBKDF2 phải >= ${MIN_ITERATIONS}.`);
  const subtle = cryptoImpl.subtle;

  /** Trạng thái chỉ trong RAM */
  let mode = 'none'; // 'none' | 'vault' | 'memory'
  let unlocked = false;
  let aesKey = null; // CryptoKey (không export được)
  let saltB64 = null;
  let iter = iterations;
  let secrets = null;
  let autoLockMs = 15 * 60 * 1000;
  let lockTimer = null;
  let lastActivity = 0;
  const listeners = new Set();

  const emit = (type, extra = {}) => {
    for (const fn of listeners) {
      try { fn({ type, ...extra }); } catch (e) { console.error('[vault] listener lỗi', e); }
    }
  };

  async function deriveKey(passphrase, salt, iterationsUsed) {
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iterationsUsed },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptWith(key, obj) {
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    return { iv: b64(iv), ciphertext: b64(ct) };
  }

  async function readRecord() {
    return db.get('vault', VAULT_ID);
  }

  async function persist() {
    if (mode !== 'vault' || !aesKey) return;
    const rec = await readRecord();
    const { iv, ciphertext } = await encryptWith(aesKey, secrets);
    await db.put('vault', {
      id: VAULT_ID,
      format: VAULT_FORMAT,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: iter, salt: saltB64 },
      cipher: { name: 'AES-GCM', iv },
      ciphertext,
      createdAt: rec?.createdAt || now(),
      updatedAt: now()
    });
  }

  function armAutoLock() {
    if (lockTimer) clearTimer(lockTimer);
    lockTimer = null;
    if (!unlocked || mode !== 'vault' || !autoLockMs) return;
    lockTimer = setTimer(() => { lock('auto'); }, autoLockMs);
  }

  function requireUnlocked() {
    if (!unlocked || !secrets) throw new VaultError('LOCKED', 'Vault đang khóa. Hãy mở khóa trước.');
  }

  function checkPassphrase(p) {
    if (typeof p !== 'string' || p.length < MIN_PASSPHRASE_LENGTH) {
      throw new VaultError('WEAK_PASSWORD', `Mật khẩu vault phải có ít nhất ${MIN_PASSPHRASE_LENGTH} ký tự.`);
    }
  }

  function lock(reason = 'manual') {
    const was = unlocked;
    aesKey = null;
    secrets = mode === 'memory' ? secrets : null;
    if (mode === 'vault') unlocked = false;
    if (lockTimer) clearTimer(lockTimer);
    lockTimer = null;
    if (was && mode === 'vault') emit('lock', { reason });
  }

  return {
    /** Trạng thái để hiển thị (không chứa bí mật). */
    async status() {
      const rec = await readRecord();
      return {
        mode,
        exists: !!rec,
        unlocked,
        autoLockMinutes: Math.round(autoLockMs / 60000),
        iterations: rec?.kdf?.iterations || null,
        updatedAt: rec?.updatedAt || null,
        lastActivity
      };
    },
    async exists() { return !!(await readRecord()); },
    get mode() { return mode; },
    get isUnlocked() { return unlocked; },

    setAutoLockMinutes(min) {
      const m = Number(min);
      autoLockMs = Number.isFinite(m) && m > 0 ? m * 60000 : 0;
      armAutoLock();
    },

    /** Gọi khi người dùng thao tác để gia hạn auto-lock. */
    touch() {
      lastActivity = now();
      if (unlocked && mode === 'vault') armAutoLock();
    },

    /** Tạo vault mới (mã hóa, lưu bền). */
    async create(passphrase) {
      checkPassphrase(passphrase);
      if (await readRecord()) throw new VaultError('EXISTS', 'Vault đã tồn tại. Hãy mở khóa hoặc xóa vault cũ.');
      const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
      saltB64 = b64(salt);
      iter = iterations;
      aesKey = await deriveKey(passphrase, salt, iter);
      // Nếu đang ở chế độ RAM, chuyển các key hiện có vào vault.
      secrets = normalizeSecrets(mode === 'memory' ? secrets : emptySecrets());
      mode = 'vault';
      unlocked = true;
      await persist();
      lastActivity = now();
      armAutoLock();
      emit('unlock', { created: true });
      return true;
    },

    /** Mở khóa vault đã có. Sai mật khẩu => VaultError('WRONG_PASSWORD'). */
    async unlock(passphrase) {
      const rec = await readRecord();
      if (!rec) throw new VaultError('NO_VAULT', 'Chưa có vault. Hãy tạo vault mới.');
      if (rec.format !== VAULT_FORMAT || rec.kdf?.name !== 'PBKDF2' || rec.cipher?.name !== 'AES-GCM') {
        throw new VaultError('CORRUPT', 'Định dạng vault không nhận ra (có thể từ phiên bản khác).');
      }
      if (typeof passphrase !== 'string' || !passphrase) throw new VaultError('WRONG_PASSWORD', 'Chưa nhập mật khẩu.');
      const key = await deriveKey(passphrase, unb64(rec.kdf.salt), rec.kdf.iterations);
      let plain;
      try {
        plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.cipher.iv) }, key, unb64(rec.ciphertext));
      } catch (_e) {
        // AES-GCM xác thực thất bại: sai mật khẩu HOẶC dữ liệu bị hỏng. Không bao giờ coi là plaintext.
        throw new VaultError('WRONG_PASSWORD', 'Sai mật khẩu vault (hoặc dữ liệu vault đã bị thay đổi). Không có key nào được nạp.');
      }
      let obj;
      try { obj = JSON.parse(dec.decode(plain)); } catch (_e) {
        throw new VaultError('CORRUPT', 'Giải mã được nhưng nội dung vault hỏng.');
      }
      aesKey = key;
      saltB64 = rec.kdf.salt;
      iter = rec.kdf.iterations;
      secrets = normalizeSecrets(obj);
      mode = 'vault';
      unlocked = true;
      lastActivity = now();
      armAutoLock();
      emit('unlock', { created: false });
      return true;
    },

    lock,

    /** Đổi mật khẩu: tạo salt MỚI, mã hóa lại toàn bộ. */
    async changePassword(oldPass, newPass) {
      checkPassphrase(newPass);
      const rec = await readRecord();
      if (!rec) throw new VaultError('NO_VAULT', 'Chưa có vault.');
      // Xác minh mật khẩu cũ bằng cách giải mã lại (không tin trạng thái RAM).
      const key = await deriveKey(String(oldPass || ''), unb64(rec.kdf.salt), rec.kdf.iterations);
      let plain;
      try {
        plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.cipher.iv) }, key, unb64(rec.ciphertext));
      } catch (_e) {
        throw new VaultError('WRONG_PASSWORD', 'Mật khẩu cũ không đúng.');
      }
      const obj = normalizeSecrets(JSON.parse(dec.decode(plain)));
      const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
      saltB64 = b64(salt);
      iter = Math.max(iterations, rec.kdf.iterations);
      aesKey = await deriveKey(newPass, salt, iter);
      secrets = obj;
      mode = 'vault';
      unlocked = true;
      await persist();
      armAutoLock();
      emit('changed', {});
      return true;
    },

    /** Chế độ chỉ RAM: không ghi xuống đĩa. Gọi khi chưa có vault hoặc sau khi xóa vault. */
    async useMemoryOnly() {
      if (await readRecord()) throw new VaultError('MODE', 'Đang có vault lưu trên máy. Hãy xóa vault trước khi chuyển sang chế độ chỉ RAM.');
      mode = 'memory';
      unlocked = true;
      secrets = normalizeSecrets(secrets || emptySecrets());
      aesKey = null;
      emit('unlock', { memoryOnly: true });
      return true;
    },

    /** Xóa vault khỏi ổ đĩa và RAM. */
    async destroy() {
      await db.delete('vault', VAULT_ID);
      aesKey = null;
      secrets = null;
      unlocked = false;
      mode = 'none';
      if (lockTimer) clearTimer(lockTimer);
      lockTimer = null;
      emit('destroyed', {});
    },

    /** Bản sao bí mật (chỉ dùng nội bộ: keyring/llmClient). */
    getSecrets() {
      requireUnlocked();
      return JSON.parse(JSON.stringify(secrets));
    },

    /** Ghi đè toàn bộ bí mật rồi lưu (nếu chế độ vault). */
    async setSecrets(next) {
      requireUnlocked();
      secrets = normalizeSecrets(next);
      await persist();
      this.touch();
      emit('secrets', {});
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
