/**
 * budget.js — Theo dõi token/chi phí BỀN VỮNG (IndexedDB store "usage") và CẢNH BÁO ngân sách.
 *
 * Nguyên tắc trung thực:
 *  - Không có giá => cost = null, hiển thị "không rõ giá". KHÔNG điền số tùy ý.
 *  - Token lấy từ usage của provider; nếu thiếu thì ước lượng (ký tự/4) và gắn nhãn "ước lượng".
 *  - Ngân sách chỉ là cảnh báo + hộp thoại xác nhận, KHÔNG phải chặn cứng (xem LIMITATIONS.md).
 *
 * Bản ghi usage:
 *   id "day:YYYY-MM-DD"      — tổng theo ngày
 *   id "project:<projectId>" — tổng theo dự án
 *   { id, scope, date?, projectId?, calls, cachedCalls, inTokens, outTokens,
 *     estimatedTokenCalls, knownCostUsd, unknownPriceCalls, byModel:{ "p:m": {...} }, updatedAt }
 */

export class BudgetError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Ước lượng token thô: số ký tự / 4 (làm tròn lên). */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return Math.ceil(s.length / 4);
}

/** Ước lượng token đầu vào của messages (chỉ phần chữ; ảnh không ước lượng được). */
export function estimateMessagesTokens(messages) {
  let chars = 0;
  let images = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === 'text') chars += String(p.text || '').length;
        else if (p?.type === 'image_url') images++;
      }
    }
    chars += 8; // phần vai trò/định dạng
  }
  return { tokens: Math.ceil(chars / 4), images };
}

/** Ngày theo múi giờ cấu hình, dạng YYYY-MM-DD. */
export function dayKey(ts, timeZone = 'Asia/Ho_Chi_Minh') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (_e) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/**
 * Tra giá (USD / 1M token). Ưu tiên: giá người dùng nhập > giá động từ provider (vd OpenRouter).
 * @returns {{in:number,out:number,source:'user'|'provider'}|null}
 */
export function lookupPrice({ provider, model, userPricing = {}, providerPricing = {} }) {
  const u = userPricing[`${provider}:${model}`];
  if (u && Number.isFinite(Number(u.in)) && Number.isFinite(Number(u.out))) return { in: Number(u.in), out: Number(u.out), source: 'user' };
  const p = providerPricing?.[provider]?.[model];
  if (p && Number.isFinite(p.in) && Number.isFinite(p.out)) return { in: p.in, out: p.out, source: 'provider' };
  return null;
}

/** Tính chi phí. Không có giá => cost null. */
export function computeCost(inTokens, outTokens, price) {
  if (!price) return { cost: null, priceSource: 'unknown' };
  const cost = ((inTokens || 0) / 1e6) * price.in + ((outTokens || 0) / 1e6) * price.out;
  return { cost: Math.round(cost * 1e8) / 1e8, priceSource: price.source };
}

/** Định dạng tiền cho UI. */
export function formatUsd(v, { unknownLabel = 'không rõ giá' } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return unknownLabel;
  if (v === 0) return '$0';
  if (v < 0.0001) return '<$0.0001';
  return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));
}

function emptyRow(id, extra) {
  return {
    id, ...extra,
    calls: 0, cachedCalls: 0, inTokens: 0, outTokens: 0, estimatedTokenCalls: 0,
    knownCostUsd: 0, unknownPriceCalls: 0, byModel: {}, updatedAt: 0
  };
}

function addTo(row, e) {
  row.calls += 1;
  if (e.cached) row.cachedCalls += 1;
  row.inTokens += e.inTokens || 0;
  row.outTokens += e.outTokens || 0;
  if (e.tokenSource === 'estimated') row.estimatedTokenCalls += 1;
  if (!e.cached) {
    if (e.cost === null || e.cost === undefined) row.unknownPriceCalls += 1;
    else row.knownCostUsd = Math.round((row.knownCostUsd + e.cost) * 1e8) / 1e8;
  }
  const mk = `${e.provider}:${e.model}`;
  const m = row.byModel[mk] || { calls: 0, inTokens: 0, outTokens: 0, knownCostUsd: 0, unknownPriceCalls: 0 };
  m.calls += 1;
  m.inTokens += e.inTokens || 0;
  m.outTokens += e.outTokens || 0;
  if (!e.cached) {
    if (e.cost === null || e.cost === undefined) m.unknownPriceCalls += 1;
    else m.knownCostUsd = Math.round((m.knownCostUsd + e.cost) * 1e8) / 1e8;
  }
  row.byModel[mk] = m;
  row.updatedAt = e.ts;
  return row;
}

/**
 * @param {{db:object, getSettings:()=>object, getProviderPricing?:()=>object,
 *          confirm?:(info)=>Promise<boolean>, now?:()=>number}} opts
 */
