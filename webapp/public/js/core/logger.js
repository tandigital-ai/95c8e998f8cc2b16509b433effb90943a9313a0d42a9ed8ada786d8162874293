/**
 * logger.js — Ghi log bền vào IndexedDB (store "logs") + phát sự kiện cho UI.
 *
 * Nguyên tắc: KHÔNG nuốt lỗi. Mọi lỗi đều đi qua logger.error() kèm ngữ cảnh.
 * Không bao giờ ghi API key: trường nào có tên giống key/token/password sẽ bị che.
 */

const SECRET_FIELD = /(^|_)(key|apikey|api_key|token|password|passphrase|secret|authorization)$/i;
const MAX_TEXT = 4000;

/** Che các trường nhạy cảm và cắt chuỗi quá dài (chỉ trong log, không ảnh hưởng dữ liệu thật). */
export function sanitizeForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + `…[+${value.length - MAX_TEXT} ký tự]` : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, status: value.status };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) && k !== 'keyIndex' && k !== 'keyId' && k !== 'keySource' ? '[REDACTED]' : sanitizeForLog(v, depth + 1);
  }
  return out;
}

/**
 * @param {{db?:object, now?:()=>number, consoleImpl?:Console, maxRows?:number}} opts
 */
export function createLogger({ db = null, now = () => Date.now(), consoleImpl = globalThis.console, maxRows = 5000 } = {}) {
  const listeners = new Set();
  let writes = 0;

  async function write(level, kind, message, context = {}) {
    const row = {
      ts: now(),
      level,
      kind,
      message: String(message ?? ''),
      projectId: context.projectId ?? null,
      context: sanitizeForLog(context)
    };
    if (db) {
      try {
        row.id = await db.add('logs', row);
        writes++;
        if (writes % 200 === 0) await prune();
      } catch (e) {
        // Không thể ghi DB: vẫn báo ra console để không mất dấu lỗi.
        consoleImpl?.error?.('[logger] Không ghi được log vào IndexedDB:', e, row);
      }
    }
    if (level === 'error') consoleImpl?.error?.(`[${kind}] ${row.message}`, row.context);
    for (const fn of listeners) {
      try { fn(row); } catch (e) { consoleImpl?.error?.('[logger] listener lỗi:', e); }
    }
    return row;
  }

  /** Giữ tối đa maxRows dòng log mới nhất. */
  async function prune() {
    if (!db) return 0;
    const total = await db.count('logs');
    if (total <= maxRows) return 0;
    const old = await db.getAll('logs', { limit: total - maxRows });
    for (const r of old) await db.delete('logs', r.id);
    return old.length;
  }

  return {
    info: (kind, msg, ctx) => write('info', kind, msg, ctx),
    warn: (kind, msg, ctx) => write('warn', kind, msg, ctx),
    error: (kind, msg, ctx) => write('error', kind, msg, ctx),
    /** Log riêng cho mỗi lần gọi LLM (kind = 'llm'). */
    llm: (entry) => write(entry.status === 'error' ? 'error' : entry.status === 'truncated' ? 'warn' : 'info', 'llm', entry.summary || 'LLM call', entry),
    onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async list({ limit = 300, kind, level } = {}) {
      if (!db) return [];
      const rows = await db.getAll('logs', { direction: 'prev', limit: kind || level ? undefined : limit });
      return rows.filter((r) => (!kind || r.kind === kind) && (!level || r.level === level)).slice(0, limit);
    },
    async clear() { if (db) await db.clear('logs'); },
    prune
  };
}
