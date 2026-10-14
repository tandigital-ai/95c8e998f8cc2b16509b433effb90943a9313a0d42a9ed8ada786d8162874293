/**
 * platforms.js — Preset nền tảng: NGUỒN DUY NHẤT cho danh sách file, ngôn ngữ, hướng dẫn.
 * Mọi nơi khác (prompt, contract, builder, consistency, exporter) đọc từ đây.
 *
 * Mỗi file: { path, role, lang, kind } — kind: 'code' | 'config' | 'doc' | 'data' | 'markup' | 'style'
 * `scope`: 'gas-global' (mọi .gs chung 1 global scope) | 'module' (ES/CommonJS module) | 'other'.
 */

const f = (path, role, lang, kind = 'code') => ({ path, role, lang, kind });

export const PLATFORMS = Object.freeze({
  gas: {
    id: 'gas',
    name: 'Google Apps Script (GAS)',
    scope: 'gas-global',
    runtime: 'Google Apps Script V8',
    files: [
      f('appsscript.json', 'Manifest: timezone, runtime V8, quyền webapp', 'json', 'config'),
      f('Config.gs', 'Hằng số cấu hình dùng chung (tên sheet, khóa properties)', 'gs'),
      f('Code.gs', 'Entry point: doGet, include(), menu onOpen', 'gs'),
      f('Models.gs', 'Truy cập dữ liệu (Sheet/Properties): đọc/ghi entity', 'gs'),
      f('Handlers.gs', 'Hàm public gọi qua google.script.run (validate đầu vào)', 'gs'),
      f('Utils.gs', 'Tiện ích thuần: định dạng, kiểm tra, log', 'gs'),
      f('Index.html', 'Giao diện chính (HtmlService)', 'html', 'markup'),
      f('Stylesheet.html', 'CSS nhúng bằng include()', 'html', 'style'),
      f('JavaScript.html', 'JS phía client nhúng bằng include(), gọi google.script.run', 'html', 'code'),
      f('.clasp.json.example', 'Mẫu cấu hình clasp (scriptId)', 'json', 'config')
    ],
    notes: [
      'Tất cả file .gs dùng CHUNG một global scope: không khai báo trùng tên hàm/hằng giữa các file.',
      'Hàm kết thúc bằng dấu gạch dưới (vd fn_) là private, không gọi được từ client.',
      'HtmlService: dùng include("Stylesheet") / include("JavaScript") trong Index.html.'
    ]
  },
  html: {
    id: 'html',
    name: 'HTML/CSS/JS SPA (ES Modules)',
    scope: 'module',
    runtime: 'Trình duyệt hiện đại',
    files: [
      f('index.html', 'Trang chính, nạp css/style.css và js/main.js (type=module)', 'html', 'markup'),
      f('css/style.css', 'Toàn bộ style', 'css', 'style'),
      f('js/config.js', 'Hằng số cấu hình (export const)', 'js'),
      f('js/api.js', 'Gọi API/fetch, lưu trữ (export function)', 'js'),
      f('js/state.js', 'Trạng thái ứng dụng + localStorage/IndexedDB', 'js'),
      f('js/ui.js', 'Render DOM, xử lý sự kiện', 'js'),
      f('js/main.js', 'Khởi động ứng dụng, nối các module', 'js'),
      f('data/seed.json', 'Dữ liệu mẫu chạy ngay', 'json', 'data')
    ],
    notes: ['Dùng ES Modules (import/export). Không dùng biến global.', 'DOM id trong index.html phải khớp với js/ui.js.']
  },
  react: {
    id: 'react',
    name: 'React / Next.js (App Router, TypeScript)',
    scope: 'module',
    runtime: 'Node.js 20 + Next.js',
    files: [
      f('package.json', 'Scripts dev/build/start/test, dependencies', 'json', 'config'),
      f('tsconfig.json', 'Cấu hình TypeScript', 'json', 'config'),
      f('next.config.mjs', 'Cấu hình Next.js', 'js', 'config'),
      f('.env.example', 'Biến môi trường mẫu (không chứa giá trị thật)', 'env', 'config'),
      f('app/layout.tsx', 'Root layout', 'tsx'),
      f('app/page.tsx', 'Trang chủ', 'tsx'),
      f('app/api/items/route.ts', 'Route handler API', 'ts'),
      f('components/AppShell.tsx', 'Khung giao diện dùng chung', 'tsx'),
      f('lib/types.ts', 'Kiểu dữ liệu theo dataSchema', 'ts'),
      f('lib/data.ts', 'Truy cập dữ liệu', 'ts'),
      f('tests/data.test.ts', 'Test đơn vị cho lib/data.ts', 'ts')
    ],
    notes: ['Server Component mặc định; thêm "use client" khi cần state/hook.', 'Kiểu dữ liệu đặt ở lib/types.ts, import từ đó.']
  },
  python: {
    id: 'python',
    name: 'Python / Flask',
    scope: 'module',
    runtime: 'Python 3.11',
    files: [
      f('requirements.txt', 'Thư viện cần cài', 'txt', 'config'),
      f('.env.example', 'Biến môi trường mẫu', 'env', 'config'),
      f('app/__init__.py', 'Application factory create_app()', 'py'),
      f('app/config.py', 'Cấu hình', 'py'),
      f('app/models.py', 'Model dữ liệu', 'py'),
      f('app/routes.py', 'Blueprint + route', 'py'),
      f('app/services.py', 'Nghiệp vụ', 'py'),
      f('app/templates/index.html', 'Template Jinja2', 'html', 'markup'),
      f('run.py', 'Điểm chạy', 'py'),
      f('tests/test_routes.py', 'Test pytest', 'py'),
      f('Dockerfile', 'Image chạy production', 'docker', 'config')
    ],
    notes: ['Dùng application factory.', 'Import tương đối trong package app.']
  },
  node: {
    id: 'node',
    name: 'Node.js / Express',
    scope: 'module',
    runtime: 'Node.js 20 (ES Modules)',
    files: [
      f('package.json', 'type=module, scripts start/test', 'json', 'config'),
      f('.env.example', 'Biến môi trường mẫu', 'env', 'config'),
      f('src/config.js', 'Đọc cấu hình từ env', 'js'),
      f('src/server.js', 'Khởi tạo Express, middleware, listen', 'js'),
      f('src/routes/index.js', 'Định nghĩa route', 'js'),
      f('src/controllers/items.js', 'Xử lý request', 'js'),
      f('src/models/store.js', 'Lưu trữ dữ liệu', 'js'),
      f('src/utils/validate.js', 'Kiểm tra đầu vào', 'js'),
      f('public/index.html', 'Giao diện tĩnh', 'html', 'markup'),
      f('tests/items.test.js', 'Test node --test', 'js')
    ],
    notes: ['ES Modules (import/export).', 'Không lộ secret ra client.']
  },
  flutter: {
    id: 'flutter',
    name: 'Flutter',
    scope: 'module',
    runtime: 'Flutter 3 / Dart 3',
    files: [
      f('pubspec.yaml', 'Khai báo package, dependencies', 'yaml', 'config'),
      f('lib/main.dart', 'Điểm vào, MaterialApp', 'dart'),
      f('lib/models/item.dart', 'Model dữ liệu', 'dart'),
      f('lib/services/api_service.dart', 'Gọi API / lưu trữ', 'dart'),
      f('lib/screens/home_screen.dart', 'Màn hình chính', 'dart'),
      f('lib/widgets/item_card.dart', 'Widget dùng lại', 'dart'),
      f('test/widget_test.dart', 'Widget test', 'dart'),
      f('analysis_options.yaml', 'Cấu hình lint', 'yaml', 'config')
    ],
    notes: ['Null safety.', 'Tách model/service/screen.']
  }
});

