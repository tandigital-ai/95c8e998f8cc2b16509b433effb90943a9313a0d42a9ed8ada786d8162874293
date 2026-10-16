# TESTING

## Tự động
- `npm test`: unit test (node --test), không cần mạng.
- `npm run e2e`: Playwright, chạy khi server đang mở ở :3000.
  - `tests/e2e/smoke.py`: tải trang, mở 9 modal ở header, bắt lỗi console và vi phạm CSP, kiểm tra tràn ngang ở 375/768/1440px.
  - `tests/e2e/pipeline.py`: LLM giả lập (chặn `/api/llm/*`); chạy đủ 9 bước pipeline rồi xuất ZIP và đọc manifest.

## Thủ công (với key thật)
1. Bật provider, Test Ping, Tải models: chấm xanh, có danh sách model.
2. Tạo kiến trúc khi bật Streaming: chữ hiện dần; bấm Hủy thì dừng ngay.
3. Đặt max_tokens = 256: thấy log tự nối vòng; hết vòng mà vẫn cắt ⇒ nhãn BỊ CẮT.
4. Chạy pipeline rồi đóng tab giữa chừng; mở lại ⇒ có thông báo "gián đoạn", bấm Tiếp tục.
5. Sửa contract sai (xóa `functions`) ⇒ pipeline dừng ở bước Contract.
6. Review ⇒ có đề xuất sửa ⇒ xem diff ⇒ Accept/Reject.
7. Version: lưu, sửa, diff, khôi phục; nhân bản dự án.
8. Export ZIP: mở `manifest.json` và kiểm tra SHA-256.
9. Sao lưu JSON ⇒ xóa dữ liệu trình duyệt ⇒ khôi phục.
10. Vault: tạo, khóa, mở; nhập sai mật khẩu phải báo lỗi; chờ tự khóa.
11. Giao diện 375px, phím Tab đi qua các nút, Esc đóng modal.
