/**
 * projectStore.js — Dự án, bản làm việc (working copy) theo từng file, và VERSION BẤT BIẾN.
 *
 * - projects: { id, name, platform, outputLang, createdAt, updatedAt, pinned, headVersionId,
 *               workspace: { idea, claudeMd, diagram, diagramSvg, skills, contract, contractText,
 *                            contractValidation, seed, seedValidation, readme, readmeState, review,
 *                            validation, images, refFiles, archMeta }, versionMeta: {vid:{label,pinned}} }
 * - files:    { projectId, path, content, state, truncated, checks, error, updatedAt, meta }
 *             KHÔNG cắt nội dung (bản GAS cắt 4.000 ký tự/file).
 * - versions: { id, projectId, createdAt, reason, snapshot, fileHashes, snapshotHash, usage }
 *             Bất biến. Nhãn/ghim nằm ở project.versionMeta để không phải sửa version.
 *
 * Version chỉ được tạo khi pipeline hoặc người dùng CHỦ ĐỘNG hoàn tất (không tạo mỗi lần lưu như V3.2).
 */
import { sha256Hex, hashObject } from './hash.js';

export const FILE_STATES = Object.freeze(['draft', 'generated', 'syntax-checked', 'consistency-checked', 'reviewed', 'truncated', 'failed', 'stale']);

/** Nhãn hiển thị trung thực cho mỗi trạng thái (KHÔNG dùng "hoàn chỉnh/chạy được"). */
export const STATE_LABELS = Object.freeze({
  draft: 'Bản nháp (chưa sinh)',
  generated: 'Đã sinh — chưa kiểm tra',
  'syntax-checked': 'Đã kiểm cú pháp',
  'consistency-checked': 'Đã kiểm nhất quán',
  reviewed: 'Đã AI review',
  truncated: 'BỊ CẮT (TRUNCATED)',
  failed: 'Lỗi',
  stale: 'Cũ — cần sinh lại'
});

