# MEXC Guard — Chrome extension

Bản Chrome của app Android MEXC Guard: theo dõi PnL, đóng nhanh vị thế, đặt lệnh MEXC Futures, tin tức giá vàng và lịch kinh tế.

## Cài đặt
1. Mở `chrome://extensions`, bật **Developer mode** (góc phải trên).
2. Bấm **Load unpacked** → chọn thư mục `E:\App\mexc-guard-extension`.
3. Ghim biểu tượng ◆ lên thanh công cụ (biểu tượng mảnh ghép → ghim).
4. Bấm biểu tượng → nhập API Key, Secret Key và đặt **mã PIN** → Lưu.

## Tính năng
- **Danh mục**: Equity, PnL realtime (WebSocket), khoảng cách tới giá thanh lý, đóng 25/50/100%, hủy lệnh chờ, "Đóng tất cả".
- **Giao dịch**: chọn cặp, biểu đồ Nến/Thanh/Đường M1→MN (cuộn chuột để zoom, kéo để xem lịch sử, nhấp đúp để về mới nhất), đặt lệnh Market/Limit, Isolated/Cross, TP/SL.
- **Tin tức**: Giá vàng, Thế giới (tiếng Việt), Quốc tế (EN), Lịch kinh tế.
- **Badge** trên biểu tượng: tổng PnL cập nhật mỗi 30 giây, di chuột để xem từng vị thế.
- **Cảnh báo thanh lý**: thông báo khi giá cách giá thanh lý dưới ngưỡng (mặc định 0,5%).
- **Side Panel**: nút ▤ để mở cố định bên cạnh trang web, biểu đồ lớn hơn.

## Bảo mật
- Key được mã hóa AES-256-GCM bằng khóa sinh từ PIN (PBKDF2 310.000 vòng), lưu trong `chrome.storage.local`.
- Bản đã giải mã chỉ nằm trong bộ nhớ (`chrome.storage.session`), tự xóa khi đóng trình duyệt → mở lại phải nhập PIN.
- Chỉ gửi request tới MEXC; không có server trung gian. Không bật quyền rút tiền cho API Key.
