/**
 * architect.js — Bước 1: sinh kiến trúc (Claude.md + Diagram + Skills) bằng streaming, Hủy, tự nối.
 * Port generateArchitecture (GAS) + generate() (V3.2), sửa: nối vòng giữ toàn bộ ngữ cảnh + ảnh + tệp,
 * cắt sau N vòng ⇒ TRUNCATED (không lưu như thành công), bắt buộc bot "Data Seeder & QA".
 */
import { parseArchitecture } from '../core/parser.js';
import { architectureSystem, architectureUser } from '../core/prompts.js';
import { sanitizeMermaid } from '../core/mermaidSanitize.js';
import { filePaths, stubFor } from '../core/platforms.js';
import { hashObject } from '../core/hash.js';
import { modelFor, usableProviders, providerModels } from './models.js';

/** Đầu vào để băm (dùng cho pipeline: không gọi lại AI khi đầu vào không đổi). */
export function architectureInput(project) {
  const w = project.workspace || {};
  return {
    idea: w.idea || '',
    platform: project.platform,
    lang: project.outputLang,
    images: (w.images || []).map((i) => i.dataUrl.length + ':' + i.dataUrl.slice(-64)),
    refFiles: (w.refFiles || []).map((f) => f.name + ':' + f.content.length)
  };
}

/**
 * Gọi AI sinh kiến trúc. Lưu vào workspace của dự án hiện tại.
 * @returns {Promise<{status:'done'|'truncated', parsed, result}>}
 */
export async function generateArchitecture(app, { signal, onDelta, onEvent } = {}) {
  const project = await app.projects.getProject(app.state.project.id);
  const w = project.workspace;
  if (!w.idea?.trim()) throw new Error('Vui lòng nhập ý tưởng dự án.');
  const ref = modelFor(app, 'architect');
  const providers = usableProviders(app).map((pid) => ({ name: app.state.providerMeta[pid]?.name || pid, model: app.settings.providerOpt(pid).selectedModel || providerModels(app, pid)[0]?.id || '?' }));
  const messages = [
    { role: 'system', content: architectureSystem({ platformId: project.platform, outputLang: project.outputLang, providers }) },
    { role: 'user', content: architectureUser({ idea: w.idea, platformId: project.platform, outputLang: project.outputLang, images: w.images || [], refFiles: w.refFiles || [] }) }
  ];
  const result = await app.llm.complete({
    provider: ref.provider, model: ref.model, messages, step: 'architecture', projectId: project.id,
    maxTokens: Math.max(app.settings.get().maxTokens, 8192), signal, onDelta, onEvent
  });
  const parsed = parseArchitecture(result.content);
  const diag = parsed.diagram ? sanitizeMermaid(parsed.diagram) : null;
  const warnings = [...parsed.warnings];
  if (result.truncated) warnings.unshift({ code: 'truncated', message: `Đầu ra BỊ CẮT sau ${result.rounds} vòng nối (finish_reason=length). Kiến trúc CHƯA đầy đủ — hãy tăng max_tokens/số vòng hoặc dùng model khác rồi tạo lại.` });
  if (diag?.warnings.length) warnings.push(...diag.warnings.map((m) => ({ code: 'diagram_sanitized', message: 'Diagram: ' + m })));

  const inputHash = await hashObject(architectureInput(project));
  const hadContract = !!w.contract;
  await app.projects.updateWorkspace(project.id, {
    claudeMd: parsed.claudeMd,
    diagram: diag ? diag.code : '',
    diagramSvg: '',
    skills: parsed.skills,
    parseWarnings: warnings,
    archMeta: {
      at: Date.now(), provider: result.provider, model: result.model, rounds: result.rounds, truncated: result.truncated,
      cached: result.cached, cost: result.cost, usage: result.usage, fallbackFrom: result.fallbackFrom, rawLength: result.content.length, inputHash
    },
    rawArchitecture: result.content
  });
  // Tên dự án lấy từ tiêu đề Claude.md nếu đang là tên mặc định
  const title = (parsed.claudeMd.match(/^#\s+(.+)$/m) || [])[1];
  if (title && /^Dự án mới/.test(project.name)) await app.projects.rename(project.id, title.replace(/[*_`]/g, '').trim().slice(0, 80));

  // Stub "draft" cho các file chưa có
  const existing = await app.projects.filesMap(project.id);
  const list = project.fileList || filePaths(project.platform);
  for (const p of list) {
    if (!existing[p]) await app.projects.putFile(project.id, p, { content: stubFor(project.platform, p, title || project.name), origin: 'stub', generatedAt: null, checks: null, truncated: false });
  }
  if (hadContract) {
    const n = await app.projects.markStale(project.id, 'Kiến trúc đã được tạo lại');
    await app.projects.updateWorkspace(project.id, { contractStale: true });
    if (n) app.toast(`Kiến trúc mới ⇒ ${n} file code đã sinh trước đó được đánh dấu "Cũ — cần sinh lại".`, 'warn');
  }
  await app.reloadProject();
  return { status: result.truncated ? 'truncated' : 'done', parsed, result, warnings };
}