function uid(prefix) {
  const r = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${r}`;
}

export function emptyWorkspace() {
  return {
    idea: '', claudeMd: '', diagram: '', diagramSvg: '', skills: [], contract: null, contractText: '', contractValidation: null,
    seed: null, seedValidation: null, readme: '', readmeState: null, review: null, validation: null, images: [], refFiles: [], archMeta: null, parseWarnings: []
  };
}

/**
 * Tính trạng thái vòng đời từ bằng chứng kiểm tra (không tin nhãn đặt tay).
 * checks: { syntax:{status}, consistency:{status}, review:{status} }
 */
export function deriveState(file) {
  if (file.truncated) return 'truncated';
  if (file.error && !file.content) return 'failed';
  if (file.stale) return 'stale';
  if (file.origin === 'stub' || !file.generatedAt) return 'draft';
  const c = file.checks || {};
  const syn = c.syntax?.status;
  if (syn === 'fail') return 'generated';
  const synOk = syn === 'pass' || syn === 'unchecked';
  if (!synOk) return 'generated';
  const conOk = c.consistency && (c.consistency.status === 'pass' || c.consistency.status === 'warn');
  if (!conOk) return syn === 'pass' ? 'syntax-checked' : 'generated';
  if (c.review?.status === 'pass' || c.review?.status === 'warn') return 'reviewed';
  return 'consistency-checked';
}

/** @param {{db:object, now?:()=>number}} deps */
export function createProjectStore({ db, now = () => Date.now() }) {
  async function getProject(id) {
    const p = await db.get('projects', id);
    if (!p) throw new Error('Không tìm thấy dự án: ' + id);
    return p;
  }

  async function putProject(p) {
    p.updatedAt = now();
    await db.put('projects', p);
    return p;
  }

  async function listFiles(projectId) {
    return db.getAll('files', { index: 'projectId', query: projectId });
  }

  async function filesMap(projectId) {
    const out = {};
    for (const f of await listFiles(projectId)) out[f.path] = f;
    return out;
  }

  async function snapshotOf(projectId) {
    const p = await getProject(projectId);
    const files = {};
    for (const f of await listFiles(projectId)) {
      files[f.path] = { content: f.content ?? '', state: f.state, truncated: !!f.truncated, checks: f.checks || null, origin: f.origin || null, generatedAt: f.generatedAt || null, meta: f.meta || null };
    }
    return { project: { id: p.id, name: p.name, platform: p.platform, outputLang: p.outputLang, fileList: p.fileList || null }, workspace: JSON.parse(JSON.stringify(p.workspace || emptyWorkspace())), files };
  }

  async function hashSnapshot(snap) {
    const fileHashes = {};
    for (const [path, f] of Object.entries(snap.files)) fileHashes[path] = await sha256Hex(f.content);
    const snapshotHash = await hashObject({ workspace: snap.workspace, files: snap.files });
    return { fileHashes, snapshotHash };
  }

  return {
    async create({ name = 'Dự án mới', platform = 'gas', outputLang = 'vi', idea = '' } = {}) {
      const p = {
        id: uid('prj'), name, platform, outputLang, createdAt: now(), updatedAt: now(), pinned: false,
        headVersionId: null, versionMeta: {}, fileList: null, workspace: { ...emptyWorkspace(), idea }
      };
      await db.put('projects', p);
      return p;
    },
    getProject,
    putProject,
    async list({ limit = 20, offset = 0, search = '' } = {}) {
      let rows = await db.getAll('projects', { index: 'updatedAt', direction: 'prev' });
      if (search) {
        const q = search.toLowerCase();
        rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || (r.workspace?.idea || '').toLowerCase().includes(q));
      }
      rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
      return { total: rows.length, items: rows.slice(offset, offset + limit) };
    },
    async updateWorkspace(projectId, patch) {
      const p = await getProject(projectId);
      p.workspace = { ...emptyWorkspace(), ...(p.workspace || {}), ...patch };
      return putProject(p);
    },
    async updateMeta(projectId, patch) {
      const p = await getProject(projectId);
      Object.assign(p, patch);
      return putProject(p);
    },
    listFiles,
    filesMap,
    async getFile(projectId, path) { return db.get('files', [projectId, path]); },
    /** Ghi file (giữ NGUYÊN nội dung). state được tính lại từ bằng chứng. */
    async putFile(projectId, path, data) {
      const prev = (await db.get('files', [projectId, path])) || {};
      const f = { ...prev, ...data, projectId, path, updatedAt: now() };
      f.state = deriveState(f);
      await db.put('files', f);
      return f;
    },
    async deleteFile(projectId, path) { await db.delete('files', [projectId, path]); },
    async clearFiles(projectId) { return db.deleteWhere('files', { index: 'projectId', query: projectId }); },
    /** Đánh dấu các file đã sinh là "cũ" khi contract thay đổi. */
    async markStale(projectId, reason) {
      let n = 0;
      for (const f of await listFiles(projectId)) {
        if (f.origin === 'ai' && !f.stale) { f.stale = true; f.staleReason = reason; f.state = deriveState(f); f.updatedAt = now(); await db.put('files', f); n++; }
      }
      return n;
    },

    snapshotOf,

    /**
     * Tạo VERSION bất biến từ bản làm việc hiện tại.
     * @param {{reason:'pipeline'|'user', label?:string, usage?:object}} opts
     */
    async createVersion(projectId, { reason = 'user', label = '', usage = null } = {}) {
      const snap = await snapshotOf(projectId);
      const { fileHashes, snapshotHash } = await hashSnapshot(snap);
      const p = await getProject(projectId);
      // Không tạo version trùng hệt version gần nhất
      if (p.headVersionId) {
        const head = await db.get('versions', p.headVersionId);
        if (head && head.snapshotHash === snapshotHash) return { version: head, duplicate: true };
      }
      const v = { id: uid('ver'), projectId, createdAt: now(), reason, snapshot: snap, fileHashes, snapshotHash, usage };
      await db.add('versions', v);
      p.headVersionId = v.id;
      p.versionMeta = { ...(p.versionMeta || {}), [v.id]: { label: label || '', pinned: false } };
      await putProject(p);
      return { version: v, duplicate: false };
    },

    async listVersions(projectId) {
      const rows = await db.getAll('versions', { index: 'projectId', query: projectId });
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows;
    },
    async getVersion(id) { return db.get('versions', id); },

    /** Kiểm tra toàn vẹn 1 version (băm lại từng file). */
    async verifyVersion(v) {
      const bad = [];
      for (const [path, f] of Object.entries(v.snapshot.files)) {
        const h = await sha256Hex(f.content);
        if (h !== v.fileHashes[path]) bad.push(path);
      }
      const missing = Object.keys(v.fileHashes).filter((p) => !(p in v.snapshot.files));
      const snapHash = await hashObject({ workspace: v.snapshot.workspace, files: v.snapshot.files });
      return { ok: !bad.length && !missing.length && snapHash === v.snapshotHash, bad, missing, snapshotHashOk: snapHash === v.snapshotHash };
    },

    /**
     * Khôi phục NGUYÊN VẸN version vào bản làm việc. Kiểm tra băm trước và sau khi ghi.
     * @returns {{ok:boolean, verifiedAfter:boolean}}
     */
    async restoreVersion(projectId, versionId) {
      const v = await db.get('versions', versionId);
      if (!v || v.projectId !== projectId) throw new Error('Version không thuộc dự án này.');
      const pre = await this.verifyVersion(v);
      if (!pre.ok) throw new Error(`Version bị hỏng (sai băm): ${[...pre.bad, ...pre.missing].join(', ') || 'snapshot'}. Không khôi phục.`);
      await this.clearFiles(projectId);
      for (const [path, f] of Object.entries(v.snapshot.files)) {
        await db.put('files', { projectId, path, ...f, updatedAt: now() });
      }
      const p = await getProject(projectId);
      p.workspace = JSON.parse(JSON.stringify(v.snapshot.workspace));
      p.platform = v.snapshot.project.platform;
      p.outputLang = v.snapshot.project.outputLang;
      p.fileList = v.snapshot.project.fileList || null;
      p.headVersionId = v.id;
      await putProject(p);
      const after = await snapshotOf(projectId);
      const { snapshotHash } = await hashSnapshot(after);
      return { ok: true, verifiedAfter: snapshotHash === v.snapshotHash };
    },

    async setVersionMeta(projectId, versionId, patch) {
      const p = await getProject(projectId);
      p.versionMeta = { ...(p.versionMeta || {}), [versionId]: { label: '', pinned: false, ...(p.versionMeta?.[versionId] || {}), ...patch } };
      return putProject(p);
    },

    /** Giữ tối đa N version; KHÔNG xóa bản đã ghim. Trả danh sách id đã xóa. */
    async pruneVersions(projectId, maxVersions) {
      if (!(maxVersions > 0)) return [];
      const p = await getProject(projectId);
      const rows = await this.listVersions(projectId);
      const removable = rows.filter((v) => !p.versionMeta?.[v.id]?.pinned && v.id !== p.headVersionId);
      const keepCount = Math.max(0, maxVersions - (rows.length - removable.length));
      const toDelete = removable.slice(keepCount);
      for (const v of toDelete) {
        await db.delete('versions', v.id);
        delete p.versionMeta?.[v.id];
      }
      if (toDelete.length) await putProject(p);
      return toDelete.map((v) => v.id);
    },

    async rename(projectId, name) {
      const p = await getProject(projectId);
      p.name = String(name || '').trim() || p.name;
      return putProject(p);
    },
    async setPinned(projectId, pinned) {
      const p = await getProject(projectId);
      p.pinned = !!pinned;
      return putProject(p);
    },
    /** Nhân bản dự án (bản làm việc + KHÔNG sao version). */
    async duplicate(projectId) {
      const src = await getProject(projectId);
      const p = await this.create({ name: src.name + ' (bản sao)', platform: src.platform, outputLang: src.outputLang });
      p.workspace = JSON.parse(JSON.stringify(src.workspace));
      p.fileList = src.fileList;
      await putProject(p);
      for (const f of await listFiles(projectId)) await db.put('files', { ...f, projectId: p.id, updatedAt: now() });
      return p;
    },
    async remove(projectId) {
      await this.clearFiles(projectId);
      for (const v of await this.listVersions(projectId)) await db.delete('versions', v.id);
      await db.deleteWhere('jobs', { index: 'projectId', query: projectId });
      await db.delete('projects', projectId);
    }
  };
}