export const PLATFORM_IDS = Object.keys(PLATFORMS);

export function getPlatform(id) {
  return PLATFORMS[id] || PLATFORMS.gas;
}

/** Danh sách đường dẫn file cố định (có thể ghi đè từ dự án). */
export function filePaths(platformId, override = null) {
  if (Array.isArray(override) && override.length) return override.map((x) => (typeof x === 'string' ? x : x.path));
  return getPlatform(platformId).files.map((x) => x.path);
}

export function fileSpec(platformId, path) {
  return getPlatform(platformId).files.find((x) => x.path === path) || { path, role: '', lang: langOf(path), kind: 'code' };
}

/** Ngôn ngữ theo đuôi file. */
export function langOf(path) {
  const p = String(path).toLowerCase();
  if (p.endsWith('dockerfile')) return 'docker';
  if (p.endsWith('.env.example') || p.endsWith('.env')) return 'env';
  const ext = p.split('.').pop();
  const map = { js: 'js', mjs: 'js', cjs: 'js', gs: 'gs', ts: 'ts', tsx: 'tsx', jsx: 'jsx', json: 'json', html: 'html', htm: 'html', css: 'css', py: 'py', dart: 'dart', yaml: 'yaml', yml: 'yaml', md: 'md', txt: 'txt' };
  return map[ext] || ext || 'txt';
}

