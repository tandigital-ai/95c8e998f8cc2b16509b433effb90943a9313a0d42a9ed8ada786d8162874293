/**
 * parser.js — Phân tích đầu ra của AI Orchestrator (marker CLAUDE_MD / DIAGRAM / SKILL)
 * và trích JSON từ câu trả lời. Hàm thuần, có test.
 *
 * Chịu được: code fence bao quanh marker, khoảng trắng/ký tự ** thừa, CRLF,
 * marker mở mà không đóng (bị cắt giữa chừng). Luôn trả danh sách cảnh báo — không im lặng.
 */

// Marker linh hoạt: "===CLAUDE_MD_START===", "=== CLAUDE_MD_START ===", "**===CLAUDE_MD_START===**"
const M = (name) => `\\*{0,2}={3,}\\s*${name}\\s*={3,}\\*{0,2}`;
const RE_CLAUDE_START = new RegExp(M('CLAUDE_MD_START'), 'i');
const RE_CLAUDE_END = new RegExp(M('CLAUDE_MD_END'), 'i');
const RE_DIAG_START = new RegExp(M('DIAGRAM_START'), 'i');
const RE_DIAG_END = new RegExp(M('DIAGRAM_END'), 'i');
const RE_SKILL_START = /\*{0,2}={3,}\s*SKILL_START\s*:\s*([^:=\n]+?)\s*(?::\s*([^=\n]*?))?\s*={3,}\*{0,2}/gi;
const RE_SKILL_END = new RegExp(M('SKILL_END'), 'i');
const RE_ANY_MARKER = /\*{0,2}={3,}\s*(CLAUDE_MD_START|CLAUDE_MD_END|DIAGRAM_START|DIAGRAM_END|SKILL_START[^=\n]*|SKILL_END)\s*={3,}\*{0,2}/i;

export const SEEDER_RE = /seed|seeder|\bqa\b|quality|dữ liệu mẫu|du lieu mau|kiểm thử|kiem thu|test data|sample data/i;

/** Bỏ code fence ``` bao quanh một khối (đầu/cuối). */
export function stripFences(s) {
  let t = String(s ?? '').trim();
  t = t.replace(/^```[\w-]*[ \t]*\n?/, '').replace(/\n?```\s*$/, '');
  return t.trim();
}

/** Bỏ fence ở đầu/cuối phần (AI hay bọc marker trong fence); giữ fence nằm giữa nội dung. */
function cleanSection(s) {
  return stripFences(String(s ?? ''));
}

function sliceBetween(text, startRe, endRe) {
  const s = startRe.exec(text);
  if (!s) return { found: false };
  const from = s.index + s[0].length;
  const rest = text.slice(from);
  const e = endRe.exec(rest);
  if (!e) return { found: true, closed: false, body: rest, start: s.index, end: text.length };
  return { found: true, closed: true, body: rest.slice(0, e.index), start: s.index, end: from + e.index + e[0].length };
}

