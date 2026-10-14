"""E2E pipeline với LLM GIẢ LẬP (Playwright chặn /api/llm/*). Kiểm tra luồng UI thật:
kiến trúc → contract → build từng file → checks → review → seed → readme → version, + export ZIP.
Không gọi AI thật. Chạy: python3 tests/e2e/pipeline.py [base_url]"""
import sys, json, re, os, zipfile, io
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
errors, calls = [], []

ARCH = """===CLAUDE_MD_START===
# Quản lý công việc
Ứng dụng GAS quản lý Task (tiêu đề, trạng thái).
===CLAUDE_MD_END===
===DIAGRAM_START===
flowchart TD
  A[Người dùng] --> B[Orchestrator]
  B --> C[Task Bot]
===DIAGRAM_END===
===SKILL_START:skill-01:Task Bot===
Quản lý task.
===SKILL_END===
===SKILL_START:skill-02:Report Bot===
Báo cáo.
===SKILL_END===
===SKILL_START:skill-03:Data Seeder & QA Bot===
Sinh dữ liệu mẫu và kiểm thử.
===SKILL_END==="""

FILES = ['appsscript.json', 'Config.gs', 'Code.gs', 'Models.gs', 'Handlers.gs', 'Utils.gs', 'Index.html', 'Stylesheet.html', 'JavaScript.html', '.clasp.json.example']
CONTRACT = {
  "schemaVersion": 1, "projectName": "Quản lý công việc",
  "namingConventions": {"functions": "camelCase", "constants": "UPPER_SNAKE", "variables": "camelCase", "domIds": "kebab-case", "tables": "PascalCase"},
  "dataSchema": [{"entity": "Task", "store": "Tasks", "fields": [{"name": "id", "type": "id", "required": True, "desc": "mã"}, {"name": "title", "type": "string", "required": True, "desc": "tiêu đề"}, {"name": "status", "type": "enum", "required": True, "desc": "trạng thái"}]}],
  "functions": [
    {"name": "doGet", "file": "Code.gs", "params": ["e:object"], "returns": "HtmlOutput", "desc": "entry"},
    {"name": "include", "file": "Code.gs", "params": ["name:string"], "returns": "string", "desc": "include"},
    {"name": "listTasks", "file": "Handlers.gs", "params": [], "returns": "array", "desc": "list"},
    {"name": "readTasks_", "file": "Models.gs", "params": [], "returns": "array", "desc": "read"},
    {"name": "fmt", "file": "Utils.gs", "params": ["s:string"], "returns": "string", "desc": "fmt"},
    {"name": "renderTasks", "file": "JavaScript.html", "params": ["rows:array"], "returns": "void", "desc": "ui"}
  ],
  "globalConstants": [{"name": "SHEET_TASKS", "file": "Config.gs", "value": "Tasks", "desc": "tên sheet"}],
  "domElements": [{"id": "task-list", "type": "ul", "file": "Index.html", "usedBy": ["JavaScript.html"], "desc": "danh sách"}],
  "dependencies": "Handlers gọi Models/Utils; JavaScript.html gọi listTasks",
  "fileResponsibilities": [{"file": f, "role": "x", "exposes": [], "imports": []} for f in FILES]
}
CODE = {
  'appsscript.json': '{"timeZone":"Asia/Ho_Chi_Minh","runtimeVersion":"V8","webapp":{"access":"MYSELF","executeAs":"USER_DEPLOYING"}}',
  'Config.gs': "const SHEET_TASKS = 'Tasks';",
  'Code.gs': "function doGet(e) { return HtmlService.createTemplateFromFile('Index').evaluate(); }\nfunction include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }",
  'Models.gs': "function readTasks_() { return SpreadsheetApp.getActive().getSheetByName(SHEET_TASKS).getDataRange().getValues(); }",
  'Handlers.gs': "function listTasks() { return readTasks_().map(function (r) { return { id: r[0], title: fmt(r[1]), status: r[2] }; }); }",
  'Utils.gs': "function fmt(s) { return String(s).trim(); }",
  'Index.html': "<!DOCTYPE html><html><head><?!= include('Stylesheet'); ?></head><body><ul id=\"task-list\"></ul><?!= include('JavaScript'); ?></body></html>",
  'Stylesheet.html': "<style>#task-list{padding:0}</style>",
  'JavaScript.html': "<script>function renderTasks(rows){var el=document.getElementById('task-list');el.textContent='';rows.forEach(function(r){var li=document.createElement('li');li.textContent=r.title;el.appendChild(li);});}\ngoogle.script.run.withSuccessHandler(renderTasks).listTasks();</script>",
  '.clasp.json.example': '{"scriptId":"YOUR_SCRIPT_ID","rootDir":"."}'
}
SEED = {"seed": {"Task": [{"id": "T1", "title": "Viết báo cáo", "status": "open"}, {"id": "T2", "title": "Họp", "status": "done"}]}, "note": "Dán vào sheet Tasks"}

