/**
 * db.js — Lớp lưu trữ IndexedDB có versioning/migration + bản "bộ nhớ" cùng API (dùng cho test
 * và làm phương án dự phòng khi trình duyệt chặn IndexedDB).
 *
 * API chung (mọi hàm đều async):
 *   get(store, key) · put(store, value) · add(store, value) · delete(store, key)
 *   getAll(store, {index, query, limit, direction}) · count(store, {index, query}) · clear(store)
 *   exportAll({includeCache, includeVault}) · importAll(data, {mode})
 *
 * Store "versions" là BẤT BIẾN: put() lên bản đã tồn tại sẽ bị từ chối.
 */

export const DB_NAME = 'ai-architect';
export const DB_VERSION = 1;
export const BACKUP_FORMAT = 'ai-architect-backup';

/** Định nghĩa schema từng store (dùng chung cho IndexedDB và bộ nhớ). */
export const SCHEMA = {
  settings: { keyPath: 'key' },
  providers: { keyPath: 'providerId' },
  vault: { keyPath: 'id' },
  projects: { keyPath: 'id', indexes: { updatedAt: 'updatedAt' } },
  versions: { keyPath: 'id', indexes: { projectId: 'projectId', projectId_createdAt: ['projectId', 'createdAt'] } },
  files: { keyPath: ['projectId', 'path'], indexes: { projectId: 'projectId', state: 'state' } },
  jobs: { keyPath: 'id', indexes: { projectId: 'projectId', status: 'status', updatedAt: 'updatedAt' } },
  logs: { keyPath: 'id', autoIncrement: true, indexes: { ts: 'ts', kind: 'kind', level: 'level', projectId: 'projectId' } },
  cache: { keyPath: 'hash', indexes: { expiresAt: 'expiresAt' } },
  usage: { keyPath: 'id', indexes: { date: 'date', projectId: 'projectId' } }
};

export const STORE_NAMES = Object.keys(SCHEMA);
const IMMUTABLE_STORES = new Set(['versions']);

/**
 * Migration theo phiên bản. Mỗi hàm nhận (db, tx) trong onupgradeneeded.
 * Thêm phiên bản mới: tăng DB_VERSION và thêm MIGRATIONS[n].
 */
const MIGRATIONS = {
  1(db) {
    for (const [name, def] of Object.entries(SCHEMA)) {
      if (db.objectStoreNames.contains(name)) continue;
      const os = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
      for (const [idx, kp] of Object.entries(def.indexes || {})) os.createIndex(idx, kp, { unique: false });
    }
  }
};

export class DBError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DBError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function assertStore(name) {
  if (!SCHEMA[name]) throw new DBError('UNKNOWN_STORE', `Store không tồn tại: ${name}`);
}

/* ------------------------------------------------------------------ */
/* So sánh key kiểu IndexedDB (number < string < array)               */
/* ------------------------------------------------------------------ */
function typeRank(v) {
  if (typeof v === 'number') return 1;
  if (v instanceof Date) return 2;
  if (typeof v === 'string') return 3;
  if (Array.isArray(v)) return 4;
  return 0;
}
export function compareKeys(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 4) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  const va = ra === 2 ? a.getTime() : a;
  const vb = rb === 2 ? b.getTime() : b;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

function extractKey(obj, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((k) => obj?.[k]);
  return obj?.[keyPath];
}

function validKey(k) {
  if (k === undefined || k === null) return false;
  if (Array.isArray(k)) return k.every(validKey);
  return typeof k === 'number' ? Number.isFinite(k) : typeof k === 'string' || k instanceof Date;
}

/** query: giá trị cụ thể | {lower, upper, lowerOpen, upperOpen} */
function inRange(key, query) {
  if (query === undefined || query === null) return true;
  if (typeof query === 'object' && !Array.isArray(query) && !(query instanceof Date) && ('lower' in query || 'upper' in query)) {
    if (query.lower !== undefined) {
      const c = compareKeys(key, query.lower);
      if (c < 0 || (c === 0 && query.lowerOpen)) return false;
    }
    if (query.upper !== undefined) {
      const c = compareKeys(key, query.upper);
      if (c > 0 || (c === 0 && query.upperOpen)) return false;
    }
    return true;
  }
  return compareKeys(key, query) === 0;
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/* ------------------------------------------------------------------ */
/* Tuần tự hóa cho export/import JSON                                  */
/* ------------------------------------------------------------------ */
function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function serializeValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { __type: 'Date', v: v.toISOString() };
  if (v instanceof Uint8Array) return { __type: 'Uint8Array', v: bytesToB64(v) };
  if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', v: bytesToB64(new Uint8Array(v)) };
  if (typeof Blob !== 'undefined' && v instanceof Blob) {
    return { __type: 'Blob', mime: v.type, v: bytesToB64(new Uint8Array(await v.arrayBuffer())) };
  }
  if (Array.isArray(v)) return Promise.all(v.map(serializeValue));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = await serializeValue(val);
  return out;
}

function deserializeValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deserializeValue);
  if (v.__type === 'Date') return new Date(v.v);
  if (v.__type === 'Uint8Array') return b64ToBytes(v.v);
  if (v.__type === 'ArrayBuffer') return b64ToBytes(v.v).buffer;
  if (v.__type === 'Blob') return typeof Blob !== 'undefined' ? new Blob([b64ToBytes(v.v)], { type: v.mime || '' }) : b64ToBytes(v.v);
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = deserializeValue(val);
  return out;
}

/* ------------------------------------------------------------------ */
/* Phần chung export/import                                            */
/* ------------------------------------------------------------------ */
function withBackup(api) {
  api.exportAll = async function exportAll({ includeCache = false, includeVault = false } = {}) {
    const stores = {};
    for (const name of STORE_NAMES) {
      if (name === 'cache' && !includeCache) continue;
      if (name === 'vault' && !includeVault) continue;
      const rows = await api.getAll(name);
      stores[name] = await Promise.all(rows.map(serializeValue));
    }
    return {
      format: BACKUP_FORMAT,
      schemaVersion: DB_VERSION,
      exportedAt: new Date().toISOString(),
      note: includeVault ? 'Bản sao lưu AI System Architect. CÓ kèm vault (vẫn MÃ HÓA).' : 'Bản sao lưu AI System Architect. KHÔNG kèm khóa API (vault).',
      includesVault: !!includeVault,
      stores
    };
  };

  /**
   * @param {object} data  nội dung file sao lưu
   * @param {{mode?:'merge'|'replace'}} opts
   */
  api.importAll = async function importAll(data, { mode = 'merge' } = {}) {
    if (!data || data.format !== BACKUP_FORMAT) throw new DBError('BAD_BACKUP', 'File không phải bản sao lưu AI System Architect.');
    if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_VERSION) {
      throw new DBError('BAD_BACKUP', `Bản sao lưu có schema v${data.schemaVersion}, app chỉ hỗ trợ tới v${DB_VERSION}.`);
    }
    if (!data.stores || typeof data.stores !== 'object') throw new DBError('BAD_BACKUP', 'Bản sao lưu thiếu dữ liệu.');
    const unknown = Object.keys(data.stores).filter((s) => !SCHEMA[s]);
    if (unknown.length) throw new DBError('BAD_BACKUP', `Store lạ trong bản sao lưu: ${unknown.join(', ')}`);
    const result = { imported: {}, skipped: {} };
    for (const [name, rows] of Object.entries(data.stores)) {
      if (!Array.isArray(rows)) throw new DBError('BAD_BACKUP', `Store ${name} không phải mảng.`);
      if (mode === 'replace') await api.clear(name);
      let n = 0;
      let skip = 0;
      for (const raw of rows) {
        const row = deserializeValue(raw);
        if (IMMUTABLE_STORES.has(name)) {
          const key = extractKey(row, SCHEMA[name].keyPath);
          if (await api.get(name, key)) { skip++; continue; }
          await api.add(name, row);
        } else {
          await api.put(name, row);
        }
        n++;
      }
      result.imported[name] = n;
      result.skipped[name] = skip;
    }
    return result;
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Bản bộ nhớ (test / dự phòng)                                        */
/* ------------------------------------------------------------------ */
export function createMemoryDB() {
  const data = {};
  const seq = {};
  for (const n of STORE_NAMES) { data[n] = new Map(); seq[n] = 0; }
  const k2s = (k) => JSON.stringify(k instanceof Date ? { d: k.getTime() } : k);

  const api = {
    kind: 'memory',
    persistent: false,
    async get(store, key) {
      assertStore(store);
      const v = data[store].get(k2s(key));
      return v === undefined ? undefined : clone(v);
    },
    async put(store, value) {
      assertStore(store);
      const def = SCHEMA[store];
      const v = clone(value);
      let key = extractKey(v, def.keyPath);
      if (!validKey(key)) {
        if (def.autoIncrement && !Array.isArray(def.keyPath)) { key = ++seq[store]; v[def.keyPath] = key; }
        else throw new DBError('BAD_KEY', `Thiếu khóa ${JSON.stringify(def.keyPath)} cho store ${store}`);
      } else if (def.autoIncrement && typeof key === 'number' && key > seq[store]) seq[store] = key;
      if (IMMUTABLE_STORES.has(store) && data[store].has(k2s(key))) {
        throw new DBError('IMMUTABLE', `Bản ghi trong "${store}" là bất biến, không thể ghi đè.`);
      }
      data[store].set(k2s(key), v);
      return key;
    },
    async add(store, value) {
      assertStore(store);
      const def = SCHEMA[store];
      const key = extractKey(value, def.keyPath);
      if (validKey(key) && data[store].has(k2s(key))) throw new DBError('EXISTS', `Bản ghi đã tồn tại trong ${store}`);
      return api.put(store, value);
    },
    async delete(store, key) {
      // Lưu ý: "versions" cho phép XÓA (khi xóa cả dự án) nhưng không cho SỬA.
      assertStore(store);
      data[store].delete(k2s(key));
    },
    async getAll(store, { index, query, limit, direction = 'next' } = {}) {
      assertStore(store);
      const def = SCHEMA[store];
      const kp = index ? def.indexes?.[index] : def.keyPath;
      if (index && !kp) throw new DBError('UNKNOWN_INDEX', `Index không tồn tại: ${store}.${index}`);
      let rows = [...data[store].values()]
        .map((v) => ({ v, k: extractKey(v, kp), pk: extractKey(v, def.keyPath) }))
        .filter((r) => validKey(r.k) && inRange(r.k, query));
      rows.sort((a, b) => compareKeys(a.k, b.k) || compareKeys(a.pk, b.pk));
      if (direction === 'prev') rows.reverse();
      if (limit) rows = rows.slice(0, limit);
      return rows.map((r) => clone(r.v));
    },
    async count(store, opts = {}) {
      return (await api.getAll(store, opts)).length;
    },
    async clear(store) {
      assertStore(store);
      data[store].clear();
    },
    async deleteWhere(store, opts) {
      const rows = await api.getAll(store, opts);
      for (const r of rows) data[store].delete(k2s(extractKey(r, SCHEMA[store].keyPath)));
      return rows.length;
    },
    close() {}
  };
  return withBackup(api);
}

/* ------------------------------------------------------------------ */
/* Bản IndexedDB                                                       */
/* ------------------------------------------------------------------ */
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function toRange(query) {
  if (query === undefined || query === null) return undefined;
  if (typeof query === 'object' && !Array.isArray(query) && !(query instanceof Date) && ('lower' in query || 'upper' in query)) {
    if (query.lower !== undefined && query.upper !== undefined) return IDBKeyRange.bound(query.lower, query.upper, !!query.lowerOpen, !!query.upperOpen);
    if (query.lower !== undefined) return IDBKeyRange.lowerBound(query.lower, !!query.lowerOpen);
    return IDBKeyRange.upperBound(query.upper, !!query.upperOpen);
  }
  return IDBKeyRange.only(query);
}

/**
 * Mở IndexedDB. Ném DBError nếu trình duyệt chặn (chế độ riêng tư, quota...).
 * @param {{idb?: IDBFactory, name?: string, onBlocked?: Function}} opts
 */
export async function openIndexedDB({ idb = globalThis.indexedDB, name = DB_NAME, onBlocked } = {}) {
  if (!idb) throw new DBError('NO_IDB', 'Trình duyệt không hỗ trợ IndexedDB.');
  const db = await new Promise((resolve, reject) => {
    let req;
    try { req = idb.open(name, DB_VERSION); } catch (e) { reject(new DBError('OPEN_FAILED', 'Không mở được IndexedDB: ' + e.message, e)); return; }
    req.onupgradeneeded = (ev) => {
      const d = req.result;
      const tx = req.transaction;
      for (let v = (ev.oldVersion || 0) + 1; v <= DB_VERSION; v++) {
        if (!MIGRATIONS[v]) throw new Error('Thiếu migration v' + v);
        MIGRATIONS[v](d, tx);
      }
    };
    req.onblocked = () => { if (onBlocked) onBlocked(); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new DBError('OPEN_FAILED', 'Không mở được IndexedDB: ' + (req.error?.message || 'lỗi không rõ'), req.error));
  });
  db.onversionchange = () => db.close();

  const run = async (store, mode, fn) => {
    assertStore(store);
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DBError('ABORTED', 'Giao dịch bị hủy'));
    });
    const result = await fn(os);
    await done;
    return result;
  };

  const api = {
    kind: 'indexeddb',
    persistent: true,
    get: (store, key) => run(store, 'readonly', (os) => reqP(os.get(key))),
    async put(store, value) {
      if (IMMUTABLE_STORES.has(store)) {
        const key = extractKey(value, SCHEMA[store].keyPath);
        return run(store, 'readwrite', async (os) => {
          const exist = await reqP(os.get(key));
          if (exist !== undefined) throw new DBError('IMMUTABLE', `Bản ghi trong "${store}" là bất biến, không thể ghi đè.`);
          return reqP(os.add(value));
        });
      }
      return run(store, 'readwrite', (os) => reqP(os.put(value)));
    },
    async add(store, value) {
      try {
        return await run(store, 'readwrite', (os) => reqP(os.add(value)));
      } catch (e) {
        if (e && e.name === 'ConstraintError') throw new DBError('EXISTS', `Bản ghi đã tồn tại trong ${store}`, e);
        throw e;
      }
    },
    delete: (store, key) => run(store, 'readwrite', (os) => reqP(os.delete(key))),
    getAll(store, { index, query, limit, direction = 'next' } = {}) {
      return run(store, 'readonly', (os) => {
        const src = index ? os.index(index) : os;
        const range = toRange(query);
        if (direction === 'next' && !limit) return reqP(src.getAll(range));
        return new Promise((resolve, reject) => {
          const out = [];
          const req = src.openCursor(range, direction);
          req.onsuccess = () => {
            const c = req.result;
            if (!c || (limit && out.length >= limit)) { resolve(out); return; }
            out.push(c.value);
            c.continue();
          };
          req.onerror = () => reject(req.error);
        });
      });
    },
    count(store, { index, query } = {}) {
      return run(store, 'readonly', (os) => reqP((index ? os.index(index) : os).count(toRange(query))));
    },
    clear: (store) => run(store, 'readwrite', (os) => reqP(os.clear())),
    deleteWhere(store, { index, query } = {}) {
      return run(store, 'readwrite', (os) => new Promise((resolve, reject) => {
        let n = 0;
        const req = (index ? os.index(index) : os).openCursor(toRange(query));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) { resolve(n); return; }
          c.delete(); n++; c.continue();
        };
        req.onerror = () => reject(req.error);
      }));
    },
    close() { db.close(); }
  };
  return withBackup(api);
}

/**
 * Xin trình duyệt lưu trữ bền (không tự xóa khi thiếu dung lượng).
 * @returns {Promise<{supported:boolean, persisted:boolean, usage?:number, quota?:number}>}
 */
export async function requestPersistentStorage(nav = globalThis.navigator) {
  const st = nav?.storage;
  if (!st || typeof st.persist !== 'function') return { supported: false, persisted: false };
  let persisted = false;
  if (typeof st.persisted === 'function') persisted = await st.persisted();
  if (!persisted) persisted = await st.persist();
  let usage;
  let quota;
  if (typeof st.estimate === 'function') {
    const e = await st.estimate();
    usage = e.usage; quota = e.quota;
  }
  return { supported: true, persisted, usage, quota };
}

/**
 * Mở DB tốt nhất có thể: IndexedDB, nếu thất bại thì dùng bộ nhớ và trả cờ cảnh báo.
 * @returns {Promise<{db:object, fallback:boolean, error?:Error}>}
 */
export async function openBestDB(opts = {}) {
  try {
    return { db: await openIndexedDB(opts), fallback: false };
  } catch (e) {
    return { db: createMemoryDB(), fallback: true, error: e };
  }
}
