/**
 * prompts.js — Toàn bộ prompt gửi AI, ở một chỗ, hàm thuần (dễ đọc, dễ sửa, có test).
 * Port từ Orchestrator.gs + V3.2, sửa các lỗi: thiếu "4 phần" mà chỉ có 3, nối vòng mất ngữ cảnh,
 * ảnh làm mất tệp tham chiếu, prompt debug cố định "GAS engineer".
 */
import { getPlatform } from './platforms.js';
import { contractTemplate, CONTRACT_SCHEMA_VERSION } from './contract.js';
import { DIAGRAM_LIMITS } from './mermaidSanitize.js';

const langName = (l) => (l === 'en' ? 'English' : 'Vietnamese');

/* ------------------------------------------------------------------ */
/* Kiến trúc                                                           */
/* ------------------------------------------------------------------ */
export function architectureSystem({ platformId, outputLang = 'vi', providers = [] }) {
  const p = getPlatform(platformId);
  const files = p.files.map((f) => `${f.path} (${f.role})`).join('; ');
  const prov = providers.length ? providers.map((x) => `- ${x.name}: ${x.model}`).join('\n') : '- (không khai báo — tự đề xuất loại model phù hợp)';
  return [
    `You are AI System Architect, a master software/AI system architect specializing in ${p.name}.`,
    `FIXED FILE LIST for this platform (use ONLY these exact paths, do not invent others): ${files}.`,
    'Analyze the idea, then define 3-7 specialized AI Bot roles (skills) that will design/build/operate the system.',
    'MANDATORY: one bot MUST be named "Data Seeder & QA". It generates realistic SAMPLE DATA and basic test cases so the app works on first run.',
    '',
    'OUTPUT EXACTLY THREE SECTIONS IN THIS ORDER, using the exact markers (no code fences around markers):',
    '',
    '===CLAUDE_MD_START===',
    `[Full specification in Markdown (${langName(outputLang)}): overview, functional and non-functional requirements, data entities with fields, screens/user actions, architecture mapped onto the fixed files, data flow, ${p.name} implementation notes, deployment steps, risk matrix. Aim for 600-1200 words.]`,
    '===CLAUDE_MD_END===',
    '',
    '===DIAGRAM_START===',
    'flowchart TD',
    '  U1["User"] --> P1["Main flow"]',
    '===DIAGRAM_END===',
    '',
    '===SKILL_START:skill-01:Role Name===',
    '[Skill.md: role objective, recommended model type, full SYSTEM PROMPT for this bot, workflow steps, input/output format, platform guidelines]',
    '===SKILL_END===',
    '(repeat SKILL blocks for skill-02, skill-03, ... up to skill-07)',
    '',
    'AVAILABLE PROVIDERS/MODELS (for assignment suggestions only):',
    prov,
    '',
    'RULES:',
    `- Diagram: valid Mermaid "flowchart TD", max ${DIAGRAM_LIMITS.maxNodes} nodes, max ${DIAGRAM_LIMITS.maxEdges} edges, ASCII node ids, every label in double quotes, max ${DIAGRAM_LIMITS.maxLabelWords} words, no parentheses/brackets/colons inside labels, edge labels as A -->|"label"| B.`,
    '- At least 3 SKILL blocks. Skill ids skill-01, skill-02 ... unique.',
    '- Never stop after Claude.md: all three sections are required.',
    `- Write all prose in ${langName(outputLang)}.`
  ].join('\n');
}

/**
 * Nội dung user cho bước kiến trúc. Ảnh và tệp đi CÙNG NHAU (bản GAS mất tệp khi có ảnh).
 * @param {{idea, platformId, outputLang, images?:Array<{name,dataUrl}>, refFiles?:Array<{name,content}>}} p
 * @returns {string|Array} content dạng OpenAI (chuỗi hoặc multi-part)
 */