def answer(body):
    msgs = body.get('messages', [])
    sysmsg = next((m['content'] for m in msgs if m['role'] == 'system'), '')
    user = msgs[-1]['content'] if msgs else ''
    if isinstance(user, list): user = ' '.join(p.get('text', '') for p in user if isinstance(p, dict))
    if isinstance(sysmsg, list): sysmsg = ''
    if 'LEAD SOFTWARE ARCHITECT' in sysmsg: return 'contract', json.dumps(CONTRACT, ensure_ascii=False)
    if 'master' in sysmsg and 'engineer' in sysmsg:
        m = re.search(r'FILE TO IMPLEMENT: (\S+)', user)
        return 'code:' + (m.group(1) if m else '?'), CODE.get(m.group(1) if m else '', '// ?')
    if 'STRICT senior code reviewer' in sysmsg: return 'review', '{"issues":[]}'
    if 'surgical code fixer' in sysmsg: return 'fix', '// fixed'
    if 'DATA SEEDER' in sysmsg: return 'seed', json.dumps(SEED, ensure_ascii=False)
    if 'technical writer' in sysmsg: return 'readme', '# Quản lý công việc\n\nHướng dẫn: cần tự kiểm tra trên GAS.'
    if 'senior Solution Architect' in sysmsg: return 'diagram', '===DIAGRAM_START===\nflowchart TD\n A[X] --> B[Y]\n===DIAGRAM_END==='
    return 'architecture', ARCH

def sse(text):
    chunks = [text[i:i + 400] for i in range(0, len(text), 400)] or ['']
    out = ''
    for c in chunks:
        out += 'data: ' + json.dumps({"choices": [{"delta": {"content": c}, "finish_reason": None}]}, ensure_ascii=False) + '\n\n'
    out += 'data: ' + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 50}}) + '\n\n'
    return out + 'data: [DONE]\n\n'

def handle(route, request):
    url = request.url
    if url.endswith('/api/health'):
        r = route.fetch(); data = r.json()
        for p in data['providers']:
            if p['id'] == 'deepseek': p['serverKeyCount'] = 1
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data)); return
    if '/api/llm/deepseek/models' in url:
        route.fulfill(status=200, content_type='application/json', body=json.dumps({"data": [{"id": "deepseek-chat"}]})); return
    if '/api/llm/deepseek/chat' in url:
        body = json.loads(request.post_data or '{}')
        kind, text = answer(body); calls.append(kind)
        if body.get('stream'):
            route.fulfill(status=200, headers={'Content-Type': 'text/event-stream', 'X-Key-Source': 'server'}, body=sse(text))
        else:
            route.fulfill(status=200, content_type='application/json', headers={'X-Key-Source': 'server'}, body=json.dumps({"choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, ensure_ascii=False))
        return
    route.continue_()

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f'[console.{m.type}] {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'[pageerror] {e}'))
    page.add_init_script("""window.__v=[];document.addEventListener('securitypolicyviolation',e=>window.__v.push(e.violatedDirective+' '+e.sourceFile+':'+e.lineNumber+' '+(e.sample||'').slice(0,60)+' @'+(e.target&&e.target.nodeName)));""")
    page.route('**/api/**', handle)
    page.goto(BASE + '/', wait_until='networkidle'); page.wait_for_timeout(1200)
    # bật deepseek + chọn model
    page.click('#btn-models-all'); page.wait_for_timeout(1200)
    opts = page.eval_on_selector('#role-architect', 'el => [...el.options].map(o => o.value)')
    if 'deepseek:deepseek-chat' not in opts:
        errors.append('[setup] không có deepseek:deepseek-chat trong ô model: ' + str(opts[:6]))
    else:
        page.select_option('#role-architect', 'deepseek:deepseek-chat')
    page.fill('#idea-input', 'Ứng dụng quản lý công việc nhóm nhỏ trên Google Sheets')
    page.wait_for_timeout(300)
    page.click('text=🚀 Chạy pipeline đầy đủ')
    # chờ hộp xác nhận ước tính chi phí (nếu có)
    for _ in range(120):
        page.wait_for_timeout(500)
        btn = page.query_selector('.modal [data-ok], .modal .btn-pri:has-text("Chạy"), .modal button:has-text("Tiếp tục"), .modal button:has-text("Đồng ý")')
        if btn and btn.is_visible():
            btn.click(); continue
        badge = page.inner_text('#pipeline-panel .badge') if page.query_selector('#pipeline-panel .badge') else ''
        if any(k in badge for k in ['Kết thúc', 'Xong', 'Lỗi', 'Dừng', 'vấn đề', 'Tạm dừng', 'Gián đoạn']): break
    page.wait_for_timeout(800)
    page.screenshot(path='/tmp/shots/pipeline-done.png', full_page=True)
    badge = page.inner_text('#pipeline-panel .badge')
    steps = page.eval_on_selector_all('#pipeline-panel .step', 'els => els.map(e => e.className + " | " + e.innerText.replace(/\\n/g," "))')
    states = page.eval_on_selector_all('#pipeline-panel .file-item', 'els => els.map(e => e.innerText.replace(/\\n/g," "))')
    print('BADGE:', badge); print('STEPS:'); [print('  ', s) for s in steps]; print('FILES:'); [print('  ', s) for s in states]
    print('CALLS:', calls)
    # export ZIP
    page.click('#btn-export'); page.wait_for_timeout(800)
    page.screenshot(path='/tmp/shots/export.png')
    zbtn = page.query_selector('.modal button:has-text("ZIP")')
    if zbtn:
        with page.expect_download(timeout=15000) as dl:
            zbtn.click()
        path = dl.value.path(); z = zipfile.ZipFile(path)
        names = z.namelist(); print('ZIP entries:', len(names)); print('  ', names[:30])
        man = [n for n in names if n.endswith('manifest.json')]
        if man:
            m = json.loads(z.read(man[0])); print('manifest.summary:', m.get('summary'))
    else:
        errors.append('[export] không thấy nút ZIP')
    v = page.evaluate('window.__v')
    if v: errors.append('[csp] ' + ' || '.join(v))
    b.close()

print(json.dumps(errors, ensure_ascii=False, indent=1)); print('ERRORS:', len(errors))
