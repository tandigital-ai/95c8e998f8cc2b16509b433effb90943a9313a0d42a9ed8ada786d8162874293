# AI System Architect — bản web cá nhân

Chuyển đổi từ Google Apps Script (GAS) + bản V3.2 sang **HTML/CSS/JS ES Modules (không framework, không build)** + **proxy Node.js 0 dependency**. Dùng cho **một người dùng cá nhân**.

Từ một ý tưởng, app sinh ra: kiến trúc (Claude.md + 3–7 skill bot, luôn có Data Seeder & QA Bot) → sơ đồ Mermaid → **contract JSON** (nguồn sự thật duy nhất) → code từng file theo nền tảng → kiểm tra cú pháp/nhất quán → AI review + đề xuất sửa (có diff, bấm Accept mới áp dụng) → dữ liệu mẫu → README → lưu version → xuất ZIP kèm manifest SHA-256.

> ⚠ Đọc trước: [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Tóm tắt: **không chạy nền** (đóng tab là dừng, chỉ có Resume thủ công); **ngân sách chỉ là cảnh báo**; **code sinh ra KHÔNG được build/chạy thử**.

## Chạy nhanh (máy cá nhân)

Yêu cầu: Node.js ≥ 20.12.

```bash
cp server/.env.example server/.env   # điền KEY_GEMINI=..., KEY_DEEPSEEK=... (tùy chọn)
npm start                            # http://127.0.0.1:3000
```

Không muốn để key trong `.env`? Mở app → **Vault** → tạo mật khẩu → thêm key cho từng provider (mã hóa AES-GCM trong trình duyệt).

Cách dùng:

1. Thêm key → bấm **Bật** provider → **Tải models**.
2. Chọn **Model Orchestrator**.
3. Nhập ý tưởng → **🚀 Chạy pipeline đầy đủ**, hoặc chỉ **⚡ Tạo kiến trúc**.
4. Xem từng file trong tab Workspace (nhãn trạng thái: bản nháp → đã sinh → đã kiểm cú pháp → đã kiểm nhất quán → đã AI review; **BỊ CẮT** nếu AI trả thiếu).
5. **Export** ZIP / ghi thẳng vào thư mục; **Cài đặt → Sao lưu** JSON (không chứa key).

## Các cách triển khai

| Cách | Lệnh |
|---|---|
| Node (khuyên dùng) | `npm start` (mặc định chỉ nghe 127.0.0.1) |
| Mở ra mạng LAN | `HOST=0.0.0.0 ACCESS_TOKEN=chuoi-dai npm start` (thiếu token ⇒ proxy từ chối chạy) |
| Docker | `docker build -t ai-architect . && docker run -p 3000:3000 --env-file server/.env -e ACCESS_TOKEN=... ai-architect` |
| Cloudflare Worker | `npx wrangler secret put ACCESS_TOKEN` (và `KEY_*`) trong `worker/`, rồi `npm run worker:deploy` |
| PM2 (sandbox) | `pm2 start ecosystem.config.cjs` |

## API của proxy

- `GET /api/health`: phiên bản, giới hạn, danh sách provider (không lộ URL/key).
- `GET /api/llm/:provider/models`
- `POST /api/llm/:provider/chat`: body OpenAI-compatible; `stream:true` ⇒ chuyển tiếp SSE nguyên vẹn.
- Header tùy chọn: `X-Provider-Key` (key từ trình duyệt, không lưu/không log), `X-Access-Token`.
- Lỗi luôn có dạng `{error:{status,message,provider}}`.
- Provider hỗ trợ: gemini, openrouter, mistral, deepseek, nvidia, grok. Client không gửi được URL tùy ý (chỉ cho phép đúng danh sách allowlist).

## Kiểm thử

- `npm test`: unit test bằng `node --test` (proxy, vault, keyring, budget, db, llmClient, parser, contract, syntax/consistency, pipeline, exporter + ZIP thật, projectStore).
- `npm run e2e`: Playwright (Python) — smoke UI + pipeline đầy đủ với LLM giả lập (cần `pip install playwright && python3 -m playwright install chromium`, server đang chạy).
- Checklist thủ công: [docs/TESTING.md](docs/TESTING.md).

## Tài liệu

[ARCHITECTURE](docs/ARCHITECTURE.md) · [LIMITATIONS](docs/LIMITATIONS.md) · [CHANGELOG](docs/CHANGELOG.md) · [TESTING](docs/TESTING.md) · [ASSUMPTIONS](docs/ASSUMPTIONS.md) · [PLAN](docs/PLAN.md) · [PROGRESS](docs/PROGRESS.md) · [VENDOR](public/vendor/VENDOR.md)
