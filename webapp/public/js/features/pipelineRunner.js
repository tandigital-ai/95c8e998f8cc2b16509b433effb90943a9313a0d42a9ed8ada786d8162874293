/**
 * pipelineRunner.js — Nối máy trạng thái (core/pipeline.js) với các bước AI thật + UI tiến trình.
 * - Ước tính chi phí TRƯỚC khi chạy (max_tokens = trường hợp xấu nhất) và hỏi xác nhận nếu vượt ngân sách.
 * - Hủy / Thử lại bước / Thử lại file / Resume thủ công.
 * - Cảnh báo khi rời trang đang chạy; gỡ cảnh báo khi xong (sửa lỗi B15 bản GAS).
 */
import { createPipeline, STEPS, STEP_LABELS, summarizeJob } from '../core/pipeline.js';
import { estimateMessagesTokens, formatUsd } from '../core/budget.js';
import { h, mount, fmtTime } from '../ui/dom.js';
import { confirmDialog } from '../ui/modal.js';
import { STATE_LABELS } from '../core/projectStore.js';
import { generateArchitecture, architectureInput } from './architect.js';
import { buildContract, contractInput } from './contractBuilder.js';
import { buildFile, buildReadme, codeFileInput, fileList } from './codeBuilder.js';
import { runChecks, aiReview, proposeFixes } from './review.js';
import { buildSeed } from './seed.js';
import { modelFor } from './models.js';

function beforeUnload(e) { e.preventDefault(); e.returnValue = 'Pipeline đang chạy — rời trang sẽ DỪNG công việc.'; return e.returnValue; }

