# PROGRESS

> Nếu phiên bị ngắt: đọc file này + PLAN.md + ASSUMPTIONS.md + LIMITATIONS.md, rồi làm tiếp từ giai đoạn đang dở.

| Giai đoạn | Trạng thái | Bằng chứng |
|---|---|---|
| G0 Kế hoạch | XONG | docs/PLAN.md, docs/ASSUMPTIONS.md |
| G1 Nền móng | XONG | server/*, core/db, vault, keyring, budget, llmClient + tests (proxy, vault-keyring, budget-db, llmClient) |
| G2 Orchestrator | XONG | parser, architect, diagram (iframe sandbox), playground, platforms; smoke e2e 0 lỗi |
| G3 Pipeline | XONG | core/pipeline + pipelineRunner; tests/e2e/pipeline.py chạy đủ 9 bước với LLM giả lập |
| G4 Lịch sử/Chi phí/Export | XONG | projectStore (test restore byte-exact), exporter (ZIP thật), e2e xuất ZIP + manifest |
| G5 Hardening + docs | XONG (phần chính) | CSP không 'unsafe-inline' (e2e bắt securitypolicyviolation = 0), README/ARCHITECTURE/CHANGELOG/TESTING/LIMITATIONS, VENDOR.md |
| G6 Docker/Worker/PWA | XONG — CHƯA CHẠY THỬ Docker/Worker | Dockerfile, worker/index.js + wrangler.toml, manifest.webmanifest + sw.js |

## Đã sửa trong phiên cuối
- history.js lỗi cú pháp; server không listen dưới PM2 (isMain); Mermaid vi phạm CSP ⇒ render trong iframe; nhãn Mermaid mất chữ (htmlLabels cấp gốc); tự bật provider có key server; lưu ý tưởng trước khi chạy pipeline; bỏ DOMParser trong checkHtml (CSP).

## Còn lại (không chặn sử dụng)
- Chưa deploy thử Worker/Docker thật. Chưa kiểm tra a11y bằng công cụ chuyên dụng.