export function createBudget({ db, getSettings, getProviderPricing = () => ({}), confirm = null, now = () => Date.now() }) {
  /** Các phạm vi người dùng đã đồng ý vượt (chỉ trong RAM, reset khi tải lại trang). */
  const approvals = new Set();
  const listeners = new Set();
  let chain = Promise.resolve();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error('[budget] listener lỗi', e); } } };

  const tz = () => getSettings().timeZone || 'Asia/Ho_Chi_Minh';

  function price(provider, model) {
    return lookupPrice({ provider, model, userPricing: getSettings().pricing || {}, providerPricing: getProviderPricing() });
  }

  async function getDay(date = dayKey(now(), tz())) {
    return (await db.get('usage', `day:${date}`)) || emptyRow(`day:${date}`, { scope: 'day', date });
  }
  async function getProject(projectId) {
    if (!projectId) return null;
    return (await db.get('usage', `project:${projectId}`)) || emptyRow(`project:${projectId}`, { scope: 'project', projectId });
  }

  return {
    price,
    estimateTokens,
    estimateMessagesTokens,

    /** Chi phí cho 1 lần gọi đã biết token. */
    costFor(provider, model, inTokens, outTokens) {
      return computeCost(inTokens, outTokens, price(provider, model));
    },

    /**
     * Ghi nhận 1 lần gọi (tuần tự hóa để không mất cập nhật khi gọi song song).
     * @param {{provider,model,inTokens,outTokens,tokenSource,cost,cached,projectId,ts?}} e
     */
    record(e) {
      const entry = { ...e, ts: e.ts || now() };
      chain = chain.then(async () => {
        const date = dayKey(entry.ts, tz());
        const day = addTo(await getDay(date), entry);
        await db.put('usage', day);
        if (entry.projectId) {
          const pr = addTo(await getProject(entry.projectId), entry);
          await db.put('usage', pr);
        }
        emit();
      });
      return chain;
    },

    getDay,
    getProject,

    async listDays(limit = 31) {
      const rows = await db.getAll('usage', { index: 'date', direction: 'prev', limit });
      return rows.filter((r) => r.scope === 'day');
    },

    /**
     * Ước tính trước cho 1 kế hoạch nhiều bước (pipeline lớn).
     * steps: [{label, provider, model, inTokens, outTokens}]
     * Trả tổng đã biết giá + danh sách bước không rõ giá. outTokens nên là mức TỐI ĐA (worst case).
     */
    estimatePlan(steps) {
      let known = 0;
      let inTok = 0;
      let outTok = 0;
      const unknown = [];
      const rows = steps.map((s) => {
        const c = computeCost(s.inTokens, s.outTokens, price(s.provider, s.model));
        inTok += s.inTokens || 0;
        outTok += s.outTokens || 0;
        if (c.cost === null) unknown.push(s.label);
        else known += c.cost;
        return { ...s, cost: c.cost, priceSource: c.priceSource };
      });
      return { steps: rows, inTokens: inTok, outTokens: outTok, knownCostUsd: Math.round(known * 1e8) / 1e8, unknownPriceSteps: unknown, tokenSource: 'estimated' };
    },

    /**
     * Kiểm tra mềm trước khi gọi. Trả về danh sách cảnh báo (không chặn).
     * @param {{projectId?:string, estimatedCost?:number|null}} p
     */
    async check({ projectId = null, estimatedCost = 0 } = {}) {
      const s = getSettings();
      const day = await getDay();
      const proj = projectId ? await getProject(projectId) : null;
      const est = Number.isFinite(estimatedCost) ? estimatedCost : 0;
      const warnings = [];
      if (s.dailyBudgetUsd > 0 && day.knownCostUsd + est >= s.dailyBudgetUsd) {
        warnings.push({ scope: 'day', key: `day:${day.date}`, used: day.knownCostUsd, limit: s.dailyBudgetUsd, estimate: est });
      }
      if (proj && s.projectBudgetUsd > 0 && proj.knownCostUsd + est >= s.projectBudgetUsd) {
        warnings.push({ scope: 'project', key: `project:${projectId}`, used: proj.knownCostUsd, limit: s.projectBudgetUsd, estimate: est });
      }
      return {
        warnings,
        day: { used: day.knownCostUsd, limit: s.dailyBudgetUsd, unknownPriceCalls: day.unknownPriceCalls },
        project: proj ? { used: proj.knownCostUsd, limit: s.projectBudgetUsd, unknownPriceCalls: proj.unknownPriceCalls } : null,
        estimateUnknown: estimatedCost === null
      };
    },

    /**
     * Cổng cảnh báo: nếu vượt ngân sách thì hỏi người dùng. Từ chối => BudgetError('DECLINED').
     * Đây là cảnh báo mềm: người dùng luôn có thể đồng ý tiếp tục.
     */
    async guard({ projectId = null, estimatedCost = 0, label = '' } = {}) {
      const s = getSettings();
      const res = await this.check({ projectId, estimatedCost });
      if (!res.warnings.length || s.confirmOverBudget === 'never') return { ...res, confirmed: false };
      const pending = s.confirmOverBudget === 'once' ? res.warnings.filter((w) => !approvals.has(w.key)) : res.warnings;
      if (!pending.length) return { ...res, confirmed: true };
      if (!confirm) return { ...res, confirmed: false };
      const ok = await confirm({ warnings: pending, label, estimateUnknown: res.estimateUnknown });
      if (!ok) throw new BudgetError('DECLINED', 'Bạn đã dừng lại vì vượt ngân sách cảnh báo.', { warnings: pending });
      for (const w of pending) approvals.add(w.key);
      return { ...res, confirmed: true };
    },

    resetApprovals() { approvals.clear(); },
    /** Chờ mọi lần ghi usage hoàn tất (dùng trong test / trước khi export). */
    flush() { return chain; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