export function createPipelineRunner(app) {
  const live = { onDelta: null };
  const onEvent = (ev) => {
    if (ev.type === 'retry') app.state.liveNote = `Thử lại ${ev.attempt}/${ev.maxRetries} sau ${Math.round(ev.waitMs / 1000)}s: ${ev.reason}`;
    else if (ev.type === 'continue') app.state.liveNote = `Bị cắt — đang tự nối vòng ${ev.round + 1}/${ev.maxRounds}`;
    else if (ev.type === 'fallback') app.state.liveNote = `Fallback sang ${ev.to.provider}/${ev.to.model}`;
    else if (ev.type === 'key-swap') app.state.liveNote = `Key bị ${ev.status} — đổi sang key khác`;
    else if (ev.type === 'contract-sliced') app.state.liveNote = `Contract dài ⇒ dùng bản rút gọn có kiểm soát cho ${ev.path}`;
    app.emit('pipeline');
  };
  const delta = (_d, full) => { app.state.liveText = full; app.emitFrame('stream'); };

  const executors = {
    architecture: {
      input: async () => architectureInput(await app.projects.getProject(app.state.project.id)),
      run: async (ctx) => {
        const r = await generateArchitecture(app, { signal: ctx.signal, onDelta: delta, onEvent });
        const w = r.warnings.map((x) => x.message);
        if (r.status === 'truncated') return { status: 'truncated', halt: true, note: w[0] };
        if (!r.parsed.claudeMd || r.parsed.skills.length === 0) return { status: 'failed', halt: true, error: 'Không đọc được Claude.md/Skills từ đầu ra AI. ' + w.join(' ') };
        return { status: 'done', note: `${r.parsed.skills.length} skill${w.length ? ` · ${w.length} cảnh báo` : ''}` };
      }
    },
    contract: {
      input: async () => contractInput(await app.projects.getProject(app.state.project.id)),
      run: (ctx) => buildContract(app, { signal: ctx.signal, onDelta: delta, onEvent })
    },
    'build-files': {
      files: async () => fileList(await app.projects.getProject(app.state.project.id)),
      fileInput: async (_ctx, path) => codeFileInput(await app.projects.getProject(app.state.project.id), path),
      buildFile: (ctx, path) => { app.state.liveText = ''; return buildFile(app, path, { signal: ctx.signal, onDelta: delta, onEvent }); }
    },
    checks: {
      input: async () => ({ files: Object.entries(await app.projects.filesMap(app.state.project.id)).map(([k, f]) => k + ':' + (f.content || '').length + ':' + (f.updatedAt || 0)) }),
      run: () => runChecks(app)
    },
    review: {
      input: async () => ({ v: (await app.projects.getProject(app.state.project.id)).workspace.validation?.at }),
      run: (ctx) => aiReview(app, { signal: ctx.signal })
    },
    fix: {
      input: async () => ({ r: (await app.projects.getProject(app.state.project.id)).workspace.review?.at }),
      run: (ctx) => proposeFixes(app, { signal: ctx.signal })
    },
    seed: {
      input: async () => ({ c: (await app.projects.getProject(app.state.project.id)).workspace.contractText }),
      run: (ctx) => buildSeed(app, { signal: ctx.signal })
    },
    readme: {
      input: async () => { const p = await app.projects.getProject(app.state.project.id); return { c: p.workspace.claudeMd, f: fileList(p), v: p.workspace.validation?.syntaxSummary }; },
      run: (ctx) => buildReadme(app, { signal: ctx.signal, onDelta: delta })
    },
    'save-version': {
      run: async () => {
        const s = await app.budget.getProject(app.state.project.id);
        const { version, duplicate } = await app.projects.createVersion(app.state.project.id, { reason: 'pipeline', usage: s ? { calls: s.calls, inTokens: s.inTokens, outTokens: s.outTokens, knownCostUsd: s.knownCostUsd, unknownPriceCalls: s.unknownPriceCalls } : null });
        const pruned = await app.projects.pruneVersions(app.state.project.id, app.settings.get().maxVersionsPerProject);
        await app.reloadProject();
        return { status: 'done', note: duplicate ? 'không đổi so với version trước — không tạo bản trùng' : `version ${version.id.slice(-6)}${pruned.length ? `, dọn ${pruned.length} bản cũ` : ''}` };
      }
    }
  };

  const pipeline = createPipeline({
    db: app.db, executors, logger: app.logger,
    onUpdate: (job) => { app.state.job = job; app.emit('pipeline'); }
  });

  /** Ước tính chi phí các bước còn lại (trường hợp xấu nhất). */
  async function estimate(job) {
    const p = await app.projects.getProject(app.state.project.id);
    const w = p.workspace;
    const s = app.settings.get();
    const steps = [];
    const add = (label, role, inText, rounds = 1) => {
      try {
        const ref = modelFor(app, role);
        steps.push({ label, provider: ref.provider, model: ref.model, inTokens: estimateMessagesTokens([{ content: inText }]).tokens * rounds, outTokens: s.maxTokens * rounds });
      } catch (e) { steps.push({ label, provider: '?', model: '?', inTokens: 0, outTokens: 0, error: e.message }); }
    };
    const pending = (st) => !job || !['done', 'skipped'].includes(job.steps[st].status);
    const skip = new Set(job?.options?.skip || []);
    const spec = (w.claudeMd || w.idea || '').length;
    if (pending('architecture')) add('Kiến trúc', 'architect', 'x'.repeat(4000 + (w.idea || '').length));
    if (pending('contract')) add('Contract', 'contract', 'x'.repeat(4000 + spec));
    const files = fileList(p);
    for (const f of files) if (!job || job.files[f]?.status !== 'done') add('File ' + f, 'code', 'x'.repeat(3000 + spec + (w.contractText || '').length + 4000));
    if (pending('review') && !skip.has('review')) add('AI Review', 'review', 'x'.repeat(30000 * files.length / 6));
    if (pending('fix') && !skip.has('fix')) add('Fix (ước tính 2 file)', 'review', 'x'.repeat(20000), 2);
    if (pending('seed') && !skip.has('seed')) add('Dữ liệu mẫu', 'seed', 'x'.repeat((w.contractText || '').length + 2000));
    if (pending('readme')) add('README', 'readme', 'x'.repeat(spec + 2000));
    return { ...app.budget.estimatePlan(steps), missingModel: steps.filter((x) => x.error).map((x) => `${x.label}: ${x.error}`) };
  }

  async function confirmEstimate(job) {
    const est = await estimate(job);
    if (est.missingModel.length) { app.toast(est.missingModel[0], 'err'); return false; }
    const chk = await app.budget.check({ projectId: app.state.project.id, estimatedCost: est.unknownPriceSteps.length === est.steps.length ? null : est.knownCostUsd });
    const over = chk.warnings.length;
    const details = h('div', { class: 'col small' },
      h('div', null, `${est.steps.length} lượt gọi AI · tối đa ~${(est.inTokens + est.outTokens).toLocaleString('vi-VN')} token (ƯỚC LƯỢNG, trường hợp xấu nhất).`),
      h('div', null, 'Chi phí đã biết giá: ', h('b', null, formatUsd(est.knownCostUsd)), est.unknownPriceSteps.length ? ` · ${est.unknownPriceSteps.length} bước KHÔNG RÕ GIÁ (không cộng được)` : ''),
      h('div', null, `Hôm nay đã dùng: ${formatUsd(chk.day.used)} / ${formatUsd(chk.day.limit)}${chk.project ? ` · dự án: ${formatUsd(chk.project.used)} / ${formatUsd(chk.project.limit)}` : ''}`),
      over ? h('div', { class: 'warn-box' }, '⚠ Kế hoạch này có thể VƯỢT ngân sách cảnh báo. Đây chỉ là cảnh báo — bạn vẫn có thể tiếp tục.') : null,
      h('div', { class: 'muted' }, 'Đóng tab/tắt máy khi đang chạy sẽ DỪNG pipeline; bạn có thể bấm "Tiếp tục" sau để chạy tiếp từ checkpoint.'));
    return confirmDialog({ title: '🚀 Ước tính trước khi chạy pipeline', message: 'Kiểm tra ước tính chi phí:', details, okText: over ? 'Vẫn chạy' : 'Chạy' });
  }

  async function exec(fn) {
    window.addEventListener('beforeunload', beforeUnload);
    app.state.liveText = '';
    app.state.liveNote = '';
    app.emit('pipeline');
    try {
      const job = await fn();
      const s = summarizeJob(job);
      if (job.status === 'done') app.toast('Pipeline kết thúc. Xem nhãn từng file để biết phần nào ĐÃ/CHƯA kiểm tra.', 'ok');
      else if (job.status === 'done-with-issues') app.toast(`Pipeline kết thúc nhưng còn vấn đề: ${s.filesFailed} file lỗi, ${s.filesTruncated} file bị cắt, ${s.stepsFailed} bước lỗi.`, 'warn');
      else if (job.status === 'paused') app.toast('Đã tạm dừng. Bấm "Tiếp tục" để chạy tiếp từ checkpoint.', 'info');
      else if (job.status === 'failed') app.toast('Pipeline DỪNG do lỗi — xem bảng tiến trình.', 'err');
      return job;
    } catch (e) {
      await app.logger.error('pipeline', e.message, { projectId: app.state.project?.id });
      app.toast('Pipeline lỗi: ' + e.message, 'err');
      return null;
    } finally {
      window.removeEventListener('beforeunload', beforeUnload);
      app.state.liveNote = '';
      await app.reloadProject();
      app.emit('pipeline');
    }
  }

  async function currentJob() {
    if (!app.state.project) return null;
    const j = await pipeline.latestForProject(app.state.project.id);
    app.state.job = j;
    return j;
  }

  return {
    pipeline,
    currentJob,
    estimate,
    async startNew({ skip = [] } = {}) {
      if (!app.state.project) throw new Error('Chưa có dự án.');
      // Lưu ngay ý tưởng đang gõ (ô nhập chỉ tự lưu sau debounce 600ms).
      const ideaEl = document.getElementById('idea-input');
      if (ideaEl && ideaEl.value !== (app.state.project.workspace.idea || '')) {
        await app.projects.updateWorkspace(app.state.project.id, { idea: ideaEl.value });
        await app.reloadProject();
      }
      if (!(app.state.project.workspace.idea || '').trim()) { app.toast('Hãy nhập ý tưởng trước.', 'err'); ideaEl?.focus(); return; }
      const job = await pipeline.create(app.state.project.id, { skip });
      // Giữ kết quả bước đã có nếu đầu vào không đổi: nạp hash cũ từ job trước
      const prev = await pipeline.latestForProject(app.state.project.id);
      if (prev && prev.id !== job.id) {
        for (const st of STEPS) if (['done', 'skipped'].includes(prev.steps[st].status)) job.steps[st] = { ...prev.steps[st] };
        for (const [f, v] of Object.entries(prev.files || {})) if (v.status === 'done') job.files[f] = { ...v };
        job.steps['save-version'].status = 'pending';
        await app.db.put('jobs', job);
      }
      app.state.job = job;
      if (!(await confirmEstimate(job))) return;
      return exec(() => pipeline.run(job.id));
    },
    async resume() {
      const job = await currentJob();
      if (!job) return;
      if (!(await confirmEstimate(job))) return;
      return exec(() => pipeline.resume(job.id));
    },
    async retryStep(step) {
      const job = await currentJob();
      if (!job) return;
      return exec(() => pipeline.retryStep(job.id, step));
    },
    async retryFile(path) {
      let job = await currentJob();
      if (!job) { job = await pipeline.create(app.state.project.id); }
      return exec(() => pipeline.retryFile(job.id, path));
    },
    /** Chạy riêng 1 bước (không cần pipeline đầy đủ) — dùng cho nút lẻ. */
    async runSingle(step) {
      let job = await currentJob();
      if (!job) job = await pipeline.create(app.state.project.id);
      return exec(() => pipeline.retryStep(job.id, step));
    },
    cancel() { return pipeline.cancel(); },
    get running() { return pipeline.running; }
  };
}

