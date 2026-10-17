# Giới hạn của AI System Architect (bản web cá nhân)

Trang này nói thẳng những gì ứng dụng **không** làm được, để bạn không bị bất ngờ.
Ứng dụng dành cho **một người dùng cá nhân**, chạy trên máy của bạn.

## 1. Không chạy nền

- Mọi công việc (gọi AI, sinh code…) chạy **trong tab trình duyệt**.
- **Đóng tab, tắt máy, mất mạng hoặc máy ngủ = công việc dừng ngay.**
- Không có hàng đợi phía server, không có "chạy tiếp khi bạn đi vắng".
- Khi mở lại, bạn chỉ có thể bấm **"Tiếp tục" (Resume) thủ công** từ điểm lưu (checkpoint) gần nhất.
  Bước đang chạy dở lúc tab đóng sẽ phải chạy lại (và có thể tốn token lần nữa).
- Resume đã có: bảng Pipeline → "▶ Tiếp tục"; mỗi bước/từng file có nút ↻ chạy lại riêng.

## 2. Ngân sách chỉ là CẢNH BÁO, không phải chặn cứng

- Bạn đặt ngân sách theo **ngày** và theo **dự án**. Khi sắp/vượt mức, app **hỏi xác nhận**.
- Bạn luôn có thể bấm "Vẫn tiếp tục". App **không** khóa tài khoản provider của bạn.
- Chi phí chỉ tính được khi **biết giá**:
  - Giá do bạn nhập trong Cài đặt, hoặc giá provider công bố qua API (hiện chỉ OpenRouter có trong danh sách model).
  - Không có giá ⇒ hiển thị **"không rõ giá"**, và **không được cộng** vào ngân sách. Nghĩa là ngân sách có thể **thấp hơn thực tế**.
- Số token lấy từ `usage` mà provider trả về. Nếu provider không trả, app **ước lượng = số ký tự / 4** và gắn nhãn **"ước lượng"** — có thể sai lệch nhiều (đặc biệt với tiếng Việt, ảnh, mã nguồn).
- Ảnh đính kèm **không** ước lượng được token trước.
- Ước tính trước khi chạy dùng mức token **tối đa** (max_tokens) ⇒ thường cao hơn thực tế.
- Nếu bạn dùng cùng API key ở nơi khác, app không biết các chi phí đó.

## 3. Không build / test thật mã nguồn sinh ra

- App **không chạy** code đầu ra (không có máy chủ build, không có Node/Python/Flutter phía sau).
- Chỉ kiểm tra được những gì trình duyệt làm được: cú pháp JS/JSON (và HTML ở mức lỏng), tính nhất quán tên hàm/biến/DOM id so với Contract.
- Ngôn ngữ khác (TypeScript, Python, Dart, YAML…) sẽ ghi rõ **"không kiểm tra được"**.
- Nhãn trạng thái mỗi file chỉ phản ánh các bước đã kiểm tra thật:
  `draft → generated → syntax-checked → consistency-checked → reviewed`.
  App **không bao giờ** ghi "hoàn chỉnh / chạy được" khi chưa có bằng chứng.
- Nếu AI bị cắt (finish_reason = length) sau số vòng nối tối đa, file được đánh dấu **TRUNCATED** và không coi là thành công.

## 4. Khóa API và bảo mật

- Có 2 cách giữ key:
  - **Key ở proxy** (`server/.env`): trình duyệt không bao giờ thấy key.
  - **Key ở trình duyệt**: lưu trong **vault mã hóa** (AES-GCM, PBKDF2-SHA256 600.000 vòng, salt ngẫu nhiên). Mỗi request, key được gửi kèm tới proxy của bạn rồi chuyển tiếp tới provider; proxy **không lưu, không ghi log** key.