export function architectureUser({ idea, platformId, outputLang = 'vi', images = [], refFiles = [] }) {
  const p = getPlatform(platformId);
  const vi = outputLang !== 'en';
  let text = (vi
    ? `Phân tích ý tưởng sau và tạo kiến trúc TOÀN DIỆN (đủ 3 phần: Claude.md, Diagram, 3-7 Skill, trong đó có "Data Seeder & QA") cho nền tảng ${p.name}:`
    : `Analyze the idea and produce a COMPLETE architecture (all 3 sections: Claude.md, Diagram, 3-7 Skills including "Data Seeder & QA") for ${p.name}:`)
    + `\n\n---\n${idea}\n---`;
  if (refFiles.length) {
    text += '\n\n===== ' + (vi ? 'TỆP THAM CHIẾU (đọc kỹ, bám sát khi thiết kế)' : 'REFERENCE FILES (read carefully)') + ' =====\n'
      + refFiles.map((f) => `### FILE: ${f.name}\n${f.content}`).join('\n\n');
  }
  if (images.length) {
    text += '\n\n' + (vi
      ? 'QUAN TRỌNG: có ẢNH GIAO DIỆN MẪU đính kèm. Phân tích layout, màu sắc, bố cục, thành phần UI và tính năng nhìn thấy. Trong Claude.md và Skills: (1) mô tả tái tạo đầy đủ mọi thành phần/tính năng thấy trong ảnh; (2) đề xuất thêm 3-5 tính năng nâng cao hợp lý; (3) ghi rõ yêu cầu CSS (màu, khoảng cách, bố cục) khớp ảnh.'
      : 'IMPORTANT: reference UI screenshots are attached. Reproduce every visible component/feature, suggest 3-5 sensible enhancements, and specify CSS requirements matching the images.');
    return [{ type: 'text', text }, ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }))];
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Diagram (prompt V3.2: theo nghiệp vụ, có subgraph, giới hạn node)   */
/* ------------------------------------------------------------------ */
export function diagramSystem({ platformId, outputLang = 'vi' }) {
  const p = getPlatform(platformId);
  return [
    `You are a senior Solution Architect. Produce ONE clean, readable Mermaid flowchart of the business and data flow for ${p.name}.`,
    'CONTENT: main happy-path flow + key decision points; group nodes into 4-5 subgraphs (Actors, Business Process, AI Layer, Data Stores, Integrations); show where AI bots plug in and where data is read/written.',
    `HARD LIMITS: max ${DIAGRAM_LIMITS.maxNodes} nodes, max ${DIAGRAM_LIMITS.maxEdges} edges, each label max ${DIAGRAM_LIMITS.maxLabelWords} words on a single line.`,
    'SYNTAX (strict): start with "flowchart TD"; short ASCII node ids (U1, P1, AI1, DB1); ALWAYS quote labels P1["..."]; decisions D1{"...?"}; data DB1[("...")]; edge labels A -->|"label"| B only; never put newline, | { } [ ] ( ) : inside labels; one statement per line.',
    'Output ONLY the code between ===DIAGRAM_START=== and ===DIAGRAM_END===. No fences, no prose.',
    `Labels in ${langName(outputLang)}.`
  ].join('\n');
}

export function diagramUser({ claudeMd = '', idea = '', skills = [], outputLang = 'vi' }) {
  const vi = outputLang !== 'en';
  const ctx = claudeMd ? `=== BUSINESS SPECIFICATION (Claude.md) ===\n${claudeMd}\n=== END ===` : `=== PROJECT IDEA ===\n${idea}\n=== END ===`;
  const sk = skills.length ? skills.map((s) => `- ${s.filename}: ${s.name}`).join('\n') : '(none yet)';
  return `${vi ? 'Đọc kỹ đặc tả và vẽ sơ đồ luồng NGHIỆP VỤ & DỮ LIỆU đúng bản chất quy trình (KHÔNG vẽ cây "ý tưởng → nền tảng → file").' : 'Draw an accurate BUSINESS & DATA-FLOW diagram (not an idea→platform→files tree).'}\n\n${ctx}\n\nAI BOTS:\n${sk}`;
}

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */
export function contractSystem({ platformId, outputLang = 'vi', fileList }) {
  const p = getPlatform(platformId);
  return [
    'You are a LEAD SOFTWARE ARCHITECT. STEP 1: read the ENTIRE spec and ALL bot skills. STEP 2: list every feature, screen, data entity and user action. STEP 3: define the SINGLE SOURCE OF TRUTH that every file MUST follow.',
    'Output ONE strict JSON object ONLY (no markdown, no fences, no comments) with EXACTLY this shape:',
    JSON.stringify(contractTemplate(fileList), null, 2),
    '',
    'RULES:',
    `- "schemaVersion" MUST be ${CONTRACT_SCHEMA_VERSION}.`,
    `- FILE NAMES ARE FIXED. Every "file" value MUST be one of: ${fileList.join(', ')}. Never use any other file name.`,
    '- Each function name appears EXACTLY ONCE in "functions" with exactly ONE owning file. Other files call it, never redefine it.',
    '- "params" is an array of "name:type" strings (empty array if none). "returns" is a type string ("void" if nothing).',
    '- dataSchema field names are the ONLY allowed field names everywhere. Field "type" uses: string, number, integer, boolean, date, datetime, id, email, url, enum, object, array, json, text.',
    '- DOM ids are globally unique and reused consistently between markup and scripts.',
    '- globalConstants each have one owning "file".',
    `- Every file in the fixed list appears once in fileResponsibilities. Platform: ${p.name}. ${p.scope === 'gas-global' ? 'All .gs files share ONE global scope: never assign the same constant/function name to two files.' : ''}`,
    '- COVERAGE: every feature in the spec maps to at least one function and one entity. Do not invent features not in the spec.',
    `- Valid JSON only: double-quoted strings, no trailing commas. Use ${langName(outputLang)} in "desc" fields.`
  ].join('\n');
}

