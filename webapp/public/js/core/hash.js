/**
 * hash.js — Băm SHA-256 và JSON chuẩn tắc (khóa sắp xếp) để kiểm tra toàn vẹn.
 * Chạy được cả trình duyệt lẫn Node >= 20 (globalThis.crypto.subtle).
 */

const enc = new TextEncoder();

/** SHA-256 hex của chuỗi hoặc Uint8Array. */
export async function sha256Hex(input, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('Không có Web Crypto (cần HTTPS hoặc localhost).');
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  const buf = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON với khóa object được sắp xếp (để băm ổn định). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export async function hashObject(obj) {
  return sha256Hex(canonicalJson(obj));
}

/** Số byte UTF-8 của chuỗi. */
export function byteLength(text) {
  return enc.encode(String(text ?? '')).length;
}
