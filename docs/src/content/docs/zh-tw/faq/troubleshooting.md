---
title: 常見問題與排錯指引
description: 覆蓋許可權問題 (EACCES)、DoT 證書要求、401 會話過期等常見場景。
---

## 1. TLS 證書顯示 Permission denied (EACCES)

### 現象
後臺服務日誌中顯示：
`• DoT (TLS DNS) : Disabled (Files Inaccessible: Permission denied (EACCES))`

### 原因
後臺服務預設以普通使用者（非 root）降權執行，無法直接讀取 Certbot 生成在 `/etc/letsencrypt/` 下預設許可權為 `0600 (root:root)` 的私鑰。

### 解決方法
推薦使用系統 `ssl-cert` 使用者組授權（無需提升至 root，安全規範）：
```bash
sudo groupadd -f ssl-cert
sudo usermod -a -G ssl-cert <username>
sudo chgrp ssl-cert /etc/letsencrypt/live/<your-domain>/privkey.pem
sudo chmod 640 /etc/letsencrypt/live/<your-domain>/privkey.pem
sudo chgrp ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive
sudo chmod 750 /etc/letsencrypt/live /etc/letsencrypt/archive
sudo dns-worker service restart
```

---

## 2. DoT 顯示 Paused (Requires Wildcard Certificate *.domain)

### 現象
HTTPS Web 儀表盤能正常啟動，但 DoT 處於暫停狀態。

### 原因
DoT 需要基於 TLS SNI 識別並路由不同的配置 Profile（`<profileKey>.dns.example.com`）。單域名證書無法覆蓋子域名，因此必須使用萬用字元證書。

### 解決方法
使用 Certbot 通過 DNS 挑戰重新申請萬用字元證書：
```bash
certbot certonly -d *.your.domain -d your.domain --manual --preferred-challenges dns
```

---

## 3. 為什麼後臺服務修改了當前目錄的 .env 沒有生效？

### 現象
在個人目錄編輯了 `.env` 並重啟了服務，但服務顯示未配置。

### 原因
通過 `systemd` 託管的 Service 模式下，系統載入的環境變數檔案固定為 **/etc/dns-worker/.env**。請確保配置已寫入 `/etc/dns-worker/.env`。

---

## 4. 裝置接入正常，但過濾規則未生效且沒有查詢日誌？

### 現象
客戶端使用分配的 DoH 地址或 DoT 域名可以正常上網，但配置的攔截規則不生效，且在 **解析日誌** 頁面看不到對應請求記錄。

### 原因
接入點與配置檔案採用解耦設計。當某個接入點處於 **未繫結** 狀態（例如新建時未繫結，或原本繫結的配置檔案被刪除導致 `profile_id` 置空）時，系統為保障不斷網會將其路由至 `FAIL_OPEN_UPSTREAM` 應急上游，跳過規則過濾且不寫入日誌。

### 解決方法
進入左側 **接入點 > 管理**（`/access-points/manage`），找到對應裝置卡片，在 **繫結配置** 下拉框中重新繫結目標配置檔案即可立即生效。

---

## 5. `npm run dev` 本地開發時統計頁世界地圖不顯示（僅見零星圓點）？

### 現象
統計頁地圖區域能看到微縮地區圓點與圖例、縮放按鈕，但各大洲地理輪廓未渲染。

### 原因
世界地圖資料依賴 `/world-110m.json`（由服務代理上游並攜帶 `Cache-Control: max-age=2592000` 快取）。若本地 `.wrangler/state/v3/cache` 快取塊損壞、瀏覽器命中此前 30 天舊快取或開發服務尚未完全啟動時請求超時，會導致地圖輪廓資料未能載入。

### 解決方法
1. 停止 `npm run dev`，清理 `.wrangler/state/v3/cache` 目錄（保留 `.wrangler/state/v3/d1` 與 `.wrangler/state/v3/do` 資料庫資料），重新啟動 `npm run dev`。
2. 在瀏覽器執行一次強制重新整理（`Ctrl + Shift + R` / `Cmd + Shift + R`），跳過舊快取重新拉取 `/world-110m.json?v=3`。