/** Mẫu ý tưởng (giữ 6 template của bản GAS/V3.2). */
export const IDEA_TEMPLATES = Object.freeze({
  crm: { name: 'CRM System', text: 'Hệ thống CRM thông minh với AI phân tích hành vi khách hàng, tự động phân loại lead theo tiềm năng, chatbot chăm sóc khách hàng 24/7 tích hợp Zalo OA & Messenger, dashboard realtime KPI, tự động gửi email follow-up và báo cáo hàng tuần.' },
  health: { name: 'Health Assistant', text: 'Ứng dụng Trợ lý Sức khỏe AI: chatbot tư vấn triệu chứng, phân tích ảnh món ăn tính calories, theo dõi chỉ số sức khỏe qua smartwatch, gợi ý bài tập và dinh dưỡng cá nhân hóa, cảnh báo sớm nguy cơ bệnh lý, đặt lịch khám online.' },
  ecom: { name: 'E-Commerce', text: 'Nền tảng E-Commerce với AI: gợi ý sản phẩm cá nhân hóa, chatbot hỗ trợ mua sắm, tìm kiếm bằng hình ảnh, dự đoán xu hướng và quản lý kho thông minh, phân tích sentiment đánh giá, tự động tạo mô tả sản phẩm SEO.' },
  saas: { name: 'SaaS Platform', text: 'Nền tảng SaaS đa tenant: quản lý người dùng & phân quyền, billing tự động, analytics dashboard, API gateway với rate limiting, webhook system, AI-powered insights cho từng tenant.' },
  learn: { name: 'E-Learning', text: 'Nền tảng E-Learning với AI: tạo khóa học tự động từ tài liệu, chatbot gia sư ảo, chấm điểm tự luận bằng AI, gợi ý lộ trình học cá nhân hóa, phân tích điểm mạnh/yếu học viên, video call với giáo viên.' },
  fin: { name: 'Fintech', text: 'Ứng dụng Fintech: quản lý tài chính cá nhân với AI phân tích chi tiêu, dự báo dòng tiền, gợi ý tiết kiệm & đầu tư, cảnh báo giao dịch bất thường, tích hợp Open Banking API, báo cáo thuế tự động.' }
});

/** Stub ban đầu cho mỗi file — trạng thái "draft", KHÔNG phải code thật. */
export function stubFor(platformId, path, projectName = 'AI Project') {
  const spec = fileSpec(platformId, path);
  const lang = spec.lang;
  const note = `${path} — ${spec.role || 'file dự án'} (BẢN NHÁP — chưa sinh code)`;
  if (lang === 'json') return JSON.stringify({ _draft: note }, null, 2) + '\n';
  if (lang === 'html') return `<!-- ${note} -->\n`;
  if (['py', 'yaml', 'txt', 'env', 'docker'].includes(lang)) return `# ${note}\n# Dự án: ${projectName}\n`;
  if (lang === 'css') return `/* ${note} */\n`;
  if (lang === 'md') return `<!-- ${note} -->\n`;
  return `// ${note}\n// Dự án: ${projectName}\n`;
}