/* ------------------------------------------------------------------ */
/* UI bảng tiến trình                                                  */
/* ------------------------------------------------------------------ */
const STATUS_TEXT = { pending: 'chờ', running: 'đang chạy', done: 'xong', failed: 'LỖI', skipped: 'bỏ qua', truncated: 'BỊ CẮT' };
const JOB_TEXT = { idle: 'Chưa chạy', running: '⏳ Đang chạy', paused: '⏸ Tạm dừng', interrupted: '⚠ Bị gián đoạn (tab đã đóng)', failed: '❌ Dừng do lỗi', done: '✔ Kết thúc', 'done-with-issues': '⚠ Kết thúc — còn vấn đề' };

export function renderPipelinePanel(app, container) {
  const runner = app.runner;
  const job = app.state.job;
  const running = !!runner.running;
  const skipSel = { review: true, fix: true, seed: true };
  const opts = h('div', { class: 'row small' }, 'Bước tùy chọn:', ...Object.keys(skipSel).map((k) => {
    const c = h('input', { type: 'checkbox', checked: !(job?.options?.skip || []).includes(k), 'aria-label': STEP_LABELS[k] });
    c.dataset.step = k;
    return h('label', { class: 'check' }, c, STEP_LABELS[k]);
  }));
  const readSkip = () => [...opts.querySelectorAll('input[type=checkbox]')].filter((c) => !c.checked).map((c) => c.dataset.step);

  const buttons = h('div', { class: 'row' },
    h('button', { class: 'btn btn-suc', disabled: running, onclick: () => runner.startNew({ skip: readSkip() }) }, '🚀 Chạy pipeline đầy đủ'),
    job && ['paused', 'interrupted', 'failed', 'done-with-issues'].includes(job.status) ? h('button', { class: 'btn btn-pri', disabled: running, onclick: () => runner.resume() }, '▶ Tiếp tục (Resume)') : null,
    h('button', { class: 'btn btn-danger', disabled: !running, onclick: () => { runner.cancel(); app.toast('Đang hủy…', 'info'); } }, '⏹ Hủy'));

  if (!job) {
    mount(container, h('div', { class: 'pipeline' },
      h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, '⚙️ Pipeline xây dựng'), h('span', { class: 'badge badge-off' }, 'Chưa chạy')),
      h('div', { class: 'small muted' }, 'Kiến trúc → Contract → Sinh từng file → Kiểm tra cú pháp/nhất quán → AI Review → Đề xuất sửa → Dữ liệu mẫu → README → Lưu version.'),
      opts, buttons));
    return;
  }

  const steps = h('div', { class: 'steps', role: 'list' }, ...STEPS.map((s, i) => {
    const st = job.steps[s];
    const canRetry = !running && ['failed', 'truncated', 'done', 'skipped'].includes(st.status);
    return h('div', { class: ['step', st.status], role: 'listitem', title: [st.error, st.note].filter(Boolean).join(' — ') || STATUS_TEXT[st.status] },
      h('span', { class: 'step-num' }, st.status === 'done' ? '✓' : st.status === 'failed' || st.status === 'truncated' ? '!' : String(i + 1)),
      h('span', { class: 'grow' }, STEP_LABELS[s], h('br'), h('span', { class: 'muted' }, STATUS_TEXT[st.status])),
      canRetry ? h('button', { class: 'icon-btn', title: 'Chạy lại bước này', 'aria-label': 'Chạy lại ' + STEP_LABELS[s], onclick: () => runner.retryStep(s) }, '↻') : null);
  }));

  const files = Object.entries(job.files || {});
  const fileStates = app.state.files || {};
  const fileRows = files.map(([path, f]) => {
    const fs = fileStates[path];
    const st = fs?.state || 'draft';
    return h('div', { class: 'file-item' },
      f.status === 'running' ? h('span', { class: 'spinner' }) : h('span', { 'aria-hidden': 'true' }, f.status === 'done' ? '•' : f.status === 'failed' || f.status === 'truncated' ? '✖' : '○'),
      h('span', { class: 'grow', title: f.error || f.note || '' }, path),
      h('span', { class: ['state', 'state-' + st] }, STATE_LABELS[st] || st),
      !running && f.status !== 'running' ? h('button', { class: 'btn btn-xs btn-out', onclick: () => runner.retryFile(path), 'aria-label': 'Sinh lại ' + path }, '↻') : null);
  });

  const events = (job.events || []).slice(-60);
  const logBox = h('div', { class: 'live-log', 'aria-live': 'polite' }, ...events.map((e) => h('div', { class: 'lv-' + e.level }, `${new Date(e.ts).toLocaleTimeString('vi-VN')} ${e.message}`)));
  requestAnimationFrame(() => { logBox.scrollTop = logBox.scrollHeight; });

  const s = summarizeJob(job);
  const cost = app.state.projectUsage;
  mount(container, h('div', { class: 'pipeline' },
    h('div', { class: 'row-between' },
      h('h2', { class: 'section-title' }, '⚙️ Pipeline xây dựng'),
      h('span', { class: ['badge', job.status === 'done' ? 'badge-on' : job.status === 'running' ? 'badge-info' : job.status === 'failed' ? 'badge-err' : 'badge-warn'] }, JOB_TEXT[job.status] || job.status)),
    h('div', { class: 'small muted' }, `Cập nhật ${fmtTime(job.updatedAt)} · file: ${s.filesDone}/${s.filesTotal} đã sinh${s.filesTruncated ? `, ${s.filesTruncated} BỊ CẮT` : ''}${s.filesFailed ? `, ${s.filesFailed} lỗi` : ''}`,
      cost ? ` · chi phí dự án: ${formatUsd(cost.knownCostUsd)}${cost.unknownPriceCalls ? ` + ${cost.unknownPriceCalls} lượt không rõ giá` : ''}` : ''),
    job.status === 'interrupted' ? h('div', { class: 'warn-box small' }, '⚠ Tab đã bị đóng/tải lại khi pipeline đang chạy. Bước dở dang sẽ chạy lại khi bấm "Tiếp tục" (có thể tốn token lần nữa).') : null,
    steps,
    app.state.liveNote ? h('div', { class: 'info-box small' }, 'ℹ ' + app.state.liveNote) : null,
    files.length ? h('div', { class: 'file-list', role: 'list', 'aria-label': 'Trạng thái từng file' }, ...fileRows) : null,
    h('details', { class: 'mt-8', open: running }, h('summary', { class: 'small' }, `Log trực tiếp (${events.length})`), logBox),
    opts, buttons));
}
