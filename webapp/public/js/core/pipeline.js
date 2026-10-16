/**
 * pipeline.js — MÁY TRẠNG THÁI xây dựng dự án, có checkpoint bền (store "jobs").
 *
 *   architecture → contract → build-files → checks → review → fix → seed → readme → save-version
 *
 * - Trạng thái mỗi bước / mỗi file: pending | running | done | failed | skipped | truncated
 * - Trạng thái job: idle | running | paused | interrupted | failed | done | done-with-issues
 * - Checkpoint ghi DB sau MỖI bước và MỖI file.
 * - Hủy (AbortController) ⇒ phần đang chạy trở về pending, job = paused.
 * - Tải lại trang khi đang chạy ⇒ job = interrupted ⇒ người dùng bấm Resume THỦ CÔNG.
 * - Kết quả bước khóa theo hash(đầu vào): nếu đầu vào không đổi và bước đã done ⇒ bỏ qua, không gọi AI lại.
 *
 * Module này KHÔNG biết gì về AI hay DOM: các bước được tiêm vào qua `executors` (dễ test).
 *
 * executors[stepId] = {
 *   input(ctx) => any            // đầu vào để băm (bỏ qua => luôn chạy lại)
 *   run(ctx) => Promise<{status?:'done'|'skipped'|'truncated'|'failed', note?, halt?:boolean, error?}>
 *   optional?: boolean           // có thể tắt qua options.skip
 * }
 * Riêng 'build-files': { files(ctx)=>string[], fileInput(ctx,path)=>any, buildFile(ctx,path)=>Promise<{status,note,error}> , after?(ctx) }
 */
import { hashObject } from './hash.js';

export const STEPS = Object.freeze(['architecture', 'contract', 'build-files', 'checks', 'review', 'fix', 'seed', 'readme', 'save-version']);
export const STEP_LABELS = Object.freeze({
  architecture: 'Kiến trúc',
  contract: 'Contract',
  'build-files': 'Sinh file',
  checks: 'Kiểm tra',
  review: 'AI Review',
  fix: 'Đề xuất sửa',
  seed: 'Dữ liệu mẫu',
  readme: 'README',
  'save-version': 'Lưu version'
});
export const OPTIONAL_STEPS = new Set(['review', 'fix', 'seed']);
const TERMINAL = new Set(['done', 'skipped']);

export class PipelineError extends Error {
  constructor(code, message) { super(message); this.name = 'PipelineError'; this.code = code; }
}

