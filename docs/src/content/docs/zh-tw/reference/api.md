---
title: API / 應用程式介面
description: DNS Worker 根路徑非前端網路路徑（DoH、Linux 安裝指令碼、地圖代理、DoT/UDP）以及 /api/* HTTP / WebSocket 主控台介面參考。
---

DNS Worker 在與控制台 / Worker 相同的網域下同時提供 **根路徑 `/` 下的非前端路徑**（如基於 `/:key` 的 RFC 8484 DoH 服務、安裝指令碼與拓樸代理等），以及位於 `/api/*` 下的 **JSON REST API / WebSocket 即時介面**。

## 根路徑網路介面（`/` 下非前端路徑）

除前端頁面、靜態資源與 SPA 路由兜底（`handleAssetsRouter`）外，根路徑 `/` 下的網路請求會依下列規則直接分派至 DNS 與網路服務處理器（以下路徑皆無需 Bearer JWT 或 CSRF Token）：

| 路徑 / 傳輸方式 | 方法 / 通訊協定 | 參數與格式要求 | 說明 |
| --- | --- | --- | --- |
| `/:key` | `GET`、`POST`、`OPTIONS`（HTTPS / HTTP/2+） | `key` 符合 `^[a-zA-Z0-9]{5,12}$`；`GET ?dns=<base64url>` 或攜帶 `Accept: application/dns-message`；`POST` 請求主體為原始 DNS 二進位封包（`application/dns-message`，Serverfull 模式上限 64 KB） | **DoH 接入端點（RFC 8484）**。優先比對 `access_points.token`（實現依裝置歸因），其次比對 `profiles.profile_key` 或 `profiles.id`；系統刻意不開放無金鑰的 `/dns-query` 路徑。回應傳回 `application/dns-message`、`Cache-Control: max-age=<ttl>` 與全放行 CORS 標頭（`*`）。 |
| `/setup.sh` | `GET` | 查詢參數 `key` 須符合 `^[a-zA-Z0-9]{5,12}$`，且 `Host` 須為合法 HTTP/HTTPS 來源 | 動態產生 `text/plain` 格式的 Linux 一鍵安裝指令碼（安裝 `cloudflared` 並註冊 `systemd` 服務 `cloudflared-dns.service`，將 `--upstream <origin>/<key>` 對應至本機 `53` 連接埠）。 |
| `/world-110m.json` | `GET` | 無 | GeoIP 世界地圖 TopoJSON 代理介面，自動補齊 3 位國家數字 ID 並啟用邊緣快取（`max-age=2592000`，30 天），回應帶 `Access-Control-Allow-Origin: *`。 |

### DoH 協定約束與回應說明（`/:key`）

- **Access Key 校驗與 Durable Objects 容災**：合法的 Access Key（含 `access_points.token`、`profiles.profile_key` 與 `profiles.id`）會同步寫入基於 SQLite 的 Durable Objects（`ACCESS_KEY_DO`，分為 16 個確定性分片）。當 D1 或 Turso 下線或達到讀取配額進入 `FAIL_OPEN` 狀態時，合法 Access Key 仍可透過 `FAIL_OPEN_UPSTREAM` 繼續完成解析並保留設定檔 / 接入點歸屬資訊，而未註冊或已撤銷的無效 Key 將被拒絕（`404 Invalid Profile Key`）。
- **HTTP/2+ 強制校驗（RFC 8484 §5.2）**：若請求以 `HTTP/1.0` 或 `HTTP/1.1` 到達（透過 `request.cf.httpProtocol` 或 `X-Http-Version` 偵測），伺服器將回傳 `505 HTTP Version Not Supported`。
- **CORS 預檢（`OPTIONS`）**：回傳 `204 No Content`，攜帶 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type, Accept` 與 `Access-Control-Max-Age: 86400`。
- **例外與故障開放（Fail-Open）**：
  - `400 Invalid DNS Query`：非標準或損壞的 DNS 線路格式請求封包（要求 `QR=0`、`OPCODE=0`、`QDCOUNT=1`、`QNAME <= 253` 字元）。
  - `404 Invalid Profile Key`：未比對到有效的接入點權杖或設定檔金鑰。
  - `413 Payload Too Large`：Serverfull HTTP 處理器拒絕超過 64 KB 的 DoH `POST` 請求主體。
  - `502 Upstream Resolution Failed` / `500 Internal Server Error`：管線或資料庫異常時會先嘗試透過 `FAIL_OPEN_UPSTREAM` 完成應急解析後再決定是否回傳錯誤。

```bash
# 範例：透過 HTTP/2 POST 傳送二進位 DNS 查詢封包至指定 Key 的 DoH 端點
curl --http2 -sS -X POST https://dns.example.com/<accessKey> \
  -H "Content-Type: application/dns-message" \
  -H "Accept: application/dns-message" \
  --data-binary @query.dns -o response.dns

# 範例：取得指定 Key 的 Linux cloudflared 一鍵設定指令碼
curl -fsSL "https://dns.example.com/setup.sh?key=<accessKey>"
```

### 非 HTTP DNS 傳輸介面（Serverfull 模式）

在獨立部署的 Serverfull 模式下，除 HTTP / DoH 服務外還會監聽以下原生 DNS 網路連接埠：

- **DNS-over-TLS（DoT，RFC 7858）**：使用 ALPN `dot` 協定並要求設定萬用字元憑證（`*.domain`）。支援從 TLS SNI 中擷取 `5–12` 位英數字金鑰（例如 `<accessKey>.dns.example.com`）以綁定對應設定檔或接入點；直接連線基礎網域時回退至 `resolveDefaultProfile`（`SERVERFULL_DEFAULT_PROFILE_KEY` / `DEFAULT_PROFILE_KEY` / `FAIL_OPEN_UPSTREAM`）。
- **傳統 UDP DNS（RFC 1035 / RFC 6891）**：原生 UDP 監聽器，內建單 IP 權杖桶限流（突發容量 `120` 封包、速率 `60/s`），統一透過 `resolveDefaultProfile` 解析請求。

---

## 驗證機制、CSRF 與前置攔截

### Bearer Token 與 Refresh Cookie

- **公開介面**無需攜帶 `Authorization` 請求標頭：
  - `GET /api/auth/config`、`GET /api/auth/check-username`
  - `POST /api/auth/signup`、`POST /api/auth/prelogin`、`POST /api/auth/login`
  - `POST /api/auth/refresh`、`POST /api/auth/logout`
  - `GET|POST /api/auth/unlock-session`（於鎖定處理器內部直接校驗 `Authorization: Bearer <accessToken>`）
  - `POST /api/auth/forgot-password/init`、`POST /api/auth/forgot-password/verify`、`POST /api/auth/forgot-password/reset`
  - `GET /api/clientinfo`、`GET /api/substitute`、`GET /api/resolve`、`GET /api/geoip`、`GET /api/icon/:domain`、`GET /api/presets/*`
- **受保護介面**必須於請求標頭攜帶 `Authorization: Bearer <accessToken>`。權杖缺失或無效時回傳 `401 Unauthorized`。
- **更新流程**：`POST /api/auth/login` 與 `POST /api/auth/signup` 會寫入 `HttpOnly` 的 `refresh_token` Cookie，用戶端隨後可呼叫 `POST /api/auth/refresh` 換取新的 Access Token。

### 雙重提交 CSRF 防護（Double-Submit）

所有已驗證的變更類請求（`POST`、`PUT`、`PATCH`、`DELETE`），以及攜帶 Refresh Cookie 發起的 `POST /api/auth/refresh` 與 `POST /api/auth/logout`，皆受雙重提交 CSRF 校驗保護：

1. 伺服器回應會寫入 `csrf_token` Cookie。
2. 用戶端發起變更請求時，必須於請求標頭 `X-CSRF-Token` 中攜帶一致的值。
3. 缺失或不相符時將回傳 `403 Forbidden`（`CSRF validation failed`）。

### 工作階段鎖定（Paused / Locked Sessions）

當透過 `POST /api/auth/lock-session` 鎖定工作階段後，後續已驗證 API 請求將回傳 `403`（`session_paused`），僅放行以下介面：

- `GET|POST /api/auth/unlock-session`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `PATCH /api/account/me`（僅限修改 `locale` 語系欄位）

### 就緒檢查、配額門控與常見狀態碼

| 狀態碼 | 含義 | 說明 |
| --- | --- | --- |
| `400` | Bad Request | JSON 請求主體格式錯誤、缺少必填參數或欄位校驗未通過 |
| `401` | Unauthorized | 缺少 Bearer Token，或工作階段已過期 / 遭撤銷 |
| `403` | Forbidden | CSRF 校驗失敗、`session_paused` 鎖定中、缺少二次高風險驗證，或非管理員呼叫 `/api/admin/*` |
| `503` | Service Unavailable | `error: "configuration_error"`（資料庫或 `JWT_SECRET` 未就緒）或 `error: "database_quota_exceeded"`（Turso 讀取配額耗盡；此時 DoH 故障開放解析仍維持可用） |

---

## 快速範例（`curl`）

```bash
# 1. 登入並儲存 Cookie（包含 refresh_token 與 csrf_token）
curl -s -c cookies.txt -X POST https://dns.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'

# 從 cookies.txt 提取 CSRF Token，並將登入回應中的 accessToken 指派給 ACCESS_TOKEN
CSRF=$(awk '$6=="csrf_token"{print $7}' cookies.txt)

# 2. 取得設定檔清單
curl -s -b cookies.txt https://dns.example.com/api/profiles \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 3. 測試指定設定檔的網域規則比對（變更類請求必須攜帶 X-CSRF-Token）
curl -s -b cookies.txt -X POST https://dns.example.com/api/profiles/<profileId>/test \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"domain":"ads.example.com","type":"A"}'
```

---

## 身分驗證（`/api/auth/*`）

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/auth/config` | Public | 回傳公開驗證設定（是否開放註冊、Turnstile Site Key、執行模式識別等）。 |
| `GET` | `/api/auth/check-username?username=...` | Public | 註冊前檢查使用者名稱是否可用及密碼策略中繼資訊。 |
| `POST` | `/api/auth/signup` | Public | 註冊新帳號並簽發 Access / Refresh Token。 |
| `POST` | `/api/auth/prelogin` | Public | 查詢目標使用者的登入方式（Passkey、MFA、無密碼登入狀態等）。 |
| `POST` | `/api/auth/login` | Public | 使用密碼、Passkey 斷言或 TOTP / MFA 完成登入並寫入工作階段 Cookie。 |
| `POST` | `/api/auth/refresh` | Cookie + CSRF | 輪換 `refresh_token` Cookie 並回傳新的短期 Access Token。 |
| `POST` | `/api/auth/logout` | Cookie + CSRF | 登出目前工作階段並清除驗證 Cookie。 |
| `GET` | `/api/auth/unlock-session` | Bearer | 取得目前工作階段鎖定狀態及可用解鎖方式（PIN / Passkey / 密碼）。 |
| `POST` | `/api/auth/unlock-session` | Bearer | 使用 PIN、Passkey 或密碼解鎖已暫停的工作階段。 |
| `POST` | `/api/auth/lock-session` | Bearer + CSRF | 將目前工作階段標記為鎖定（Paused）狀態。 |
| `POST` | `/api/auth/forgot-password/init` | Public | 初始化忘記密碼復原流程。 |
| `POST` | `/api/auth/forgot-password/verify` | Public | 校驗復原金鑰或挑戰資訊。 |
| `POST` | `/api/auth/forgot-password/reset` | Public | 完成密碼重設並更新相關憑證狀態。 |

---

## 系統與公共工具（`/api/*`）

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/clientinfo` | Public | 回傳偵測到的用戶端 IP 與請求網路資訊。 |
| `GET` | `/api/substitute` | Public | 回傳部署中繼資訊、執行模式（`serverfull` 或 Worker）及版本號。 |
| `GET` | `/api/presets/upstreams` | Public | 取得內建上游 DoH/DoT 解析器預設清單。 |
| `GET` | `/api/presets/filters` | Public | 取得預設過濾規則清單 URL 與分類。 |
| `GET` | `/api/presets/ech-fronting-domains` | Public | 取得預設 ECH / Fronting 網域清單。 |
| `GET` | `/api/icon/:domain` | Public | 代理取得目標網域的網站圖示（Favicon）。 |
| `GET` | `/api/geoip?ip=...` | Public | 查詢指定 IP 的 GeoIP 地理位置與 ASN 資訊。 |
| `GET` | `/api/resolve?name=...` | Public | 執行 DNS 記錄解析查詢（支援 `name` 或 `domain` 查詢參數）。 |

---

## 帳號與安全（`/api/account/*`）

### 個人資料、稽核日誌與工作階段管理

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/account/me` | Bearer | 取得目前帳號資訊、角色、偏好設定（`locale`）及安全狀態摘要。 |
| `PATCH` | `/api/account/me` | Bearer + CSRF | 更新帳號偏好設定（如 `locale`；鎖定狀態下僅允許更新 `locale`）。 |
| `DELETE` | `/api/account/me` | Bearer + CSRF | 註銷並刪除目前帳號（須先通過高風險二次驗證 Step-up Reauth）。 |
| `POST` | `/api/account/delete` | Bearer + CSRF | 刪除帳號的備選 POST 介面（須 Step-up Reauth）。 |
| `DELETE` | `/api/account/logs` | Bearer + CSRF | 清空目前使用者旗下所有設定檔的 DNS 查詢日誌。 |
| `GET` | `/api/account/activity?limit=&before=` | Bearer | 分頁查詢帳號安全稽核事件記錄。 |
| `GET` | `/api/account/sessions` | Bearer | 列出目前帳號所有作用中工作階段。 |
| `DELETE` | `/api/account/sessions/others` | Bearer + CSRF | 登出除目前工作階段外的所有其他工作階段。 |
| `DELETE` | `/api/account/sessions/:id` | Bearer + CSRF | 依工作階段 ID 登出指定工作階段。 |

### 憑證、MFA、Passkeys 與復原金鑰

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `POST` | `/api/account/password` | Bearer + CSRF | 修改帳號登入密碼（須 Step-up Reauth）。 |
| `POST` | `/api/account/migrate-password` | Bearer + CSRF | 遷移或升級密碼雜湊版本。 |
| `POST` | `/api/account/pin` | Bearer + CSRF | 設定或更新工作階段快速鎖定 PIN 碼。 |
| `DELETE` | `/api/account/pin` | Bearer + CSRF | 移除工作階段鎖定 PIN 碼。 |
| `POST` | `/api/account/recovery-keys/rotate` | Bearer + CSRF | 輪換並產生新的一次性復原金鑰，舊金鑰隨即失效。 |
| `GET` | `/api/account/totp/setup` | Bearer | 產生 TOTP 金鑰及 `otpauth://` 設定 URI。 |
| `POST` | `/api/account/totp/confirm` | Bearer + CSRF | 校驗動態驗證碼並正式啟用 TOTP。 |
| `POST` | `/api/account/totp/test` | Bearer + CSRF | 測試目前輸入的 TOTP 驗證碼是否有效。 |
| `PATCH` | `/api/account/totp/settings` | Bearer + CSRF | 更新 MFA 與無密碼登入開關（與 `/api/account/mfa/settings` 共用處理邏輯）。 |
| `DELETE` | `/api/account/totp` | Bearer + CSRF | 關閉並解除目前帳號的 TOTP 兩步驟驗證。 |
| `PATCH` | `/api/account/mfa/settings` | Bearer + CSRF | 更新 MFA / 無密碼登入安全策略設定。 |
| `GET` | `/api/account/passkeys` | Bearer | 列出已綁定的 WebAuthn Passkeys。 |
| `POST` | `/api/account/passkeys/auth-options` | Bearer + CSRF | 下發用於二次校驗或測試的 WebAuthn 驗證挑戰選項。 |
| `POST` | `/api/account/passkeys/test` | Bearer + CSRF | 驗證 Passkey 斷言（不修改憑證）。 |
| `POST` | `/api/account/passkeys/register/options` | Bearer + CSRF | 下發註冊新 Passkey 所需的 WebAuthn 註冊選項。 |
| `POST` | `/api/account/passkeys/register/verify` | Bearer + CSRF | 校驗新 Passkey 註冊憑證並儲存。 |
| `PATCH` | `/api/account/passkeys/:id` | Bearer + CSRF | 重新命名已綁定的 Passkey。 |
| `DELETE` | `/api/account/passkeys/:id` | Bearer + CSRF | 刪除已綁定的 Passkey。 |

### 使用者級過濾清單與帳號 E2EE

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/account/user-lists` | Bearer | 取得帳號級過濾清單（自動繼承至名下所有設定檔）。 |
| `POST` | `/api/account/user-lists` | Bearer + CSRF | 新增使用者級過濾清單。 |
| `PATCH` | `/api/account/user-lists/:id` | Bearer + CSRF | 更新使用者級過濾清單狀態（如啟用 / 停用）。 |
| `DELETE` | `/api/account/user-lists/:id` | Bearer + CSRF | 刪除使用者級過濾清單。 |
| `GET` | `/api/account/e2ee/status` | Bearer | 查詢帳號級 E2EE 狀態與金鑰封裝情況。 |
| `GET` | `/api/account/e2ee/wrapped-key` | Bearer | 取得使用密碼 / Passkey PRF 封裝的資料加密金鑰（DEK）。 |
| `GET` | `/api/account/e2ee/recovery-wrapped-key` | Bearer | 取得使用復原金鑰封裝的 DEK。 |
| `POST` | `/api/account/e2ee/init` | Bearer + CSRF | 初始化帳號 E2EE 封裝金鑰。 |
| `POST` | `/api/account/e2ee/wrap` | Bearer + CSRF | 追加儲存 DEK 的新封裝副本（例如綁定新 Passkey PRF 時）。 |
| `POST` | `/api/account/e2ee/wrap-recovery` | Bearer + CSRF | 儲存由復原金鑰封裝的 DEK 副本。 |
| `POST` | `/api/account/e2ee/enable` | Bearer + CSRF | 於帳號上啟用 E2EE 加密模式。 |
| `DELETE` | `/api/account/e2ee` | Bearer + CSRF | 停用帳號 E2EE（傳入 `?purge=true` 可一併清理密文資料）。 |

---

## 設定檔（`/api/profiles/*`）

### 核心設定、參數與測試

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles` | Bearer | 列出目前使用者擁有的所有 DNS 設定檔。 |
| `POST` | `/api/profiles` | Bearer + CSRF | 建立新的 DNS 設定檔並產生預設 DoH 金鑰。 |
| `GET` | `/api/profiles/:id` | Bearer | 取得指定設定檔的完整設定詳情。 |
| `PATCH` | `/api/profiles/:id` | Bearer + CSRF | 更新設定檔基本資訊（如名稱）。 |
| `DELETE` | `/api/profiles/:id` | Bearer + CSRF | 刪除設定檔及其關聯的規則、清單與日誌。 |
| `POST` | `/api/profiles/:id/rotate_key` | Bearer + CSRF | 輪換設定檔主 DoH 接入金鑰（`/:key`）。 |
| `PATCH` | `/api/profiles/:id/settings` | Bearer + CSRF | 更新解析器進階設定（上游 DoH/DoT、ECS、ECH、日誌隱私與快取選項等）。 |
| `POST` | `/api/profiles/:id/test` | Bearer + CSRF | 模擬測試 `{ "domain": "...", "type": "A" }` 的規則與清單命中結果（`domain` 最長 253 字元，`type` 預設為 `A`）。 |

### 接入點（Access Points）

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/access_points` | Bearer | 列出設定檔下依裝置/情境劃分的獨立 DoH 接入點。 |
| `POST` | `/api/profiles/:id/access_points` | Bearer + CSRF | 建立新的命名接入點權杖，用於在日誌中識別裝置來源。 |
| `POST` | `/api/profiles/:id/access_points/:apId/rotate_token` | Bearer + CSRF | 輪換指定接入點的 DoH 權杖。 |
| `PATCH` | `/api/profiles/:id/access_points/:apId` | Bearer + CSRF | 更新接入點名稱或啟用狀態。 |
| `DELETE` | `/api/profiles/:id/access_points/:apId` | Bearer + CSRF | 刪除指定接入點。 |

### 自訂規則

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/rules` | Bearer | 列出設定檔的放行、攔截與重寫規則。 |
| `POST` | `/api/profiles/:id/rules` | Bearer + CSRF | 新增單條規則或批次匯入多條規則。 |
| `PUT` | `/api/profiles/:id/rules` | Bearer + CSRF | 覆寫或更新設定檔下的自訂規則。 |
| `DELETE` | `/api/profiles/:id/rules` | Bearer + CSRF | 刪除一條或多條自訂規則。 |

### 過濾清單

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/lists` | Bearer | 取得設定檔關聯的過濾清單（含設定檔級、使用者級 `User` 與系統級 `System` 標籤）。 |
| `GET` | `/api/profiles/:id/lists/sync-status` | Bearer | 查詢各過濾清單的最近同步時間、規則項目數及異常狀態。 |
| `GET` | `/api/profiles/:id/lists/:listId/check?domain=...` | Bearer | 檢查指定網域是否命中該過濾清單。 |
| `POST` | `/api/profiles/:id/lists` | Bearer + CSRF | 向設定檔新增單個或批次外部過濾清單 URL。 |
| `PATCH` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | 啟用、停用或修改過濾清單掛載設定。 |
| `POST` | `/api/profiles/:id/lists/sync` | Bearer + CSRF | 立即同步該設定檔下的所有可用過濾清單。 |
| `POST` | `/api/profiles/:id/lists/:listId/sync` | Bearer + CSRF | 立即同步單個過濾清單。 |
| `DELETE` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | 從設定檔移除設定檔級過濾清單。 |

### 查詢日誌、即時推播與統計分析

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/logs` | Bearer | 分頁檢索 DNS 查詢日誌（支援狀態、網域、用戶端、時間區間過濾）。 |
| `GET` | `/api/profiles/:id/logs/export` | Bearer | 匯出設定檔的查詢日誌。 |
| `GET` | `/api/profiles/:id/logs/:logId` | Bearer | 查詢單條日誌記錄詳情。 |
| `DELETE` | `/api/profiles/:id/logs` | Bearer + CSRF | 清空該設定檔下儲存的查詢日誌。 |
| `POST` | `/api/profiles/:id/logs/ws-ticket` | Bearer + CSRF | 簽發一次性短期 Ticket，用於建立即時日誌 WebSocket 連線。 |
| `GET` (WS) | `/api/profiles/:id/logs/ws` | Ticket | WebSocket 升級端點，用於即時接收 DNS 查詢事件流。 |
| `GET` | `/api/profiles/:id/analytics` | Bearer | 取得設定檔綜合統計分析概覽。 |
| `GET` | `/api/profiles/:id/analytics/summary` | Bearer | 取得請求總數、攔截量、快取命中及回應延遲彙總。 |
| `GET` | `/api/profiles/:id/analytics/trend` | Bearer | 取得依時間分桶的查詢趨勢與攔截率資料。 |
| `GET` | `/api/profiles/:id/analytics/top_allowed` | Bearer | 取得最常放行的網域排行榜。 |
| `GET` | `/api/profiles/:id/analytics/top_blocked` | Bearer | 取得最常攔截的網域排行榜。 |
| `GET` | `/api/profiles/:id/analytics/clients` | Bearer | 依用戶端 IP / 接入點統計查詢分佈。 |
| `GET` | `/api/profiles/:id/analytics/destinations` | Bearer | 依目標國家 / GeoIP 統計流量分佈。 |
| `GET` | `/api/profiles/:id/analytics/isps` | Bearer | 依目標 ASN / ISP 營運商統計查詢分佈。 |

### 設定檔級 E2EE

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/e2ee/status` | Bearer | 查詢該設定檔是否已啟用獨立 E2EE。 |
| `GET` | `/api/profiles/:id/e2ee/wrapped-key` | Bearer | 取得該設定檔已封裝的加密金鑰。 |
| `POST` | `/api/profiles/:id/e2ee/init` | Bearer + CSRF | 初始化設定檔級 E2EE 金鑰。 |
| `POST` | `/api/profiles/:id/e2ee/wrap` | Bearer + CSRF | 更新或追加設定檔金鑰封裝副本。 |
| `DELETE` | `/api/profiles/:id/e2ee` | Bearer + CSRF | 停用設定檔級 E2EE。 |

---

## 系統管理（`/api/admin/*`）

所有 `/api/admin/*` 介面皆要求目前**已驗證**使用者具備 `role === 'admin'` 權限，否則回傳 `403 Forbidden`。

| 方法 | 路徑 | 權限 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/admin/users` | Admin | 列出所有已註冊使用者及其配額使用情況。 |
| `POST` | `/api/admin/users` | Admin + CSRF | 以管理員身分建立新使用者帳號。 |
| `DELETE` | `/api/admin/users/:id` | Admin + CSRF | 刪除指定使用者帳號及其名下資源。 |
| `GET` | `/api/admin/settings` | Admin | 取得全域系統設定（Turnstile、註冊開關、配額限制等）。 |
| `PATCH` | `/api/admin/settings` | Admin + CSRF | 更新全域系統設定。 |
| `GET` | `/api/admin/database` | Admin | 檢查資料庫驅動類型、遷移狀態、Schema 就緒情況及執行模式（`serverfull` 或 Worker）。 |
| `POST` | `/api/admin/database/migrate` | Admin + CSRF | 執行待處理的資料庫 Schema 遷移。 |
| `GET` | `/api/admin/distribute-filter` | Admin | 列出目前生效的系統級下發過濾清單。 |
| `POST` | `/api/admin/distribute-filter` | Admin + CSRF | 下發系統級過濾清單至全域設定（標記為 `System`）。 |
| `DELETE` | `/api/admin/distribute-filter` | Admin + CSRF | 撤銷已下發的系統級過濾清單。 |
| `POST` | `/api/admin/distribute-filter/revoke` | Admin + CSRF | 撤銷系統級過濾清單的備選 POST 介面。 |
