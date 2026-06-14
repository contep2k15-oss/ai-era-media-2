# AI Era Media — Desktop App

App desktop cho Windows, được build tự động bằng GitHub Actions.

---

## 📦 Cách dùng (3 bước)

### Bước 1 — Push lên GitHub

```bash
# Clone/tạo repo mới trên GitHub, rồi chạy lệnh này trong folder này:
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/TEN_BAN/TEN_REPO.git
git push -u origin main
```

### Bước 2 — Tạo tag để trigger build

```bash
git tag v1.0.0
git push origin v1.0.0
```

> Sau khi push tag, vào tab **Actions** trên GitHub để xem tiến trình build (~5-10 phút).

### Bước 3 — Tải file .exe

Vào tab **Releases** trên GitHub → tải file `.exe` về → cài đặt như app bình thường.

---

## 🔧 Chạy thủ công trên máy (để test)

```bash
npm install
npm start
```

Yêu cầu: Node.js 18+

---

## 📁 Cấu trúc

```
ai-era-media-app/
├── main.js          # Electron main process
├── preload.js       # Bridge giữa app và hệ điều hành
├── package.json     # Cấu hình build
├── src/
│   └── index.html   # Toàn bộ app UI
├── assets/
│   ├── icon.png
│   └── icon.ico
└── .github/
    └── workflows/
        └── build.yml  # GitHub Actions — tự build .exe
```

---

## ▶️ Build thủ công không cần tag

Vào GitHub → tab **Actions** → chọn **Build Desktop App** → click **Run workflow**.