function newId(prefix) {
  const r = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${r}`;
}

export function emptyJob({ projectId, options = {}, now = Date.now() }) {
  const steps = {};
  for (const s of STEPS) steps[s] = { status: 'pending', inputHash: null, startedAt: null, endedAt: null, error: null, note: null, attempts: 0 };
  return {
    id: newId('job'),
    projectId,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    options: { skip: [], ...options },
    current: null,
    steps,
    files: {},
    events: []
  };
}

/** Tổng kết trung thực sau khi chạy. */
export function summarizeJob(job) {
  const st = Object.values(job.steps);
  const files = Object.values(job.files);
  return {
    stepsDone: st.filter((s) => s.status === 'done').length,
    stepsFailed: st.filter((s) => s.status === 'failed').length,
    stepsTruncated: st.filter((s) => s.status === 'truncated').length,
    stepsSkipped: st.filter((s) => s.status === 'skipped').length,
    filesTotal: files.length,
    filesDone: files.filter((f) => f.status === 'done').length,
    filesFailed: files.filter((f) => f.status === 'failed').length,
    filesTruncated: files.filter((f) => f.status === 'truncated').length,
    filesPending: files.filter((f) => f.status === 'pending' || f.status === 'running').length
  };
}

/**
 * @param {{db:object, executors:object, logger?:object, now?:()=>number, onUpdate?:(job)=>void}} deps
 */
export function createPipeline({ db, executors, logger = null, now = () => Date.now(), onUpdate = null }) {
  let active = null; // { jobId, controller }

  async function save(job) {
    job.updatedAt = now();
    if (job.events.length > 300) job.events = job.events.slice(-300);
    await db.put('jobs', JSON.parse(JSON.stringify(job)));
    if (onUpdate) {
      try { onUpdate(job); } catch (e) { logger?.error?.('pipeline', 'onUpdate lỗi: ' + e.message, { jobId: job.id }); }
    }
  }

  function event(job, level, message, extra = {}) {
    job.events.push({ ts: now(), level, message, ...extra });
    if (logger) logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']('pipeline', message, { jobId: job.id, projectId: job.projectId, ...extra });
  }

  async function load(jobId) {
    const j = await db.get('jobs', jobId);
    if (!j) throw new PipelineError('NOT_FOUND', 'Không tìm thấy job.');
    return j;
  }

  function isSkipped(job, step) {
    return OPTIONAL_STEPS.has(step) && (job.options.skip || []).includes(step);
  }

  async function runFiles(job, ctx) {
    const ex = executors['build-files'];
    const list = await ex.files(ctx);
    for (const p of list) if (!job.files[p]) job.files[p] = { status: 'pending', inputHash: null, error: null, note: null, attempts: 0 };
    for (const p of Object.keys(job.files)) if (!list.includes(p)) delete job.files[p];
    await save(job);
    for (const path of list) {
      if (ctx.signal.aborted) throw ctx.signal.reason || new PipelineError('ABORTED', 'Đã hủy');
      const fstate = job.files[path];
      const h = ex.fileInput ? await hashObject(await ex.fileInput(ctx, path)) : null;
      if (fstate.status === 'done' && h && fstate.inputHash === h) continue;
      if (ctx.onlyFile && ctx.onlyFile !== path) continue;
      fstate.status = 'running';
      fstate.attempts++;
      fstate.error = null;
      job.current = { step: 'build-files', file: path };
      await save(job);
      let r;
      try {
        r = (await ex.buildFile(ctx, path)) || {};
      } catch (e) {
        if (ctx.signal.aborted || e?.code === 'ABORTED') { fstate.status = 'pending'; await save(job); throw e; }
        r = { status: 'failed', error: e?.message || String(e) };
      }
      fstate.status = r.status || 'done';
      fstate.note = r.note || null;
      fstate.error = r.error || null;
      fstate.inputHash = fstate.status === 'done' ? h : null;
      if (fstate.status === 'failed') event(job, 'error', `File ${path}: ${fstate.error}`, { step: 'build-files', file: path });
      else if (fstate.status === 'truncated') event(job, 'warn', `File ${path} BỊ CẮT (TRUNCATED) — không coi là thành công.`, { step: 'build-files', file: path });
      else event(job, 'info', `File ${path}: ${fstate.status}${fstate.note ? ' — ' + fstate.note : ''}`, { step: 'build-files', file: path });
      await save(job);
    }
    if (ex.after) await ex.after(ctx);
    const fs = Object.values(job.files);
    if (fs.some((f) => f.status === 'failed')) return { status: 'failed', error: `${fs.filter((f) => f.status === 'failed').length} file lỗi`, halt: false };
    if (fs.some((f) => f.status === 'truncated')) return { status: 'truncated', note: `${fs.filter((f) => f.status === 'truncated').length} file bị cắt`, halt: false };
    if (fs.some((f) => f.status !== 'done' && f.status !== 'skipped')) return { status: 'failed', error: 'Còn file chưa sinh', halt: false };
    return { status: 'done', note: `${fs.length} file` };
  }

  async function runStep(job, step, ctx) {
    const st = job.steps[step];
    if (isSkipped(job, step)) {
      st.status = 'skipped';
      st.note = 'Bỏ qua theo tùy chọn';
      await save(job);
      return { status: 'skipped' };
    }
    const ex = executors[step];
    if (!ex) throw new PipelineError('NO_EXECUTOR', `Thiếu bộ thực thi cho bước ${step}`);
    let h = null;
    if (step !== 'build-files' && ex.input) {
      h = await hashObject(await ex.input(ctx));
      if (TERMINAL.has(st.status) && st.inputHash === h && !ctx.force) {
        event(job, 'info', `Bước "${STEP_LABELS[step]}": đầu vào không đổi — dùng lại kết quả đã có (không gọi AI).`, { step });
        return { status: st.status, reused: true };
      }
    }
    st.status = 'running';
    st.startedAt = now();
    st.endedAt = null;
    st.error = null;
    st.attempts++;
    job.current = { step, file: null };
    event(job, 'info', `Bắt đầu: ${STEP_LABELS[step]}`, { step });
    await save(job);
    let r;
    try {
      r = step === 'build-files' ? await runFiles(job, ctx) : ((await ex.run(ctx)) || {});
    } catch (e) {
      if (ctx.signal.aborted || e?.code === 'ABORTED') {
        st.status = 'pending';
        st.endedAt = now();
        event(job, 'warn', `Đã hủy ở bước ${STEP_LABELS[step]}.`, { step });
        await save(job);
        throw e;
      }
      r = { status: 'failed', error: e?.message || String(e), halt: true };
    }
    st.status = r.status || 'done';
    st.note = r.note || null;
    st.error = r.error || null;
    st.endedAt = now();
    st.inputHash = TERMINAL.has(st.status) ? h : null;
    if (st.status === 'failed') event(job, 'error', `Bước ${STEP_LABELS[step]} thất bại: ${st.error}`, { step });
    else if (st.status === 'truncated') event(job, 'warn', `Bước ${STEP_LABELS[step]} bị cắt: ${st.note || ''}`, { step });
    else event(job, 'info', `Xong: ${STEP_LABELS[step]}${st.note ? ' — ' + st.note : ''}`, { step });
    await save(job);
    return r;
  }

  /**
   * Chạy job từ bước đầu tiên chưa xong.
   * @param {string} jobId
   * @param {{from?:string, onlyStep?:string, onlyFile?:string, force?:boolean, context?:object}} opts
   */
  async function run(jobId, opts = {}) {
    if (active) throw new PipelineError('BUSY', 'Đang có pipeline khác chạy. Hãy hủy hoặc chờ.');
    const job = await load(jobId);
    const controller = new AbortController();
    active = { jobId, controller };
    const ctx = { job, projectId: job.projectId, options: job.options, signal: controller.signal, onlyFile: opts.onlyFile || null, force: !!opts.force, ...(opts.context || {}) };
    ctx.event = (level, msg, extra) => event(job, level, msg, extra);
    ctx.checkpoint = () => save(job);
    job.status = 'running';
    await save(job);
    let startIdx = 0;
    if (opts.from) {
      startIdx = STEPS.indexOf(opts.from);
      if (startIdx < 0) throw new PipelineError('BAD_STEP', 'Bước không tồn tại: ' + opts.from);
      // Chạy lại từ bước này: bước này về pending; các bước sau vẫn giữ kết quả
      // nhưng sẽ bị kiểm hash đầu vào — đầu vào đổi thì tự chạy lại.
      job.steps[opts.from].status = 'pending';
    }
    try {
      for (let i = startIdx; i < STEPS.length; i++) {
        const step = STEPS[i];
        if (opts.onlyStep && step !== opts.onlyStep) continue;
        const st = job.steps[step];
        const reusable = TERMINAL.has(st.status) && !opts.force && step !== opts.from;
        if (reusable && step !== 'build-files') {
          // vẫn kiểm tra hash nếu có input — đầu vào đổi thì phải chạy lại
          const ex = executors[step];
          if (!ex?.input) continue;
          const h = await hashObject(await ex.input(ctx));
          if (h === st.inputHash) continue;
          st.status = 'pending';
        }
        const r = await runStep(job, step, ctx);
        if (r.status === 'failed' && (r.halt !== false)) {
          job.status = 'failed';
          job.current = { step, file: null };
          await save(job);
          return job;
        }
        if (r.status === 'truncated' && r.halt) {
          job.status = 'failed';
          await save(job);
          return job;
        }
        if (r.halt) { job.status = 'paused'; await save(job); return job; }
      }
      const s = summarizeJob(job);
      job.current = null;
      job.status = s.stepsFailed || s.stepsTruncated || s.filesFailed || s.filesTruncated ? 'done-with-issues' : 'done';
      event(job, job.status === 'done' ? 'info' : 'warn', job.status === 'done' ? 'Pipeline kết thúc. (Xem nhãn từng file để biết phần nào đã/chưa kiểm tra.)' : 'Pipeline kết thúc NHƯNG còn vấn đề — xem các bước/file màu đỏ.', {});
      await save(job);
      return job;
    } catch (e) {
      if (controller.signal.aborted || e?.code === 'ABORTED') {
        job.status = 'paused';
        event(job, 'warn', 'Pipeline tạm dừng (đã hủy). Bấm "Tiếp tục" để chạy tiếp từ checkpoint.', {});
        await save(job);
        return job;
      }
      job.status = 'failed';
      event(job, 'error', 'Pipeline lỗi: ' + (e?.message || e), {});
      await save(job);
      throw e;
    } finally {
      active = null;
    }
  }

  return {
    STEPS,
    async create(projectId, options = {}) {
      const job = emptyJob({ projectId, options, now: now() });
      await save(job);
      return job;
    },
    load,
    run,
    /** Tiếp tục từ checkpoint (người dùng bấm thủ công). */
    resume(jobId, context) { return run(jobId, { context }); },
    /** Chạy lại đúng 1 bước (bắt buộc gọi lại, kể cả khi hash trùng). */
    retryStep(jobId, step, context) { return run(jobId, { onlyStep: step, force: true, context }); },
    /** Chạy lại 1 file. */
    async retryFile(jobId, path, context) {
      const job = await load(jobId);
      if (!job.files[path]) throw new PipelineError('NOT_FOUND', 'File không thuộc job: ' + path);
      job.files[path].status = 'pending';
      job.files[path].inputHash = null;
      job.steps['build-files'].status = 'pending';
      await save(job);
      return run(jobId, { onlyStep: 'build-files', onlyFile: path, context });
    },
    cancel(reason = 'Người dùng bấm Hủy') {
      if (!active) return false;
      active.controller.abort(Object.assign(new Error(reason), { code: 'ABORTED' }));
      return true;
    },
    get running() { return active ? active.jobId : null; },
    async latestForProject(projectId) {
      const rows = await db.getAll('jobs', { index: 'projectId', query: projectId });
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows[0] || null;
    },
    /** Gọi khi khởi động app: job "running" còn sót ⇒ interrupted (tab đã bị đóng giữa chừng). */
    async markInterrupted() {
      const rows = await db.getAll('jobs', { index: 'status', query: 'running' });
      for (const j of rows) {
        j.status = 'interrupted';
        for (const s of Object.values(j.steps)) if (s.status === 'running') s.status = 'pending';
        for (const f of Object.values(j.files)) if (f.status === 'running') f.status = 'pending';
        j.events.push({ ts: now(), level: 'warn', message: 'Tab bị đóng/tải lại khi đang chạy — job bị gián đoạn. Bấm "Tiếp tục" để chạy tiếp từ checkpoint.' });
        await save(j);
      }
      return rows.length;
    }
  };
}