export function contractUser({ claudeMd, skills = [], fileList, platformId }) {
  return [
    'PROJECT SPEC (Claude.md):',
    claudeMd,
    '',
    'AI BOT ROLES (context only — do NOT make one project per bot):',
    skills.map((s) => `- ${s.filename}: ${s.name}`).join('\n') || '(none)',
    '',
    `PLATFORM: ${getPlatform(platformId).name}`,
    `FILES: ${fileList.join(', ')}`,
    '',
    'Produce the unified technical contract JSON now.'
  ].join('\n');
}

export function contractRepairUser({ previousText, errors }) {
  return [
    'Your previous contract JSON failed validation. Fix ONLY these problems and return the FULL corrected JSON object (no prose, no fences):',
    errors.map((e) => `- ${e.path}: ${e.message}`).join('\n'),
    '',
    'PREVIOUS JSON:',
    previousText
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Code builder                                                        */
/* ------------------------------------------------------------------ */
export function codeSystem({ platformId, outputLang = 'vi' }) {
  const p = getPlatform(platformId);
  return [
    `You are a master ${p.name} engineer building ONE UNIFIED system (not a standalone mini-app).`,
    'Write the COMPLETE implementation of the SINGLE requested file. Production quality, no placeholders, no TODO, no "rest unchanged".',
    'STRICTLY OBEY THE PROJECT CONTRACT (single source of truth):',
    '- Use ONLY data field/entity names from contract.dataSchema.',
    '- Define ONLY functions whose owning file is THIS file; for functions owned by other files, CALL them with the exact signature.',
    '- Use ONLY global constant names from the contract; declare only constants owned by THIS file.',
    '- Use ONLY DOM ids listed in the contract; markup and scripts must match.',
    '- Never redefine anything listed in "ALREADY BUILT FILES — API SURFACE".',
    p.scope === 'gas-global' ? '- Google Apps Script: all .gs files share ONE global scope — never declare the same name in two .gs files. Functions called from the client via google.script.run must NOT end with "_".' : '- Use the module system of the platform (import/export) consistently.',
    ...p.notes.map((n) => '- ' + n),
    'UI QUALITY (markup/style/client files): professional modern admin design — CSS variables for a coherent color palette, sidebar navigation with icons (inline SVG or emoji) and a clear active state, NO default blue underlined links, cards with rounded corners and soft shadow, styled tables (header, zebra rows, hover), styled buttons and form inputs, loading spinner, friendly empty states, toast notifications, responsive layout (collapsible sidebar on mobile). Every menu item must open a working view with real data.',
    'SAMPLE DATA: never ask the user to write code to load data. GAS: sample data is loaded by an auto-generated file SeedData.gs (sheet name = entity.store, row 1 = field names) — read data from those sheets by header names. Other platforms: on first run, if storage is empty, load data/seed.json whose shape is {"<Entity>":[rows]}.',
    'SELF-CHECK before answering: every field exists in dataSchema; every function you define is owned by this file; every function you call exists in the contract.',
    `OUTPUT: raw file content only. No markdown fences, no explanations. Comments in ${langName(outputLang)}.`
  ].join('\n');
}

export function codeUser({ claudeMd, contractText, contractNote = '', fileSpec, surface = '', stub = '', skills = [] }) {
  return [
    '========= PROJECT CONTRACT (OBEY EXACTLY) =========',
    contractText,
    '========= END CONTRACT =========',
    contractNote ? `NOTE: ${contractNote}` : '',
    '',
    'PROJECT SPEC (Claude.md):',
    claudeMd,
    '',
    'AI BOT SKILLS (business context):',
    skills.map((s) => `- ${s.filename}: ${s.name}`).join('\n') || '(none)',
    '',
    surface ? 'ALREADY BUILT FILES — API SURFACE (do not redefine; call these):\n' + surface : 'No other file has been built yet.',
    '',
    `FILE TO IMPLEMENT: ${fileSpec.path}`,
    `ROLE: ${fileSpec.role || '(see contract.fileResponsibilities)'}`,
    stub ? `CURRENT DRAFT:\n${stub}` : '',
    '',
    `Output the COMPLETE content of ${fileSpec.path} now.`
  ].filter((x) => x !== '').join('\n');
}

/* ------------------------------------------------------------------ */
/* README                                                              */
/* ------------------------------------------------------------------ */
export function readmeSystem({ outputLang = 'vi' }) {
  return `You are a senior technical writer. Write a COMPLETE README.md in ${langName(outputLang)} for a BEGINNER. Output ONLY raw Markdown, no fence around the whole document. Do not claim the code was tested or runs; say it must be verified by the user.`;
}

export function readmeUser({ claudeMd, platformId, fileList, skills = [], validationSummary = '', outputLang = 'vi' }) {
  const p = getPlatform(platformId);
  const vi = outputLang !== 'en';
  return [
    vi ? `Viết README.md đầy đủ, thân thiện người mới, cho dự án trên ${p.name}.` : `Write a complete beginner-friendly README.md for a ${p.name} project.`,
    vi ? 'Gồm: Giới thiệu, Tính năng, Yêu cầu hệ thống, Cài đặt từng bước, Cấu hình (API key/biến môi trường), Hướng dẫn DEPLOY chi tiết từng bước, Cấu trúc thư mục, Cách chạy, Nạp dữ liệu mẫu (GAS: mở trình soạn Apps Script → chọn hàm aiaLoadSampleData trong file SeedData.gs → bấm ▶ Chạy → cấp quyền; TUYỆT ĐỐI không yêu cầu người dùng tự viết code. Nền tảng khác: app tự nạp data/seed.json lần chạy đầu), Xử lý lỗi thường gặp, Trạng thái kiểm tra (mã được sinh bởi AI, chưa build/chạy thử), Giấy phép.'
      : 'Include: Intro, Features, Requirements, Step-by-step setup, Configuration, detailed DEPLOY guide, Project structure, How to run, Loading sample data (GAS: run function aiaLoadSampleData in SeedData.gs; never ask the user to write code), Troubleshooting, Verification status (AI-generated, not built/run), License.',
    '',
    'PROJECT SPEC:',
    claudeMd,
    '',
    'FILES: ' + fileList.join(', '),
    'AI BOTS: ' + (skills.map((s) => s.name).join(', ') || '(none)'),
    validationSummary ? 'AUTOMATED CHECK RESULTS (state honestly): ' + validationSummary : ''
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ */
/* Review / Fix / Seed / Analyze / Playground                          */
/* ------------------------------------------------------------------ */
export function reviewSystem({ outputLang = 'vi' }) {
  return [
    'You are a STRICT senior code reviewer. You get a PROJECT CONTRACT (source of truth), automated check findings, and ALL project files.',
    'Find ONLY real problems that would break deployment or consistency: syntax errors, undefined functions/variables, wrong signatures, duplicate definitions, field names not in contract, missing DOM ids, cross-file call errors, security issues (secrets in client code, XSS).',
    'Return STRICT JSON only, no fences: {"issues":[{"file":"exact path","severity":"error|warn","problem":"...","fix":"concrete instruction"}]}',
    'If you find nothing, return {"issues":[]}. "file" MUST be one of the given paths.',
    outputLang !== 'en' ? 'Write problem/fix in Vietnamese.' : ''
  ].filter(Boolean).join('\n');
}

export function reviewUser({ contractText, findings = [], files }) {
  return [
    'PROJECT CONTRACT:', contractText, '',
    'AUTOMATED FINDINGS (already detected by static checks):',
    findings.length ? findings.map((f) => `- [${f.level}] ${f.file || '-'}${f.line ? ':' + f.line : ''} ${f.message}`).join('\n') : '(none)',
    '', '===== ALL FILES =====',
    Object.entries(files).map(([p, c]) => `### FILE: ${p}\n${c}`).join('\n\n'),
    '', 'Review now. Output the JSON.'
  ].join('\n');
}

export function fixSystem({ outputLang = 'vi' }) {
  return [
    'You are a surgical code fixer. Fix ONLY the listed problems in the given file.',
    'ABSOLUTE RULES: do NOT change architecture, do NOT rename functions/constants/DOM ids, do NOT change data field names, do NOT remove features. Obey the PROJECT CONTRACT exactly. Keep everything that already works.',
    `Output the FULL corrected file as raw content, no fences, no explanation.${outputLang !== 'en' ? ' Keep comments in Vietnamese.' : ''}`
  ].join('\n');
}

export function fixUser({ contractText, path, problems, code, surface = '' }) {
  return [
    'PROJECT CONTRACT:', contractText, '',
    `FILE NAME: ${path}`, '',
    'PROBLEMS TO FIX:', problems.map((p) => `- ${p}`).join('\n'), '',
    surface ? 'OTHER FILES — API SURFACE (do not redefine):\n' + surface : '',
    '', 'CURRENT FILE CONTENT:', code, '',
    `Return the full corrected ${path} now.`
  ].filter((x) => x !== '').join('\n');
}

export function seedSystem({ outputLang = 'vi' }) {
  return [
    'You are a DATA SEEDER & QA engineer. Using the PROJECT CONTRACT (dataSchema is the source of truth), generate realistic SAMPLE DATA so the app works immediately.',
    'Use EXACTLY the entity names and field names from contract.dataSchema; every field of every entity must be present. 3-8 rows per entity. Keep ids consistent across entities (foreign keys must reference existing rows).',
    'Output STRICT JSON only, no fences: {"seed":{"<Entity>":[{...}]},"note":"how to load this data"}',
    outputLang !== 'en' ? 'Write "note" in Vietnamese and sample values in Vietnamese where natural.' : ''
  ].filter(Boolean).join('\n');
}

export function seedUser({ contractText }) {
  return `PROJECT CONTRACT:\n${contractText}\n\nGenerate the sample data JSON now.`;
}

export function analyzeSystem({ platformId, outputLang = 'vi' }) {
  const p = getPlatform(platformId);
  return outputLang !== 'en'
    ? `Bạn là kỹ sư ${p.name} cấp cao. Người dùng gửi ảnh chụp lỗi và/hoặc tệp code/tài liệu. Hãy: (1) mô tả bạn thấy gì; (2) chỉ ra nguyên nhân cụ thể; (3) đưa cách sửa RÕ RÀNG cho người KHÔNG biết code theo dạng:\n**File:** tên file\n**Tìm:**\n\`\`\`\n(đoạn cần tìm, chép nguyên văn)\n\`\`\`\n**Thay bằng:**\n\`\`\`\n(đoạn mới)\n\`\`\`\n(4) nếu không đủ thông tin, nói rõ cần thêm gì. Không bịa nội dung file không được gửi.`
    : `You are a senior ${p.name} engineer. The user sends error screenshots and/or files. (1) Describe what you see; (2) root cause; (3) beginner-friendly fixes as **File / Find / Replace with** blocks; (4) say what extra info is needed if insufficient. Never invent file content you were not given.`;
}

export function analyzeUser({ userText, images = [], texts = [], outputLang = 'vi' }) {
  const vi = outputLang !== 'en';
  const parts = [{ type: 'text', text: userText || (vi ? 'Hãy phân tích và chỉ cách sửa giúp tôi.' : 'Please analyze and debug.') }];
  for (const t of texts) parts.push({ type: 'text', text: `\n\n===== FILE: ${t.name} =====\n${t.content}` });
  for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  return parts.length === 1 ? parts[0].text : parts;
}
