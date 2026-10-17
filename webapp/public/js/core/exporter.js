/**
 * exporter.js — Đóng gói dự án: ZIP chuẩn + manifest.json (SHA-256 + TRẠNG THÁI KIỂM TRA THẬT).
 * Banner tác giả là TÙY CHỌN (mặc định TẮT) và chỉ chèn lúc xuất, không sửa dữ liệu lưu.
 *
 * Cấu trúc ZIP:
 *   <slug>/README.md
 *   <slug>/<mã nguồn theo platform>
 *   <slug>/docs/Claude.md
 *   <slug>/docs/skills/<skill>.md
 *   <slug>/docs/contract.json
 *   <slug>/docs/validation-report.json
 *   <slug>/docs/diagram.mmd   (+ diagram.svg nếu có)
 *   <slug>/data/seed.json     (nếu có)
 *   <slug>/manifest.json
 */
import { sha256Hex, byteLength } from './hash.js';
import { langOf } from './platforms.js';

export function slugify(name) {
  const s = String(name || 'ai-project')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'ai-project').slice(0, 60);
}

/** Đường dẫn an toàn trong ZIP (chặn ../ và đường dẫn tuyệt đối). */
export function safeZipPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..');
  if (!parts.length) throw new Error(`Đường dẫn file không hợp lệ: "${p}"`);
  return parts.join('/');
}

/**
 * Chèn banner tác giả theo đúng cú pháp chú thích của từng loại file.
 * Không chèn vào: json, md, txt (requirements), env, file có shebang (chèn sau shebang), file đã có banner.
 */
export function applyBanner(path, code, banner) {
  if (!banner?.enabled) return code;
  const lines = [`Tác giả: ${banner.author || ''}`.trim(), banner.contact ? `Liên hệ: ${banner.contact}` : '', banner.tagline || '', `© ${new Date().getFullYear()}`].filter((x) => x && x !== 'Tác giả:');
  if (!lines.length) return code;
  const lang = langOf(path);
  const marker = 'AI-ARCHITECT-BANNER';
  if (String(code).includes(marker)) return code;
  let header;
  if (['json', 'md', 'txt', 'env'].includes(lang)) return code;
  if (lang === 'html') header = `<!-- ${marker}\n${lines.join('\n')}\n-->\n`;
  else if (lang === 'py' || lang === 'yaml' || lang === 'docker') header = lines.map((l) => `# ${l}`).join('\n') + `\n# ${marker}\n`;
  else if (lang === 'css') header = `/* ${marker}\n${lines.map((l) => ' * ' + l).join('\n')}\n */\n`;
  else header = `/* ${marker}\n${lines.map((l) => ' * ' + l).join('\n')}\n */\n`;
  const text = String(code);
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    return text.slice(0, nl + 1) + header + text.slice(nl + 1);
  }
  if (lang === 'html' && /^\s*<!doctype/i.test(text)) {
    const end = text.indexOf('>') + 1;
    return text.slice(0, end) + '\n' + header + text.slice(end).replace(/^\n/, '');
  }
  return header + text;
}

/** Mô tả trạng thái kiểm tra của 1 file cho manifest (không phóng đại). */
export function fileCheckSummary(f) {
  return {
    state: f.state || 'draft',
    truncated: !!f.truncated,
    syntax: f.checks?.syntax ? { status: f.checks.syntax.status, checker: f.checks.syntax.checker || null, message: f.checks.syntax.message } : { status: 'not-run' },
    consistency: f.checks?.consistency ? { status: f.checks.consistency.status, errors: f.checks.consistency.errors ?? 0, warnings: f.checks.consistency.warnings ?? 0 } : { status: 'not-run' },
    review: f.checks?.review ? { status: f.checks.review.status, issues: f.checks.review.issues ?? 0 } : { status: 'not-run' },
    runtimeTested: false
  };
}

/**
 * Tạo danh sách entry (đường dẫn trong ZIP + nội dung) và manifest. Hàm thuần (async vì băm).
 * @param {object} p
 * @param {object} p.project  {id, name, platform}
 * @param {object} p.snapshot {claudeMd, skills[], diagram, diagramSvg?, contract?, contractText?, validation?, seed?, readme?, files: {path:{content,state,checks,truncated}}}
 * @param {object} [p.banner]
 */
