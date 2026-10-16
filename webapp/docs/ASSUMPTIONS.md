# ASSUMPTIONS — Các giả định đã chọn (người dùng ủy quyền chọn phương án tốt nhất)

1. **Node >= 20.12**, proxy **0 dependency** (node:http + fetch sẵn có, `process.loadEnvFile`). Môi trường build: Node 22.
2. Proxy mặc định nghe **127.0.0.1:3000**. `HOST` khác loopback mà thiếu `ACCESS_TOKEN` ⇒ **từ chối khởi động** (trừ khi `ALLOW_INSECURE_PUBLIC=1`).
3. Chế độ key theo từng provider: `auto` (mặc định: key trình duyệt nếu vault mở và có key, nếu không dùng key server), `server`, `client`.
4. **Fallback mặc định TẮT**; khi bật phải khai báo `provider:model` cụ thể; trước khi gửi sang provider khác app hỏi xác nhận.
5. **Cache mặc định BẬT**, TTL 6 giờ (giống GAS). Chỉ cache kết quả `finish_reason=stop`, không fallback.
6. Ngân sách mặc định **$5/ngày**, **$2/dự án**; hỏi xác nhận 1 lần/phạm vi/phiên (`once`).
7. Vault tự khóa **15 phút** không thao tác. Mật khẩu tối thiểu 8 ký tự. PBKDF2 600.000 vòng.
8. `max_tokens` mặc định **8192** (sửa được); tối đa **4 vòng** nối.
9. `stream_options.include_usage`: bật cho gemini/openrouter/deepseek/grok, tắt cho mistral/nvidia — **chưa xác minh**; nếu provider báo lỗi 400 về trường này, client tự thử lại không dùng và ghi cảnh báo.
10. Gemini dùng endpoint OpenAI-compatible `https://generativelanguage.googleapis.com/v1beta/openai` với Bearer key (theo tài liệu công khai của Google). `/models` của endpoint này trả dạng `{data:[{id:"models/..."}]}` ⇒ bỏ tiền tố `models/`.
11. Model gợi ý trong providers.js đều gắn nhãn **"chưa xác minh"**. Grok không có gợi ý.
12. Sao lưu JSON **không kèm khóa API** theo yêu cầu GĐ1 mới ⇒ mặc định loại store `vault` (có tùy chọn "kèm vault đã mã hóa" cho người muốn chuyển máy, mặc định tắt) và loại `cache`.
13. Contract: tự viết validator nhỏ (không vendor thư viện JSON Schema) để giữ ít phụ thuộc.
14. Xem trước HTML sinh ra: iframe `sandbox="allow-scripts"` (không `allow-same-origin`) dùng `srcdoc`; vì iframe srcdoc kế thừa CSP của trang cha, script inline trong bản xem trước sẽ bị chặn — chấp nhận, ghi trong LIMITATIONS.
15. Footer TDA/Zalo của bản GAS **không** đưa vào giao diện (đó là thông tin tác giả bản cũ); thông tin tác giả chỉ có ở banner tùy chọn trong Cài đặt (mặc định tắt).
16. Thư viện vendor tải từ npm registry (có mạng): jszip 3.10.1, file-saver 2.0.5, mermaid 12.1.0, marked 18.1.0, dompurify 3.4.16, acorn 8.19.0, pdfjs-dist 6.4.299, mammoth 1.13.0.
17. Mermaid 12 dùng `securityLevel:'strict'` vẫn cần `style-src 'unsafe-inline'` cho SVG; CSP giữ `script-src 'self'` tuyệt đối, `style-src` có `'unsafe-inline'` (giới hạn đã ghi).
18. Dự án dùng tên thư mục `webapp/` (yêu cầu môi trường) thay cho `ai-architect/`; cấu trúc bên trong đúng như đặc tả.
