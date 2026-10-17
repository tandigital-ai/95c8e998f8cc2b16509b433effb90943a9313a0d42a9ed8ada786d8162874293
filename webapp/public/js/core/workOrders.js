/**
 * workOrders.js — BAN ĐIỀU PHỐI (phần 1): Phiếu công việc (Work Order) + Sổ cái + Quy tắc hợp nhất.
 * Hàm thuần (không DOM, không AI) — có test ở tests/workOrders.test.js.
 */
export const WO_STATUS = Object.freeze({
  drafted: 'Có bản nháp (chưa kiểm được cú pháp)',
  verified: 'Qua kiểm tra tự động',
  blocked: 'Bị chặn',
  merged: 'Đã hợp nhất',
  rejected: 'Bị từ chối',
  superseded: 'Bị thay bằng phiếu mới'
});
export const LEDGER_MAX = 500;

const slug = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

/** Mã phiếu: WO-{6 ký tự cuối projectId}-{bước}-{file}-r{lần}. */
export function woId({ projectId, step, path, rev }) {
  const pid = String(projectId || 'p').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'p';
  return `WO-${pid}-${slug(step)}-${slug(path)}-r${rev}`;
}

/** Số lần (rev) tiếp theo cho cặp (bước, file) theo sổ cái. */
export function nextRev(ledger, step, path) {
  let n = 0;
  for (const e of ledger || []) if (e && e.step === step && e.path === path) n = Math.max(n, Number(e.rev) || 0);
  return n + 1;
}

/** Ghi thêm 1 dòng sổ cái, giữ tối đa `max` dòng mới nhất. */
export function appendLedger(ledger, entry, max = LEDGER_MAX) {
  const out = [...(ledger || []), entry];
  return out.length > max ? out.slice(-max) : out;
}

/** QUY TẮC HỢP NHẤT. Trả {ok, errors[], warnings[]}. */
export function checkMerge({ wo, currentContractHash, currentBaseHash, syntaxStatus, truncated }) {
  const errors = [];
  const warnings = [];
  if (!wo) errors.push('Đề xuất không có phiếu công việc (WO) — hãy tạo lại đề xuất.');
  else {
    if (wo.status !== 'drafted' && wo.status !== 'verified') errors.push(`Phiếu ${wo.id} đang ở trạng thái "${WO_STATUS[wo.status] || wo.status}".`);
    if (wo.contractHash && currentContractHash && wo.contractHash !== currentContractHash) errors.push(`Contract đã đổi sau khi tạo phiếu ${wo.id} (bản nháp làm theo Contract cũ) — hãy tạo lại đề xuất.`);
    if (wo.baseHash && currentBaseHash && wo.baseHash !== currentBaseHash) errors.push(`File đã bị thay đổi sau khi tạo phiếu ${wo.id} — hợp nhất sẽ ghi đè mất thay đổi đó. Hãy tạo lại đề xuất.`);
  }
  if (truncated) errors.push('Bản nháp BỊ CẮT — không hợp nhất.');
  if (syntaxStatus === 'fail') errors.push('Bản nháp LỖI CÚ PHÁP — không hợp nhất (tránh làm hỏng app).');
  else if (syntaxStatus !== 'pass') warnings.push('Loại file này chưa kiểm được cú pháp tự động — hãy xem kỹ diff.');
  return { ok: errors.length === 0, errors, warnings };
}