export async function buildExportEntries({ project, snapshot, banner = null, versionId = null, appVersion = '0.1.0' }) {
  const root = slugify(project?.name || snapshot?.contract?.projectName || 'ai-project');
  const entries = [];
  const fileMeta = [];
  const add = async (rel, content, meta = {}) => {
    const path = `${root}/${safeZipPath(rel)}`;
    const text = String(content ?? '');
    entries.push({ path, content: text });
    fileMeta.push({ path: safeZipPath(rel), bytes: byteLength(text), sha256: await sha256Hex(text), ...meta });
  };

  const files = snapshot.files || {};
  for (const [p, f] of Object.entries(files)) {
    if (/^readme\.md$/i.test(p)) continue;
    const content = applyBanner(p, f.content ?? '', banner);
    await add(p, content, { kind: 'source', ...fileCheckSummary(f), bannerApplied: content !== (f.content ?? '') });
  }
  const readme = snapshot.readme ?? files['README.md']?.content ?? null;
  if (readme) await add('README.md', readme, { kind: 'doc', ...(snapshot.readmeState ? { state: snapshot.readmeState } : {}) });
  else await add('README.md', `# ${project?.name || root}\n\n> README chưa được sinh. Xem docs/Claude.md.\n`, { kind: 'doc', state: 'placeholder' });
  if (snapshot.claudeMd) await add('docs/Claude.md', snapshot.claudeMd, { kind: 'doc' });
  for (const s of snapshot.skills || []) await add(`docs/skills/${safeZipPath(s.filename)}.md`, s.content, { kind: 'skill', name: s.name });
  if (snapshot.contract || snapshot.contractText) await add('docs/contract.json', snapshot.contract ? JSON.stringify(snapshot.contract, null, 2) : snapshot.contractText, { kind: 'contract', valid: !!snapshot.contractValid });
  if (snapshot.validation) await add('docs/validation-report.json', JSON.stringify(snapshot.validation, null, 2), { kind: 'report' });
  if (snapshot.diagram) await add('docs/diagram.mmd', snapshot.diagram, { kind: 'diagram' });
  if (snapshot.diagramSvg) await add('docs/diagram.svg', snapshot.diagramSvg, { kind: 'diagram' });
  if (snapshot.seed) await add('data/seed.json', JSON.stringify(snapshot.seed, null, 2), { kind: 'data', validated: !!snapshot.seedValid });

  const counts = { total: 0, truncated: 0, syntaxPass: 0, syntaxFail: 0, syntaxUnchecked: 0, consistencyChecked: 0, reviewed: 0 };
  for (const m of fileMeta.filter((x) => x.kind === 'source')) {
    counts.total++;
    if (m.truncated) counts.truncated++;
    if (m.syntax.status === 'pass') counts.syntaxPass++;
    else if (m.syntax.status === 'fail') counts.syntaxFail++;
    else counts.syntaxUnchecked++;
    if (m.consistency.status !== 'not-run') counts.consistencyChecked++;
    if (m.review.status !== 'not-run') counts.reviewed++;
  }
  const manifest = {
    format: 'ai-architect-export',
    formatVersion: 1,
    generator: `AI System Architect (web) ${appVersion}`,
    exportedAt: new Date().toISOString(),
    project: { id: project?.id || null, name: project?.name || root, platform: project?.platform || null, versionId },
    honesty: 'Trạng thái dưới đây chỉ phản ánh các kiểm tra ĐÃ CHẠY trong trình duyệt. Không file nào được build hay chạy thử thật (runtimeTested=false).',
    summary: counts,
    files: fileMeta
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  entries.push({ path: `${root}/manifest.json`, content: manifestText });
  return { root, entries, manifest };
}

/** Tạo ZIP bằng JSZip (truyền class JSZip vào để test được trong Node). */
export async function buildZipBlob({ JSZip, entries, type = 'blob' }) {
  if (!JSZip) throw new Error('Thiếu thư viện JSZip (vendor/jszip.min.js).');
  const zip = new JSZip();
  for (const e of entries) zip.file(e.path, e.content);
  return zip.generateAsync({ type, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Ghi thẳng ra thư mục bằng File System Access API (nếu trình duyệt hỗ trợ). */
export async function writeToDirectory(dirHandle, entries) {
  let n = 0;
  for (const e of entries) {
    const parts = e.path.split('/');
    let dir = dirHandle;
    for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(e.content);
    await w.close();
    n++;
  }
  return n;
}

/** Tải 1 file văn bản (dùng FileSaver nếu có, nếu không dùng thẻ a). */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  if (typeof globalThis.saveAs === 'function') { globalThis.saveAs(blob, filename); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** CSV an toàn (escape dấu nháy, chống CSV injection với ký tự đầu = + - @). */
export function toCsv(rows, columns) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map((c) => esc(c.label || c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n');
}