function slugifySkill(name, i) {
  const base = String(name || '')
    .replace(/\.md$/i, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || `skill-${String(i + 1).padStart(2, '0')}`;
}

/**
 * @param {string} content  toàn văn đầu ra của AI
 * @param {{minSkills?:number, requireSeeder?:boolean}} opts
 * @returns {{claudeMd:string, diagram:string, skills:Array<{filename,name,content,closed}>, warnings:Array<{code,message}>}}
 */
export function parseArchitecture(content, { minSkills = 3, requireSeeder = true } = {}) {
  const text = String(content ?? '').replace(/\r\n?/g, '\n');
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const result = { claudeMd: '', diagram: '', skills: [], warnings };

  if (!text.trim()) {
    warn('empty', 'AI không trả về nội dung nào.');
    return result;
  }

  // --- Claude.md ---
  const cm = sliceBetween(text, RE_CLAUDE_START, RE_CLAUDE_END);
  if (cm.found) {
    let body = cm.body;
    if (!cm.closed) {
      // Bị cắt hoặc thiếu marker đóng: lấy tới marker kế tiếp (nếu có)
      const next = RE_ANY_MARKER.exec(body);
      if (next) body = body.slice(0, next.index);
      warn('claude_md_unterminated', 'Thiếu marker CLAUDE_MD_END — Claude.md có thể bị cắt giữa chừng.');
    }
    result.claudeMd = cleanSection(body);
  } else {
    const next = RE_ANY_MARKER.exec(text);
    result.claudeMd = cleanSection(next ? text.slice(0, next.index) : text);
    warn('claude_md_marker_missing', 'Không thấy marker CLAUDE_MD_START — đã lấy phần văn bản trước marker đầu tiên làm Claude.md.');
  }
  if (!result.claudeMd) warn('claude_md_empty', 'Claude.md rỗng.');

  // --- Diagram ---
  const dg = sliceBetween(text, RE_DIAG_START, RE_DIAG_END);
  if (dg.found) {
    let body = dg.body;
    if (!dg.closed) {
      const next = RE_ANY_MARKER.exec(body);
      if (next) body = body.slice(0, next.index);
      warn('diagram_unterminated', 'Thiếu marker DIAGRAM_END — diagram có thể bị cắt.');
    }
    result.diagram = stripFences(body.replace(/^\s*```\s*mermaid\s*/i, ''));
    if (!result.diagram) warn('diagram_empty', 'Phần diagram rỗng.');
  } else {
    warn('diagram_missing', 'Không có phần DIAGRAM — có thể tạo riêng bằng nút "Diagram".');
  }

  // --- Skills ---
  RE_SKILL_START.lastIndex = 0;
  const starts = [];
  let m;
  while ((m = RE_SKILL_START.exec(text)) !== null) {
    starts.push({ index: m.index, end: m.index + m[0].length, file: m[1], name: m[2] });
  }
  const used = new Set();
  starts.forEach((s, i) => {
    const limit = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const seg = text.slice(s.end, limit);
    const e = RE_SKILL_END.exec(seg);
    let body;
    let closed = true;
    if (e) body = seg.slice(0, e.index);
    else {
      closed = false;
      const next = RE_ANY_MARKER.exec(seg);
      body = next ? seg.slice(0, next.index) : seg;
    }
    let filename = slugifySkill(s.file, i);
    if (used.has(filename)) {
      let k = 2;
      while (used.has(`${filename}-${k}`)) k++;
      warn('skill_duplicate_name', `Tên skill "${filename}" bị trùng — đổi thành "${filename}-${k}".`);
      filename = `${filename}-${k}`;
    }
    used.add(filename);
    const skill = { filename, name: String(s.name || '').trim() || 'AI Bot', content: cleanSection(body), closed };
    if (!closed) warn('skill_unterminated', `Skill "${filename}" thiếu marker SKILL_END — có thể bị cắt.`);
    if (!skill.content) warn('skill_empty', `Skill "${filename}" không có nội dung.`);
    result.skills.push(skill);
  });

  if (result.skills.length < minSkills) {
    warn('too_few_skills', `Chỉ có ${result.skills.length} skill (yêu cầu tối thiểu ${minSkills}).`);
  }
  if (requireSeeder && result.skills.length && !result.skills.some((s) => SEEDER_RE.test(s.name) || SEEDER_RE.test(s.filename))) {
    warn('missing_seeder', 'Không thấy bot "Data Seeder & QA" bắt buộc.');
  }
  return result;
}

/**
 * Trích object JSON từ câu trả lời AI (bỏ fence, lấy từ "{" đầu tới "}" cuối).
 * KHÔNG tự sửa JSON hỏng. Lỗi => trả {ok:false, error, line, column}.
 */
export function extractJson(text) {
  const raw = String(text ?? '');
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  if (fence && fence[1].includes('{')) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return { ok: false, error: 'Không tìm thấy object JSON trong câu trả lời.', text: t };
  const jsonText = t.slice(s, e + 1);
  try {
    return { ok: true, value: JSON.parse(jsonText), text: jsonText };
  } catch (err) {
    const pos = Number((String(err.message).match(/position (\d+)/) || [])[1]);
    let line = null;
    let column = null;
    if (Number.isFinite(pos)) {
      const before = jsonText.slice(0, pos);
      line = before.split('\n').length;
      column = pos - before.lastIndexOf('\n');
    } else {
      const lc = String(err.message).match(/line (\d+) column (\d+)/);
      if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
    }
    return { ok: false, error: 'JSON không hợp lệ: ' + err.message, line, column, text: jsonText };
  }
}

/** Bỏ fence bao ngoài mã nguồn AI trả về (```js ... ```), giữ nguyên nội dung bên trong. */
export function stripCodeFences(code) {
  const t = String(code ?? '').replace(/\r\n?/g, '\n');
  const m = t.match(/^\s*```[\w.+-]*[ \t]*\n([\s\S]*?)\n?```\s*$/);
  if (m) return m[1];
  return t.replace(/^\s*```[\w.+-]*[ \t]*\n/, '').replace(/\n```\s*$/, '');
}
