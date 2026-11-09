# MEXC Guard

App Android theo dõi và đóng nhanh vị thế / lệnh chờ Futures trên MEXC qua Open API.
Expo SDK 58 · React Native 0.88 · TypeScript.

## Cấu trúc

```
App.tsx                      Lần đầu: màn nhập key; sau đó: MainScreen
src/
  api/
    mexcApi.ts               MexcApiService: ký HMAC-SHA256, đồng bộ giờ, REST Futures v1, đặt/đóng/hủy lệnh
    mexcSocket.ts            WebSocket giá đánh dấu (push.fair.price), tự reconnect
    types.ts                 Kiểu dữ liệu response / lệnh mới
  hooks/useFutures.ts        Polling 4s + WebSocket, tính PnL/ROE, mọi action giao dịch
  storage/credentials.ts     Lưu key bằng expo-secure-store (Android Keystore), nhắc hạn 90 ngày
  screens/
    MainScreen.tsx           Thanh tab dưới: Danh mục / Giao dịch / Cài đặt
    PortfolioScreen.tsx      Tổng quan, Vị thế (đóng 25/50/100%) / Lệnh chờ, nút Panic
    TradeScreen.tsx          Đặt lệnh Limit/Market, Long/Short, đòn bẩy, Isolated/Cross, TP/SL
    SettingsScreen.tsx       Nhập key, kiểm tra kết nối (ping, lệch giờ)
  components/                Header, PositionCard, OrderRow
  haptics.ts                 Rung phản hồi
  theme.ts                   Màu dark mode, format số
plugins/withShortCxxPath.js  Sửa lỗi đường dẫn dài khi build trên Windows
```

## Ghi chú kỹ thuật

- Chữ ký: `HMAC-SHA256(secret, apiKey + Request-Time + paramString)`; GET → query sắp xếp theo key,
  POST → nguyên chuỗi JSON body. Header: `ApiKey`, `Request-Time`, `Signature`, `Recv-Window`.
- `Request-Time` = giờ máy + độ lệch đo từ `/api/v1/contract/ping` (tự đo lại khi gặp lỗi thời gian).
- ID lệnh/vị thế lớn hơn 2^53 nên được giữ dạng chuỗi khi parse và ghi dạng số thô khi gửi.
- Đóng vị thế = lệnh Market phía đóng (`side` 4 đóng Long, 2 đóng Short, `type` 5) với 100% `holdVol`.
  Nếu một phần khối lượng đang bị khóa bởi lệnh đóng chờ, lệnh chờ của cặp đó được hủy trước.
- Đặt lệnh: `side` 1 mở Long / 3 mở Short, `type` 1 Limit / 5 Market, `openType` 1 Isolated / 2 Cross,
  TP/SL tùy chọn qua `takeProfitPrice` / `stopLossPrice`. Khối lượng nhập theo USDT margin
  (quy đổi `vol = margin × leverage / (giá × contractSize)`, làm tròn xuống theo `volUnit`) hoặc trực tiếp theo cont.
- Panic "Đóng tất cả": hủy hết lệnh Limit / Trigger / TP-SL → lấy lại vị thế → đóng Market song song.
- Máy chủ mặc định `https://api.mexc.com` (có thể đổi sang `contract.mexc.com` trong Cài đặt).

## Build APK (Windows)

Yêu cầu: Node 20+, JDK 17, Android SDK (`ANDROID_HOME`).

```powershell
cd E:\App\mexc-guard
npm install
npx expo prebuild -p android          # tạo thư mục android/ (chạy lại khi đổi app.json / thêm thư viện native)

$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot'
cd android
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
# APK: android\app\build\outputs\apk\release\app-release.apk
```

Bỏ `-PreactNativeArchitectures=...` để build cho mọi kiến trúc CPU (APK lớn hơn).

APK release đang ký bằng debug keystore — đủ để cài trực tiếp. Muốn ký bằng key riêng:
`keytool -genkeypair -v -keystore release.jks -alias mexcguard -keyalg RSA -keysize 2048 -validity 10000`
rồi khai báo `signingConfigs.release` trong `android/app/build.gradle`.

## Cài lên điện thoại

```powershell
adb devices                                                   # phải thấy thiết bị ở trạng thái "device"
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

Hoặc chép file APK vào điện thoại và mở để cài (cho phép "Cài ứng dụng không rõ nguồn gốc").

## Phát triển

```powershell
npx tsc --noEmit                  # kiểm tra kiểu
npx expo run:android              # build debug + chạy trên máy đang cắm
```
