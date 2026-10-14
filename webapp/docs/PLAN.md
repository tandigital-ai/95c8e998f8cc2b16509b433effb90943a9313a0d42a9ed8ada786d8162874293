# PLAN — Bảng ánh xạ GAS + V3.2 → kiến trúc mới

Nguồn đã đọc đầy đủ: `ApiProxy.gs`, `appsscript.json`, `Code.gs`, `Config.gs`, `HistoryService.gs`,
`Index.html` (1315 dòng), `KeyVault.gs`, `Orchestrator.gs` (583 dòng), `_AI SYSTEM ARCHITECT V3.2-Update.html` (1530 dòng).
Không có đoạn nào không đọc được. Nhãn phiên bản lẫn lộn (V3.1/4.x/5.2/6.0) — lấy code làm sự thật.

## 1. Bảng ánh xạ

| # | Tính năng | Nguồn | Module đích | Thay đổi | Rủi ro |
|---|---|---|---|---|---|
| 1 | callAI (gọi chung) | ApiProxy.gs `callAI`, V3.2 `callAI` | core/llmClient.js `complete/chat/stream` | Stream SSE thật qua proxy, Hủy, trả usage/cost/finish | Mỗi provider SSE hơi khác |
| 2 | Cache khớp tuyệt đối | `_cacheKeyFor` (MD5, CacheService 6h, ~100KB) | llmClient.js + store `cache` | SHA-256, TTL cấu hình, chỉ cache khi `stop`, nút xóa | Khóa lớn khi có ảnh |
| 3 | Retry + backoff | `_attemptProvider` | llmClient.js `attemptProvider`, `backoffDelay` | Jitter, Retry-After, không retry khi đã phát nội dung | — |
| 4 | Fallback chain | `_autoFallbackChain` | llmClient.js | Mặc định TẮT; chain khai báo provider:model; xác nhận; log | Lộ dữ liệu sang provider khác |
| 5 | Budget guard | `_isBudgetExceeded` | core/budget.js `guard` | Cảnh báo mềm + xác nhận; lưu IndexedDB | Không chặn cứng (đã chốt) |
| 6 | Tính chi phí | `_estimateCost` (bịa $0.5/$1.5) | budget.js `lookupPrice/computeCost` | Không giá ⇒ null "không rõ giá"; giá OpenRouter động | — |
| 7 | Key rotation + cooldown | KeyVault.gs `_getNextKey/_markCooldown`, V3.2 `getNextKey` | server/index.js `createServerKeyPool` + core/keyring.js | Theo mức dùng, 65s khi 429, 10' khi 401 | Cooldown mất khi restart |
| 8 | Lưu/xóa key | `saveProviderKeys/clearProviderKeys`, V3.2 `saveVault` | core/vault.js + keyring.js | Salt ngẫu nhiên, 600k vòng, RAM-only, auto-lock | Quên mật khẩu = mất key |
| 9 | ping / fetchModels | `pingProvider/fetchModels` | server `/api/llm/:p/models` + llmClient `ping/loadModels` | Mọi provider qua proxy (hết CORS) | — |
| 10 | generateArchitecture + auto-continue | Orchestrator.gs | features/architect.js + llmClient auto-continue | Stream, Hủy, nối gửi toàn bộ phần đã sinh, TRUNCATED | Model lặp khi nối |
| 11 | generateDiagram | Orchestrator.gs + V3.2 `generateDiagram/buildDiagramSystem` | features/diagram.js | Prompt V3.2 (≤18 node, ≤25 edge), sanitize, strict, editor, SVG/PNG | Cú pháp Mermaid |
| 12 | sanitizeMermaid | V3.2 | features/diagram.js `sanitizeMermaid` (thuần, test) | Viết lại sạch (bản cũ có code trùng/chết) | — |
| 13 | parseContent | Orchestrator `_parseContent`, V3.2 | core/parser.js | Trả warnings, chịu fence, phát hiện bị cắt | Regex |
| 14 | Stub code | `_generateStubCode` | core/platforms.js | Preset tập trung, cấu trúc thư mục thật | — |
| 15 | buildProjectContract | Orchestrator.gs | features/contractBuilder.js + core/contract.js | Validator schema; lỗi ⇒ dừng | Model yếu sinh JSON hỏng |
| 16 | buildCodeFile | Orchestrator.gs | features/codeBuilder.js | Từng file, API surface, không cắt im lặng | Ngữ cảnh dài |
| 17 | _stampAuthor | Orchestrator.gs | core/exporter.js `applyBanner` | Tùy chọn, mặc định TẮT, chỉ lúc export | — |
| 18 | validateProjectConsistency | Orchestrator.gs | core/consistency.js | AST acorn, hàm gọi chưa định nghĩa, hằng trùng GAS, DOM, field | Ngôn ngữ ngoài JS: heuristic |
| 19 | Kiểm tra cú pháp (mới) | — | core/syntaxCheck.js | acorn/JSON/DOMParser; khác ⇒ "chưa kiểm tra" | — |
| 20 | buildReadme | Orchestrator.gs | features/codeBuilder.js `buildReadme` | TRUNCATED | — |
| 21 | aiReviewProject | Orchestrator.gs | features/review.js | JSON lỗi ⇒ cảnh báo, không "0 lỗi" | Dự án lớn |
| 22 | aiFixFile | Orchestrator.gs | features/review.js | Diff + Chấp nhận, chạy lại checks | — |
| 23 | buildSeedData | Orchestrator.gs | features/seed.js | Kiểm entity/field, JSON/CSV | — |
| 24 | analyzeAttachments | Orchestrator.gs + Index.html `tdaReadFile` | features/attachments.js | Ảnh thu nhỏ, PDF, DOCX, text, báo cắt | — |
| 25 | testSkill (Playground) | Orchestrator.gs, V3.2 | features/playground.js | Model riêng, stream | — |
| 26 | History / versioning | HistoryService.gs, V3.2 `saveToHistory` | features/history.js + store `versions/projects/files` | Version bất biến, đủ nội dung, băm, diff, ghim | — |
| 27 | Logs | `_logRequest` | core/logger.js + store `logs` | Mọi lỗi có ngữ cảnh, che bí mật | — |
| 28 | Cost view | V3.2 `openCostDetail`, Index `updateBudget` | features/costView.js | Ngày/dự án/provider/model/bước, CSV | — |
| 29 | Export ZIP | Index `exportAll`, V3.2 | core/exporter.js | manifest SHA-256 + trạng thái thật, FS Access API | — |
| 30 | Tải Contract .json | Index `downloadContract` | core/exporter.js | — | — |
| 31 | Theme dark/light | Index/V3.2 `toggleTheme` | main.js + css/tokens.css | — | — |
| 32 | Platform templates | Config.gs, V3.2 | core/platforms.js | — | — |
| 33 | Template ý tưởng (6) | Index/V3.2 `loadTemplate` | features/architect.js | — | — |
| 34 | Workflow modal | Index `openWorkflow` | features/diagram.js `workflowDiagram` | — | — |
| 35 | Copy / Download tab | Index/V3.2 | ui/components.js | — | — |
| 36 | Ảnh UI mẫu (vision) | Index `loadRefImages` | features/attachments.js | Thu nhỏ, gửi kèm cả khi nối | Model không vision |
| 37 | Tệp tham chiếu (refFiles) | Orchestrator (UI chết ở GAS) | features/attachments.js | Khôi phục UI | — |
| 38 | Build lại 1 file / README | Index `rebuildFile/rebuildReadme` | core/pipeline.js `retryFile` | — | — |
| 39 | autoFixAll (trùng hàm) | Index | features/review.js | Dựa trên issue có cấu trúc | — |
| 40 | Phím tắt Ctrl+Enter, Esc, Ctrl+S | Index/V3.2 | main.js | — | — |
| 41 | Model tags gợi ý (recModels) | V3.2 | BỎ (xem CHANGELOG) | Tên model không xác minh được | — |
| 42 | Reset | Index/V3.2 | main.js | — | — |
| 43 | Streaming checkbox | V3.2 | Settings `streamByDefault` + toggle | — | — |
| 44 | Test All / Refresh all models | Index/V3.2 | features/providers UI (main.js) | — | — |

