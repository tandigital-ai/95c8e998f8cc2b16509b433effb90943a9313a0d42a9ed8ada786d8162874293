/**
 * playground.js — Thử từng Skill với input tùy ý, chọn provider/model riêng, streaming, Hủy.
 * Port testSkill (GAS) + runPlayground (V3.2).
 */
import { h, mount, rafThrottle, copyButton } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { markdownView } from '../ui/markdownView.js';
import { modelFor, roleSelect } from './models.js';

export function openPlayground(app, skillIndex) {
  const skill = app.state.project?.workspace?.skills?.[skillIndex];
  if (!skill) { app.toast('Không tìm thấy skill', 'err'); return; }
  const input = h('textarea', { class: 'ta', rows: '4', 'aria-label': 'Input thử nghiệm' });
  input.value = 'Xin chào, hãy giới thiệu nhiệm vụ của bạn và cho một ví dụ đầu ra.';
  const out = h('div', { class: 'stream-box', 'aria-live': 'polite' }, h('span', { class: 'muted' }, 'Kết quả sẽ hiển thị ở đây…'));
  const meta = h('div');
  const runBtn = h('button', { class: 'btn btn-pri' }, '▶ Chạy thử');
  const stopBtn = h('button', { class: 'btn btn-out', disabled: true }, '⏹ Hủy');
  let ctl = null;
  const paint = rafThrottle((full) => { out.textContent = full; out.scrollTop = out.scrollHeight; });

  stopBtn.addEventListener('click', () => ctl?.abort());
  runBtn.addEventListener('click', async () => {
    const txt = input.value.trim();
    if (!txt) { app.toast('Nhập input trước', 'err'); return; }
    let ref;
    try { ref = modelFor(app, 'playground'); } catch (e) { app.toast(e.message, 'err'); return; }
    ctl = new AbortController();
    runBtn.disabled = true; stopBtn.disabled = false;
    out.textContent = '⏳ Đang chạy…';
    mount(meta);
    try {
      const r = await app.llm.complete({
        provider: ref.provider, model: ref.model, step: 'playground', projectId: app.state.project?.id, noCache: true, signal: ctl.signal,
        messages: [{ role: 'system', content: skill.content }, { role: 'user', content: txt }],
        onDelta: (_d, full) => paint(full)
      });
      mount(out, markdownView(r.content || '(rỗng)'));
      mount(meta, app.ui.callMeta(r));
    } catch (e) {
      await app.logger.error('playground', e.message, { code: e.code, skill: skill.filename });
      mount(out, h('div', { class: 'error-box' }, '❌ ' + e.message));
    } finally {
      runBtn.disabled = false; stopBtn.disabled = true; ctl = null;
    }
  });

  openModal({
    title: `🧪 Skill Playground — ${skill.filename}`, size: 'wide',
    onClose: () => ctl?.abort(),
    body: h('div', { class: 'col' },
      h('div', { class: 'small' }, h('b', null, skill.name), ' — system prompt = nội dung skill.'),
      h('details', null, h('summary', { class: 'small' }, 'Xem nội dung skill'), markdownView(skill.content)),
      roleSelect(app, 'playground'),
      input, h('div', { class: 'row' }, runBtn, stopBtn, copyButton(() => out.textContent, app.toast)), out, meta,
      h('div', { class: 'small muted' }, '⚠ Chạy thử gọi API thật và tốn token. Không dùng cache.'))
  });
}
