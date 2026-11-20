---
title: Cloudflare Workers 邊緣模式部署
description: 依託 Cloudflare Workers 與 D1 資料庫，在 300+ 邊緣節點無伺服器部署。
---

Cloudflare Workers 部署方式讓您能夠一鍵執行具備全球高可用特性的現代化 DoH 解析服務，徹底免除底層伺服器的運維開銷。

## 方案 1：Git 關聯自動化部署 (推薦)

1. **Fork 倉庫**：點選 GitHub 倉庫右上角的 `Fork` 按鈕，將其複製到您的個人賬戶。
2. **建立 D1 資料庫**：
   - 進入 Cloudflare 控制台，導航至 `Workers & Pages` > `D1`；
   - 建立名為 `dns_worker_db` 的資料庫，並複製生成的 Database ID。
3. **配置 wrangler.toml**：
   - 在您的 Fork 倉庫中編輯 `wrangler.toml`；
   - 將 `database_id` 替換為真實的 D1 資料庫 ID。
4. **部署應用**：
   - 前往 `Workers & Pages` > `Create application` > `Continue with GitHub`；
   - 關聯您的倉庫，並配置構建引數：
     - 構建命令：`npm run build`
     - 部署命令：`npm run deploy`
     - 輸出目錄：`/`
5. **配置憑據金鑰**：
   - 部署完成後，進入專案 `Settings` > `Variables and secrets`；
   - 新增 `JWT_SECRET`（型別選擇 `Secret`，填入高強度隨機字串）；
   - *(可選)* 新增 `KEK_v1`（型別選擇 `Secret`），用於啟用信封加密主金鑰。

---

## 方案 2：本地 CLI 開發與部署

```bash
# 1. 克隆代码仓库并安装依赖
npm install

# 2. 初始化并迁移本地 D1 数据库
npm run db:setup
npm run db:migrate:dev

# 3. 配置本地开发密钥 (.dev.vars)
echo "JWT_SECRET=your_secure_random_jwt_secret" > .dev.vars
echo "KEK_v1=your_secure_kek_v1_secret" >> .dev.vars

# 4. 启动本地开发服务
npm run dev

# 5. 部署到 Cloudflare Workers
npm run deploy
```

---

## Cloudflare D1 資料庫 Studio 查驗

部署完成後，所有使用者、接入點、過濾規則及查詢日誌均持久化於 Cloudflare D1 分散式資料庫中。您可以在 Cloudflare 控制台導航至 **Workers & Pages** > **D1** > 目標資料庫 > **Console / Explore Data** 直接檢索表資料與架構。

---

## 核心環境變數

除作為機密變數儲存的 `JWT_SECRET` 與 `KEK_v1` 外，以下常用執行時變數均可在 `wrangler.toml` 的 `[vars]` 或 Cloudflare 控制台環境變數中調整：

| 變數名 | 預設值 | 說明 |
| --- | --- | --- |
| `FAIL_OPEN_UPSTREAM` | `tls://no-ads-malware-typo.freedns.controld.com` | 資料庫離線或接入點處於未繫結狀態（`profile_id = null`）時回退的兜底上游解析器。 |
| `SUBSTITUTE_DOMAIN` | `www.wto.org` | 接入引導卡片用於探測展示節點 IPv4 與 IPv6 連通狀態的輔助域名。 |
| `MAX_PROFILES_PER_USER` | `10` | 單個賬戶允許建立的最大配置檔案數量。 |
| `MAX_ACCESS_POINTS_PER_PROFILE` | `100` | 賬戶下允許建立的最大接入點數量上限。 |
| `MAX_LOG_RETENTION_DAYS` | `30` | 管理員配置檔案允許設定的最長日誌保留天數上限。 |
| `INACTIVITY_THRESHOLD_DAYS` | `180` | 賬戶連續無解析活動多少天后由定時任務自動清理。 |
| `DEMO_MODE` | `false` | 可選演示開關，設為 `"true"` 時開啟演示模式（展示狀態標籤、脫敏網路遙測並自動注入示例資料；變數名須全大寫）。 |
| `DEMO_DOMAIN` | `dns.worker.domain` | 開啟 `DEMO_MODE` 後頁面統一展示的接入基準域名（變數名須全大寫）。 |

開啟 `DEMO_MODE=true` 後，接入地址與公共探測資訊會自動脫敏並替換為 `DEMO_DOMAIN`，且賬號下會自動冪等填充示例配置檔案、10 種常見裝置形態的接入點（含 1 個未繫結智慧電視示例）、自定義規則、外部過濾列表、示例日誌及全時間範圍動態統計資料。