## 2. Lỗi/rủi ro phát hiện thêm trong code gốc
- B1 GAS: `restoreHist(${rowId})` với rowId chuỗi `PRJ_…` không có nháy ⇒ ReferenceError; khôi phục/xóa lịch sử luôn hỏng.
- B2: tách `provider:model` bằng `split(':')` ⇒ model chứa `:` (OpenRouter `:free`) bị cắt.
- B3: `tdaPickFiles`/`#tdaFileChips` không có UI ⇒ refFiles chết.
- B4: `#anFiles` có 2 handler (onchange + listener toàn cục reset `AN_ATT`) ⇒ đọc trùng, PDF đọc như text.
- B5: có ảnh mẫu thì dùng `usrMsg` thay `usrMsgPlus` ⇒ mất refFiles; vòng nối mất ảnh và tệp.
- B6: vòng nối chỉ gửi chunk cuối ⇒ từ vòng 3 mất ngữ cảnh.
- B7: hết vòng vẫn `length` ⇒ trả như thành công.
- B8: token/cost chỉ tính vòng cuối; fallback tính giá provider gốc.
- B9: fallback dùng `defModel` đoán; `max_tokens:16000` có thể vượt giới hạn model.
- B10: `aiFixFile` đóng dấu lần 2 ⇒ 2 banner.
- B11: banner `/* */` chèn vào `requirements.txt`, trước shebang.
- B12: stub GAS gọi `"UI"` nhưng file là `Index.html`; stub HTML trỏ `css/`,`js/` sai; `appsscript.json` stub `ANYONE_ANONYMOUS`.
- B13: consistency quét cả README; chỉ bắt `function x(`; ES module trùng tên bị coi lỗi.
- B14: review parse lỗi ⇒ `issues:[]` ⇒ UI "không lỗi".
- B15: `onbeforeunload` không gỡ sau build.
- B16: tiến trình giả (timer 4s).
- B17: CacheService ~100KB/giá trị ⇒ không cache, lỗi bị nuốt.
- B18: `updateHistory` ghi đè, không cập nhật token/cost.
- S1: GAS chỉ coi hàm có `_` **cuối** là private ⇒ `_getKeys` gọi được từ client.
- S2: tên model/tên tệp chèn innerHTML không escape (V3.2 có escape tên model, GAS không).
- S3: `XFrameOptionsMode.ALLOWALL`.
- S4: CDN `mermaid@10` không ghim + không SRI.
- V1 (V3.2): `sanitizeMermaid` có khối `const out=merged.map` lồng nhau + code chết sau `return` ⇒ thực chất lỗi cú pháp nếu không nhờ hoisting may mắn; Mermaid `securityLevel:'loose'`.
- V2 (V3.2): `loadVault` giải mã thất bại vẫn nạp ciphertext làm key ("heuristic plaintext").
- V3 (V3.2): `getNextKey` tự cooldown khi 20 request/phút dù không có 429 (giới hạn tùy ý).
- V4 (V3.2): stream lỗi ⇒ âm thầm gọi lại non-stream (tốn tiền 2 lần), `catch(e){}` rỗng trong parse SSE.
- V5 (V3.2): key hiển thị trong `<input value=...>` (double-click xem) ⇒ key nằm trong DOM.
- V6 (V3.2): `estimateCost` trả 0 khi không rõ giá ⇒ hiển thị $0 sai.

