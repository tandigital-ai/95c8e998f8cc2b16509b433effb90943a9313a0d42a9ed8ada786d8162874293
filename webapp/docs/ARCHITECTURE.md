# ARCHITECTURE

```
Trình duyệt (public/)                         Proxy (server/index.js | worker/index.js)
┌───────────────────────────────┐   fetch     ┌───────────────────────────────┐
│ main.js (orchestrator UI)     │ ──/api/──▶  │ allowlist provider + op       │ ──▶ provider
│ features/* (màn hình)         │ ◀─SSE────── │ key: .env/secret | X-Provider │
│ core/* (logic thuần, test)    │             │ rate-limit, timeout, CSP      │
│ IndexedDB (dữ liệu dự án)     │             └───────────────────────────────┘
└───────────────────────────────┘
```

## Lớp

- **core/** — logic thuần, test được bằng Node: `db` (IndexedDB + bộ nhớ cùng API), `vault` (PBKDF2 600k + AES-GCM), `keyring`, `budget`, `sse`, `llmClient` (retry/backoff, đổi key, tự nối khi bị cắt, cache SHA-256, fallback có xác nhận), `parser`, `platforms` (nguồn duy nhất danh sách file), `contract` (schema v1 + validate), `syntaxCheck`/`consistency` (acorn), `pipeline` (máy trạng thái + checkpoint), `projectStore` (file/version bất biến), `exporter`, `diff`, `mermaidSanitize`, `prompts`.
- **features/** — mỗi màn hình một module: architect, diagram, contractBuilder, codeBuilder, review, seed, attachments, playground, history, costView, exportUi, providersPanel, vaultUi, settingsView, pipelineRunner, workspace, models.
- **ui/** — `h()` dựng DOM (cấm style inline), toast, modal, tabs, markdownView (marked + DOMPurify; là nơi DUY NHẤT dùng innerHTML), vendorLoader.

## Pipeline

`architecture → contract → build-files → checks → review → fix → seed → readme → save-version`

- Mỗi bước lưu checkpoint trong store `jobs`, kèm hash của đầu vào. Đầu vào không đổi ⇒ bỏ qua bước.
- Hủy dùng AbortController; Resume chạy tiếp từ bước dở; mỗi bước hoặc từng file đều chạy lại riêng được.
- Contract không hợp lệ ⇒ AI được sửa 1 lần; vẫn lỗi ⇒ **DỪNG**.
- `fix` chỉ tạo đề xuất kèm diff; người dùng bấm Accept mới ghi vào file.
- Tab đóng khi đang chạy ⇒ lần mở sau job được đánh dấu `interrupted`.

## Vòng đời file

`draft → generated → syntax-checked → consistency-checked → reviewed`; ngoài ra có `truncated`, `stale` (contract đổi), `failed`. Hàm `deriveState()` tính trạng thái từ dữ liệu thật của các lần kiểm tra.

## IndexedDB (v1)

settings, providers, vault, projects, versions (bất biến, có hash), files [projectId, path], jobs, logs, cache, usage.

## Bảo mật

- CSP trang chính: `script-src 'self'; style-src 'self'` (không `unsafe-inline`), `frame-ancestors 'none'`. Kèm `nosniff`, `no-referrer`; không bật CORS.
- `/preview-frame.html`: iframe sandbox `allow-scripts`, `connect-src 'none'` — để xem trước HTML do AI sinh.
- `/mermaid-frame.html`: iframe sandbox, chỉ nới `style-src 'unsafe-inline'` để Mermaid đo chữ. SVG được DOMPurify làm sạch rồi hiển thị qua `<img src=blob:>`.
- Key không bao giờ ghi vào localStorage/log; bản sao lưu JSON mặc định không gồm vault.
- Service worker không bao giờ cache `/api/*`.
