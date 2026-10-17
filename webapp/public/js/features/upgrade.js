/**
 * upgrade.js — Chế độ NÂNG CẤP / DEBUG app đã sinh theo yêu cầu bằng lời + Sổ cái Ban Điều phối.
 * B1: AI lập kế hoạch (chọn file cần sửa, JSON). B2: sửa từng file → ĐỀ XUẤT có PHIẾU (WO).
 * Chỉ ghi đè khi người dùng bấm "Chấp nhận" (qua quy tắc hợp nhất trong review.js#acceptFix).
 * Có bảng tiến trình nổi: %, công đoạn, thời gian, chi phí, nút Hủy.
 */
import { h } from '../ui/dom.js';
import { extractJson } from '../core/parser.js';
import { getPlatform } from '../core/platforms.js';
import { WO_STATUS } from '../core/workOrders.js';
import { runTask } from '../ui/taskProgress.js';
import { modelFor } from './models.js';
import { surfaceOfOthers } from './codeBuilder.js';
import { draftProposal, deltaTracker, NOOP_TRACK } from './review.js';

const FULL_CONTEXT_LIMIT = 120000; // ký tự: dưới mức này gửi toàn bộ file cho bước lập kế hoạch
let draftText = ''; // giữ nội dung ô nhập khi giao diện vẽ lại

export async function proposeUpgrade(app, request, { signal, track = NOOP_TRACK } = {}) {
  const req = String(request || '').trim();
  if (!req) throw new Error('Hãy mô tả yêu cầu nâng cấp hoặc lỗi cần sửa.');
  const p = await app.projects.getProject(app.state.project.id);
  const w = p.workspace;
  if (!w.contract) throw new Error('Chưa có Contract hợp lệ.');
  const files = await app.projects.filesMap(p.id);
  const editable = Object.fromEntries(Object.entries(files).filter(([, f]) => f.origin === 'ai' && f.content));
  const paths = Object.keys(editable);
  if (!paths.length) throw new Error('Chưa có file code nào để nâng cấp. Hãy chạy pipeline trước.');
  const plat = getPlatform(p.platform);
  const ref = modelFor(app, 'code');
  const vi = p.outputLang !== 'en';

  // B1 — lập kế hoạch
  track.stage(`Bước 1/2: AI lập kế hoạch — chọn file cần sửa (${ref.provider}/${ref.model})`, 2);
  const total = paths.reduce((s, k) => s + editable[k].content.length, 0);
  const ctx = total <= FULL_CONTEXT_LIMIT
    ? paths.map((k) => `### FILE: ${k}\n${editable[k].content}`).join('\n\n')
    : (await surfaceOfOthers(files, null)) + '\n\nFILES: ' + paths.join(', ');
  const plan = await app.llm.complete({
    provider: ref.provider, model: ref.model, step: 'upgrade-plan', projectId: p.id, signal, temperature: 0.1, noCache: true,
    onEvent: track.onEvent, onDelta: deltaTracker(track, 2, 12, 900, 'Kế hoạch'),
    messages: [
      { role: 'system', content: `You are a senior ${plat.name} engineer planning a change to an EXISTING app. Choose the MINIMAL set of files to modify (max 5) from the given paths only. Return STRICT JSON only: {"summary":"...","files":[{"path":"exact path","why":"what to change in this file"}]}. ${vi ? 'Write summary/why in Vietnamese.' : ''}` },
      { role: 'user', content: `PROJECT CONTRACT:\n${w.contractText}\n\nCURRENT CODE:\n${ctx}\n\nUSER REQUEST (upgrade or bug to fix):\n${req}\n\nOutput the JSON plan now.` }
    ]
  });
  track.addCall(plan);
  const ex = extractJson(plan.content);
  if (plan.truncated || !ex.ok || !Array.isArray(ex.value?.files)) throw new Error('AI không trả được kế hoạch hợp lệ (JSON lỗi hoặc bị cắt). Hãy thử lại hoặc đổi model ô SINH CODE.');
  const seen = new Set();
  const targets = ex.value.files.filter((x) => x && paths.includes(x.path) && !seen.has(x.path) && seen.add(x.path)).slice(0, 5);
  if (!targets.length) throw new Error('AI không chọn được file nào phù hợp. Hãy mô tả cụ thể hơn (màn hình nào, nút nào, lỗi gì).');

  // B2 — sửa từng file
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (signal?.aborted) throw signal.reason;
    const before = editable[t.path].content;
    const base = 15 + (85 * i) / targets.length;
    const span = 85 / targets.length;
    track.stage(`Bước 2/2: sửa file ${i + 1}/${targets.length}: ${t.path}`, base);
    const r = await app.llm.complete({
      provider: ref.provider, model: ref.model, step: `upgrade:${t.path}`, projectId: p.id, signal, temperature: 0.2, noCache: true,
      onEvent: track.onEvent, onDelta: deltaTracker(track, base, span, before.length * 1.1, t.path),
      messages: [
        { role: 'system', content: `You are a careful ${plat.name} engineer implementing a requested change in ONE existing file. Keep everything that works. Obey the PROJECT CONTRACT: do not rename existing functions/constants/DOM ids/data fields. Implement the request completely, no placeholders/TODO. Output the FULL updated file as raw content, no fences, no explanation.${vi ? ' Comments and UI text in Vietnamese.' : ''}` },
        { role: 'user', content: `PROJECT CONTRACT:\n${w.contractText}\n\nUSER REQUEST:\n${req}\n\nPLAN SUMMARY: ${ex.value.summary || ''}\nCHANGE FOR THIS FILE: ${t.why || ''}\n\nOTHER FILES — API SURFACE (call, do not redefine):\n${await surfaceOfOthers(files, t.path)}\n\nFILE: ${t.path}\nCURRENT CONTENT:\n${before}\n\nReturn the full updated ${t.path} now.` }
      ]
    });
    track.addCall(r);
    track.stage(`Kiểm cú pháp & lập phiếu cho ${t.path}`, base + span * 0.97);
    await draftProposal(app, p.id, { step: 'upgrade', path: t.path, problems: [`[nâng cấp] ${req}`, t.why || ''].filter(Boolean), before, raw: r.content, truncated: r.truncated, provider: r.provider, model: r.model });
  }
  await app.reloadProject();
  return { count: targets.length, summary: ex.value.summary || '', note: `${targets.length} đề xuất chờ duyệt — xem diff rồi bấm "✔ Chấp nhận"` };
}

