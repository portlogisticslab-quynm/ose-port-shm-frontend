# ose-port-shm-frontend

Giao diện tĩnh (HTML/JS, không cần build) của app **port-shm** — quan trắc trực tuyến công trình bến và đê chắn sóng.

- `js/config.js`: chọn backend, ưu tiên home, Render dự phòng (Phụ lục B của skill `ose-app-builder`). Ba URL đã điền sẵn:
  - home: `https://api-port-shm.ose.vn`
  - render: `https://ose-port-shm-backend.onrender.com`
  - local: `http://127.0.0.1:8017`
- `js/app.js`: 9 tab. Mọi lệnh gọi API đi qua `apiCall` → `window.oseFetch`. Biểu đồ vẽ bằng SVG, không dùng thư viện ngoài.
- `css/app.css`: giao diện theo ngôn ngữ hải đồ; màu 4 mức Bình thường / Chú ý / Cảnh báo / Hành động.

Chạy thử trên máy:
1. Backend chạy ở `127.0.0.1:8017`.
2. Chạy `python -m http.server 5500` trong thư mục này.
3. Mở `http://localhost:5500`.

Cloudflare Pages:
- Connect to Git, Build command `exit 0`, Output directory `.`.
- Custom domain `port-shm.ose.vn`.

Phiên đăng nhập lưu trong `sessionStorage`, đóng tab là phải đăng nhập lại. Khi sửa `config.js` hoặc `app.js`, tăng số `?v=` trong `index.html` (Bước 7d của skill).

`_headers` đặt các header bảo mật cho Pages (CSP, chống nhúng iframe). Nếu URL Render khác `ose-port-shm-backend.onrender.com`, sửa cả `js/config.js` lẫn dòng `connect-src` trong `_headers`.