## 3. Mô hình dữ liệu IndexedDB (`ai-architect` v1)
| Store | keyPath | Index |
|---|---|---|
| settings | key | — |
| providers | providerId | — (danh sách model + giá động) |
| vault | id | — |
| projects | id | updatedAt |
| versions (bất biến) | id | projectId, [projectId, createdAt] |
| files (bản làm việc) | [projectId, path] | projectId, state |
| jobs (checkpoint pipeline) | id | projectId, status, updatedAt |
| logs | id (auto) | ts, kind, level, projectId |
| cache | hash | expiresAt |
| usage | id (`day:YYYY-MM-DD` / `project:<id>`) | date, projectId |

## 4. Máy trạng thái pipeline
```
architecture → contract ─(schema lỗi)→ FAILED (dừng, cho sửa tay/sinh lại)
            → build-files (mỗi file: pending|running|done|failed|skipped|truncated)
            → checks (syntax + consistency) → review → fix (chờ Chấp nhận diff) → seed → readme → save-version
Mỗi bước: pending|running|done|failed|skipped|truncated. Checkpoint vào `jobs` sau mỗi bước/file.
Hủy ⇒ bước đang chạy về pending (job.status=paused). Tải lại trang khi running ⇒ interrupted ⇒ Resume thủ công.
Kết quả bước khóa bởi hash(đầu vào) ⇒ retry không gọi lại AI nếu đầu vào không đổi.
```