/** Ô nhập yêu cầu nâng cấp — đặt trong tab "Review & Fix". */
export function upgradeBox(app) {
  const ta = h('textarea', { class: 'ta', rows: '4', 'aria-label': 'Yêu cầu nâng cấp hoặc lỗi cần sửa', placeholder: 'Ví dụ: "Làm lại giao diện chuyên nghiệp: sidebar có icon, thẻ thống kê nhiều màu, bảng đẹp" hoặc "Bấm nút Lưu học sinh bị lỗi: ..." (dán nguyên văn thông báo lỗi)' });
  ta.value = draftText;
  ta.addEventListener('input', () => { draftText = ta.value; });
  const btn = h('button', { class: 'btn btn-sm btn-pri', type: 'button', disabled: !!app.runner.running }, '🛠 Tạo đề xuất nâng cấp / sửa lỗi');
  btn.addEventListener('click', async () => {
    if (!ta.value.trim()) { app.toast('Hãy mô tả yêu cầu trước.', 'warn'); return; }
    btn.disabled = true;
    const r = await runTask(app, '🛠 Nâng cấp / Debug', (t) => proposeUpgrade(app, ta.value, { signal: t.signal, track: t }));
    btn.disabled = false;
    if (r) app.toast(`Đã tạo ${r.count} đề xuất${r.summary ? ': ' + r.summary : ''}. Xem diff rồi bấm "✔ Chấp nhận".`, 'ok');
    app.emit('workspace');
  });
  return h('div', { class: 'card mt-12' },
    h('h3', { class: 'section-title' }, '🛠 Nâng cấp / Debug app theo yêu cầu'),
    h('div', { class: 'small muted' }, 'Mô tả bằng lời điều cần thêm/sửa. AI tự chọn file, đưa bản sửa dạng diff kèm PHIẾU CÔNG VIỆC. KHÔNG ghi đè gì cho tới khi bạn bấm "Chấp nhận".'),
    ta, h('div', { class: 'row mt-8' }, btn));
}

/** Tab "📒 Sổ cái" của Ban Điều phối. */
export function ledgerView(ledger) {
  const rows = [...(ledger || [])].reverse().slice(0, 200);
  const cls = (s) => ['badge', s === 'merged' ? 'badge-ok' : s === 'blocked' ? 'badge-err' : s === 'verified' || s === 'drafted' ? 'badge-warn' : ''];
  return h('div', { class: 'col' },
    h('div', { class: 'small muted' }, 'Sổ cái Ban Điều phối: mọi thay đổi sau khi sinh code đều có PHIẾU (WO) ghi phiên bản Contract, bản gốc và model đã làm. Chỉ phiếu hợp lệ mới được hợp nhất vào file.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ...['Thời điểm', 'Phiếu', 'File', 'Trạng thái', 'Người làm (model)', 'Ghi chú'].map((x) => h('th', null, x)))),
      h('tbody', null, ...(rows.length ? rows.map((e) => h('tr', null,
        h('td', { class: 'small' }, new Date(e.at).toLocaleString('vi-VN')),
        h('td', { class: 'mono small' }, e.id),
        h('td', { class: 'mono small' }, e.path),
        h('td', null, h('span', { class: cls(e.status) }, WO_STATUS[e.status] || e.status)),
        h('td', { class: 'small' }, e.owner || ''),
        h('td', { class: 'small break' }, e.note || '')))
        : [h('tr', null, h('td', { colspan: '6', class: 'muted' }, 'Chưa có phiếu nào.'))])))));
}