- **Quên mật khẩu vault = mất các key trong vault** (không có cách khôi phục). Bạn chỉ cần xóa vault và nhập lại key.
- Chế độ **"chỉ RAM"**: key không ghi xuống ổ đĩa; tải lại trang là mất.
- Vault tự khóa sau N phút không thao tác (mặc định 15 phút).
- Phần mềm độc hại hoặc tiện ích trình duyệt (extension) chạy trên máy bạn vẫn có thể đọc được key khi vault đang mở. Mã hóa chỉ bảo vệ dữ liệu **lưu trên đĩa**.
- Proxy mặc định chỉ nghe `127.0.0.1` (chỉ máy này). Nếu mở ra mạng (`HOST=0.0.0.0`) **bắt buộc** đặt `ACCESS_TOKEN`. Proxy không có HTTPS riêng — chỉ dùng trong mạng tin cậy.
- Cooldown key và rate-limit của proxy nằm trong bộ nhớ: khởi động lại proxy là mất.

## 5. Provider và model

- Danh sách model lấy **động** từ API của provider. Danh sách gợi ý có sẵn chỉ để tham khảo, gắn nhãn **"chưa xác minh"** — có thể đã đổi tên hoặc ngừng.
- Mỗi provider có hành vi hơi khác nhau. Những điểm **chưa xác minh** được để thành tùy chọn sửa được trong Cài đặt:
  - Provider có trả `usage` khi stream hay không (`stream_options.include_usage`). Nếu provider từ chối, app tự thử lại không dùng tùy chọn này và ghi cảnh báo.
  - Giới hạn `max_tokens` của từng model.
  - Model có đọc được ảnh (vision) hay không.
- Gemini được gọi qua **endpoint tương thích OpenAI** — một vài tính năng riêng của Gemini không dùng được.

## 6. Lưu trữ

- Dữ liệu nằm trong **IndexedDB của trình duyệt** trên máy này. Xóa dữ liệu trình duyệt = mất dữ liệu.
- App xin quyền "lưu trữ bền" (`navigator.storage.persist()`); trình duyệt có thể từ chối — app sẽ báo cho bạn.
- Hãy **sao lưu định kỳ** (Cài đặt → Sao lưu → Xuất JSON). File sao lưu chứa vault ở dạng mã hóa.
- Chế độ duyệt ẩn danh: dữ liệu có thể bị xóa khi đóng cửa sổ.
- Không đồng bộ giữa các máy / trình duyệt.

## 7. Khác

- Không có đăng nhập nhiều người dùng, không phân quyền.
- Cache khớp tuyệt đối: chỉ khi **mọi thứ giống hệt** (provider, model, nội dung, nhiệt độ…) mới dùng lại. Kết quả cache có nhãn **"Cached"**. Kết quả bị cắt hoặc từ fallback không được cache.
- Fallback sang provider khác **mặc định tắt**. Khi bật, dữ liệu của bạn (kể cả ảnh/tệp đính kèm) sẽ được gửi sang provider dự phòng — app ghi log mỗi lần như vậy.

## Bổ sung (giai đoạn 5–6)

- **Xem trước HTML** chạy trong iframe `sandbox="allow-scripts"` (origin mờ, không mạng): code gọi API ngoài, `google.script.run`, localStorage… sẽ KHÔNG hoạt động trong khung xem trước. Đây chỉ là xem giao diện tĩnh.
- **Sơ đồ Mermaid** được vẽ trong một iframe sandbox riêng (`/mermaid-frame.html`) vì Mermaid cần style nội tuyến; trang chính giữ CSP không có `'unsafe-inline'`. Nhãn dạng HTML bị loại, chỉ giữ nhãn chữ thường.
- **Kiểm tra cú pháp**: JS/GS/JSON dùng acorn (chặt). HTML chỉ kiểm tra LỎNG (cân bằng thẻ + script nội tuyến). Python, Dart, TS/TSX, CSS, YAML: **không kiểm tra** — nhãn "chưa kiểm tra".
- **PDF/Word**: trích văn bản bằng pdf.js/mammoth; PDF dạng ảnh scan không có chữ ⇒ không trích được.
- **PWA**: chỉ cache file tĩnh để mở lại giao diện khi mất mạng; không gọi được AI khi offline.
- **Cloudflare Worker**: rate-limit và cooldown key chỉ theo từng isolate (không chia sẻ toàn cục); luôn public ⇒ hãy đặt `ACCESS_TOKEN`.
