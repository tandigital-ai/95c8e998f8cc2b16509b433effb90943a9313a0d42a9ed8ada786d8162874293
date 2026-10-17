# CHANGELOG

## 0.1.0 — chuyển đổi GAS + V3.2 → web cá nhân

### GIỮ
- 6 provider (Gemini, OpenRouter, Mistral, DeepSeek, NVIDIA, Grok); marker `===CLAUDE_MD_START===`…; skill bot (3–7); sơ đồ Mermaid; mẫu ý tưởng; phân tích ảnh/tệp; Playground; lịch sử dự án; xuất ZIP; cache 6 giờ; nhiều key cho mỗi provider, xoay vòng.

### NÂNG CẤP
- Gọi AI: stream SSE thật + nút Hủy; tự nối khi bị cắt (tối đa N vòng, vẫn cắt ⇒ nhãn **TRUNCATED**); retry có jitter; đổi key khi gặp 429; usage/chi phí thật, không rõ giá thì ghi "không rõ giá", token ước lượng thì ghi "ước lượng".
- Key: KeyVault của GAS (PropertiesService) → vault AES-GCM trong trình duyệt và/hoặc `.env` trên proxy.
- Sinh code: dùng contract JSON có schema + validate (chặn khi sai); kiểm tra cú pháp bằng acorn; kiểm tra nhất quán giữa các file (GAS chung global scope, `google.script.run`, hàm private `_`, DOM id, field).
- Review: đề xuất sửa kèm diff, phải bấm Accept (GAS cũ ghi đè luôn).
- Lịch sử: version bất biến có hash; diff, khôi phục (kiểm tra hash), nhân bản, ghim, đổi tên, giới hạn số version.
- Sơ đồ: làm sạch + giới hạn 18 node/25 cạnh/6 từ; editor sửa tay; xuất SVG/PNG.
- Sửa lỗi GAS: cắt sai tên model `x/y:free` (giờ tách ở dấu `:` đầu tiên), cache cả kết quả bị cắt, lưu nội dung bị cắt ngắn…

### THÊM MỚI
- Pipeline có checkpoint, Resume, chạy lại từng bước/từng file; ước tính chi phí trước khi chạy; ngân sách ngày/dự án (cảnh báo).
- Bảng chi phí + Logs + xuất CSV; manifest xuất có SHA-256 và `runtimeTested:false`; ghi thẳng vào thư mục (File System Access); sao lưu/khôi phục JSON.
- PWA (cache tĩnh), Dockerfile, Cloudflare Worker; CSP chặt.

### BỎ
- Tag "model khuyên dùng" (recModels) của V3.2: tên model không xác minh được; nay lấy danh sách động từ API, tên dự phòng ghi "chưa xác minh".
- Chèn banner tác giả tự động: giờ là tùy chọn, mặc định TẮT.
