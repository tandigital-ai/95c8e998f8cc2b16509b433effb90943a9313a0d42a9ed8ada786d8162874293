/**
 * mermaidSanitize.js — Làm sạch mã Mermaid do AI sinh (hàm thuần, có test).
 * Viết lại sạch từ sanitizeMermaid của V3.2 (bản cũ có khối lặp/code chết sau return).
 *
 * - Bỏ fence, cắt văn bản thừa trước từ khóa diagram, bỏ dòng giải thích.
 * - Flowchart: ép "flowchart TD", gộp dòng vỡ do nhãn xuống dòng, chuyển "A --> B: x" và
 *   "A --> B |x|" thành "A -->|x| B", quote mọi nhãn node, bỏ ký tự cấm trong nhãn,
 *   giới hạn nhãn tối đa N từ, đổi id node không phải ASCII.
 * - Đếm node/edge và trả cảnh báo khi vượt giới hạn (18 node, 25 edge theo prompt cũ).
 */

export const DIAGRAM_LIMITS = Object.freeze({ maxNodes: 18, maxEdges: 25, maxLabelWords: 6 });

const DIAGRAM_KW = /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|gitGraph|timeline)\b/i;
const ARROW = '(-->|---|-\\.->|==>|--x|--o|-.-)';

export function cleanLabel(str, maxWords = DIAGRAM_LIMITS.maxLabelWords) {
  let s = String(str ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*["']+|["']+\s*$/g, '')
    .replace(/"/g, "'")
    .replace(/[{}[\]|<>`;#&]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/:/g, ' -')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean);
  if (maxWords && words.length > maxWords) s = words.slice(0, maxWords).join(' ') + '…';
  return s.slice(0, 60) || ' ';
}

function balanced(str) {
  let sq = 0; let cu = 0; let rd = 0; let q = 0;
  for (const ch of str) {
    if (ch === '"') q ^= 1;
    if (q) continue;
    if (ch === '[') sq++; else if (ch === ']') sq--;
    else if (ch === '{') cu++; else if (ch === '}') cu--;
    else if (ch === '(') rd++; else if (ch === ')') rd--;
  }
  return sq <= 0 && cu <= 0 && rd <= 0 && q === 0;
}

/** Id node hợp lệ: ASCII chữ/số/_ . Trả id an toàn ổn định. */
function safeId(id, map) {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) return id;
  if (!map.has(id)) map.set(id, 'N' + (map.size + 1));
  return map.get(id);
}

// Hình dạng node: id + mở/đóng
const SHAPES = [
  ['[(', ')]'], ['((', '))'], ['([', '])'], ['[[', ']]'], ['{{', '}}'], ['[/', '/]'], ['[\\', '\\]'], ['>', ']'],
  ['[', ']'], ['{', '}'], ['(', ')']
];

/** Chuẩn hóa nhãn trong mọi node "ID<shape>label<shape>". */
function normalizeNodes(line, maxWords, idMap) {
  let out = '';
  let i = 0;
  const s = line;
  while (i < s.length) {
    // Nhãn cạnh |...| đã được làm sạch: chép nguyên, không coi chữ bên trong là id node
    if (s[i] === '|') {
      const close = s.indexOf('|', i + 1);
      if (close > i) { out += s.slice(i, close + 1); i = close + 1; continue; }
    }
    // Chuỗi trong nháy: chép nguyên
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1);
      if (close > i) { out += s.slice(i, close + 1); i = close + 1; continue; }
    }
    const m = /^([A-Za-z0-9_\u00C0-\u1EF9]+)/.exec(s.slice(i));
    if (m && (i === 0 || /[\s&>-]/.test(s[i - 1]) || s[i - 1] === '|')) {
      const id = m[1];
      const after = i + id.length;
      let matched = false;
      for (const [open, close] of SHAPES) {
        if (s.startsWith(open, after)) {
          // tìm close tương ứng (bỏ qua bên trong dấu nháy)
          let j = after + open.length;
          let q = false;
          let found = -1;
          while (j < s.length) {
            if (s[j] === '"') q = !q;
            if (!q && s.startsWith(close, j)) { found = j; break; }
            j++;
          }
          if (found < 0) continue;
          const inner = s.slice(after + open.length, found);
          out += safeId(id, idMap) + open + '"' + cleanLabel(inner, maxWords) + '"' + close;
          i = found + close.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // id đứng một mình
      if (/^(subgraph|end|flowchart|graph|direction|classDef|class|style|linkStyle|click)$/i.test(id)) { out += id; i = after; continue; }
      out += safeId(id, idMap);
      i = after;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * @param {string} raw
 * @param {{maxLabelWords?:number}} opts
 * @returns {{code:string, warnings:string[], stats:{nodes:number, edges:number, kind:string}}}
 */
export function sanitizeMermaid(raw, { maxLabelWords = DIAGRAM_LIMITS.maxLabelWords, limits = DIAGRAM_LIMITS } = {}) {
  const warnings = [];
  if (!raw || !String(raw).trim()) {
    return { code: 'flowchart TD\n  A["Chưa có diagram"]', warnings: ['Diagram rỗng.'], stats: { nodes: 1, edges: 0, kind: 'flowchart' } };
  }
  let s = String(raw).replace(/\r\n?/g, '\n').trim();
  s = s.replace(/```+\s*mermaid/gi, '').replace(/```+/g, '');
  s = s.replace(/={3,}\s*DIAGRAM_(START|END)\s*={3,}/gi, '');
  const kw = DIAGRAM_KW.exec(s);
  if (kw) s = s.slice(kw.index);
  s = s.split('\n').filter((line) => {
    const t = line.trim();
    return t && !/^(here|dưới đây|đây là|note:|lưu ý|giải thích)/i.test(t) && !t.startsWith('>') && !/^#{1,6}\s/.test(t);
  }).join('\n').trim();

  const first = (s.split('\n')[0] || '').trim();
  const isFlow = /^(graph|flowchart)\b/i.test(first);
  if (!isFlow) {
    if (!kw) {
      warnings.push('Không nhận ra loại diagram — đã tạo flowchart rỗng.');
      return { code: 'flowchart TD\n  A["Không đọc được diagram"]', warnings, stats: { nodes: 1, edges: 0, kind: 'unknown' } };
    }
    warnings.push(`Loại diagram "${kw[1]}" chỉ được làm sạch cơ bản (không phải flowchart).`);
    return { code: s, warnings, stats: { nodes: 0, edges: 0, kind: kw[1] } };
  }

  // gộp dòng vỡ
  const lines = s.split('\n').slice(1);
  const merged = [];
  let buf = '';
  for (const line of lines) {
    buf = buf ? buf + ' ' + line.trim() : line;
    if (balanced(buf)) { merged.push(buf); buf = ''; }
  }
  if (buf) merged.push(buf);

  const idMap = new Map();
  const nodes = new Set();
  let edges = 0;
  const reColon = new RegExp(`^(\\s*)([^\\s]+)\\s*${ARROW}\\s*([^\\s|]+)\\s*:\\s*(.+?)\\s*$`);
  const reAfter = new RegExp(`^(\\s*)([^\\s]+)\\s*${ARROW}\\s*([^\\s|]+)\\s+\\|([^|]+)\\|\\s*$`);
  const body = merged.map((line) => {
    let t = line.replace(/;\s*$/, '');
    if (/^\s*%%/.test(t)) return t;
    t = t.replace(reColon, (_m, ind, a, ar, b, label) => `${ind}${a} ${ar === '---' ? '-->' : ar}|${cleanLabel(label, maxLabelWords)}| ${b}`);
    t = t.replace(reAfter, (_m, ind, a, ar, b, label) => `${ind}${a} ${ar}|${cleanLabel(label, maxLabelWords)}| ${b}`);
    // nhãn cạnh -- text --> => -->|text|
    t = t.replace(/--\s+([^-|>][^>]*?)\s+-->/g, (_m, label) => `-->|${cleanLabel(label, maxLabelWords)}|`);
    // nhãn cạnh |...|
    t = t.replace(/\|([^|]*)\|/g, (_m, inner) => '|' + cleanLabel(inner, maxLabelWords) + '|');
    t = normalizeNodes(t, maxLabelWords, idMap);
    const trimmed = t.trim();
    if (/^(subgraph|end|direction|classDef|class|style|linkStyle|click)\b/i.test(trimmed)) {
      if (/^subgraph\b/i.test(trimmed)) {
        // subgraph id["Nhãn"] hoặc subgraph Nhãn tự do
        const rest = trimmed.slice(8).trim();
        if (rest && !/^[A-Za-z][\w]*(\[".*"\])?$/.test(rest)) return t.replace(rest, `SG${idMap.size + 1}["${cleanLabel(rest, maxLabelWords)}"]`);
      }
      return t;
    }
    const edgeCount = (trimmed.match(/-->|==>|-\.->|--x|--o|---/g) || []).length;
    edges += edgeCount;
    const ids = trimmed.replace(/\|[^|]*\|/g, ' ').replace(/"[^"]*"/g, '').match(/\b[A-Za-z][A-Za-z0-9_]*\b/g) || [];
    ids.forEach((id) => { if (!/^(TD|TB|LR|RL|BT)$/.test(id)) nodes.add(id); });
    return t;
  });

  const code = ['flowchart TD', ...body].join('\n');
  if (idMap.size) warnings.push(`Đã đổi ${idMap.size} id node không phải ASCII.`);
  if (nodes.size > limits.maxNodes) warnings.push(`Diagram có ${nodes.size} node (giới hạn khuyến nghị ${limits.maxNodes}) — có thể khó đọc.`);
  if (edges > limits.maxEdges) warnings.push(`Diagram có ${edges} cạnh (giới hạn khuyến nghị ${limits.maxEdges}).`);
  if (!/^(flowchart)\s+TD/i.test(first)) warnings.push(`Đã đổi "${first}" thành "flowchart TD".`);
  return { code, warnings, stats: { nodes: nodes.size, edges, kind: 'flowchart' } };
}

/** Sơ đồ workflow các BOT (port openWorkflow của bản GAS). */
export function workflowDiagram(skills = []) {
  const lines = ['flowchart TD', '  IN["Đầu vào - Ý tưởng + Ảnh mẫu"] --> ORCH["Orchestrator"]', '  ORCH --> CT["Contract - nguồn sự thật"]'];
  const bots = skills.map((s, i) => ({ id: 'S' + i, name: cleanLabel(s.name || s.filename, 5) }));
  if (bots.length) {
    bots.forEach((b) => lines.push(`  CT --> ${b.id}["${b.name}"]`));
    bots.forEach((b) => lines.push(`  ${b.id} --> BUILD["Code Builder"]`));
  } else lines.push('  CT --> BUILD["Code Builder"]');
  lines.push('  BUILD --> SYN["Kiểm tra cú pháp"]', '  SYN --> CON["Kiểm tra nhất quán"]', '  CON --> REV["AI Review"]', '  REV --> FIX["Fix - chờ duyệt diff"]', '  FIX --> SEED["Dữ liệu mẫu"]', '  SEED --> DOC["README"]', '  DOC --> VER["Lưu version"]');
  return lines.join('\n');
}
