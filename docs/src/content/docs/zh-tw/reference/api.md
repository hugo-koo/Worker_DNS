---
title: API / 應用程式介面
description: DNS Worker 根路徑非前端網路路徑（DoH、Linux 安裝指令碼、地圖代理、DoT/UDP）以及 /api/* HTTP / WebSocket 控制台介面參考。
---

DNS Worker 在與控制台 / Worker 相同的域名下同時提供 **根路徑 `/` 下的非前端路徑**（如基於 `/:key` 的 RFC 8484 DoH 服務、安裝指令碼與拓撲代理等），以及位於 `/api/*` 下的 **JSON REST API / WebSocket 即時介面**。

## 根路徑網路介面（`/` 下非前端路徑）

除前端頁面、靜態資源與 SPA 路由兜底（`handleAssetsRouter`）外，根路徑 `/` 下的網路請求會按以下規則直接分發至 DNS 與網路服務處理器（以下路徑均無需 Bearer JWT 或 CSRF Token）：

| 路徑 / 傳輸方式 | 方法 / 協議 | 引數與格式要求 | 說明 |
| --- | --- | --- | --- |
| `/:key` | `GET`、`POST`、`OPTIONS`（HTTPS / HTTP/2+） | `key` 匹配 `^[a-zA-Z0-9]{5,12}$`；`GET ?dns=<base64url>` 或攜帶 `Accept: application/dns-message`；`POST` 請求體為原始 DNS 二進位制報文（`application/dns-message`，Serverfull 模式上限 64 KB） | **DoH 接入端點（RFC 8484）**。優先匹配使用者級 `access_points.token`（用於裝置歸因與動態 Profile 繫結路由），其次匹配 `profiles.profile_key` 或 `profiles.id`。若匹配的接入點處於未繫結狀態（`profile_id IS NULL`），將直接回退至 `FAIL_OPEN_UPSTREAM` 解析（不匹配 `profile_key`，也不返回 `404` 且不記日誌）；系統刻意不開放無金鑰的 `/dns-query` 路徑。響應返回 `application/dns-message`、`Cache-Control: max-age=<ttl>` 與全放行 CORS 頭（`*`）。 |
| `/setup.sh` | `GET` | 查詢引數 `key` 需匹配 `^[a-zA-Z0-9]{5,12}$`，且 `Host` 須為合法 HTTP/HTTPS 來源 | 動態生成 `text/plain` 格式的 Linux 一鍵安裝指令碼（安裝 `cloudflared` 並註冊 `systemd` 服務 `cloudflared-dns.service`，將 `--upstream <origin>/<key>` 對映到本地 `53` 埠）。 |
| `/world-110m.json` | `GET` | 無 | GeoIP 世界地圖 TopoJSON 代理介面，自動補全 3 位國家數字 ID 並啟用邊緣快取（`max-age=2592000`，30 天），響應帶 `Access-Control-Allow-Origin: *`。 |

### DoH 協議約束與響應說明（`/:key`）

- **Access Key 校驗與 Durable Objects 容災**：合法的 Access Key（含 `access_points.token`、`profiles.profile_key` 與 `profiles.id`）會同步寫入基於 SQLite 的 Durable Objects（`ACCESS_KEY_DO`，分為 16 個確定性分片）。已繫結的接入點按其當前 `profile_id` 路由，未繫結接入點（`profile_id = null`）直接回退至 `FAIL_OPEN_UPSTREAM`（零日誌）；當 D1 或 Turso 下線或達到讀取配額進入 `FAIL_OPEN` 狀態時，合法 Access Key 仍可通過 DO 容災繼續完成解析，而未註冊或已吊銷的無效 Key 將被拒絕（`404 Invalid Profile Key`）。
- **HTTP/2+ 強制校驗（RFC 8484 §5.2）**：若請求以 `HTTP/1.0` 或 `HTTP/1.1` 到達（通過 `request.cf.httpProtocol` 或 `X-Http-Version` 檢測），服務端將返回 `505 HTTP Version Not Supported`。
- **CORS 預檢（`OPTIONS`）**：返回 `204 No Content`，攜帶 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type, Accept` 與 `Access-Control-Max-Age: 86400`。
- **異常與故障開放（Fail-Open）**：
  - `400 Invalid DNS Query`：非標準或損壞的 DNS 線纜格式請求報文（要求 `QR=0`、`OPCODE=0`、`QDCOUNT=1`、`QNAME <= 253` 字元）。
  - `404 Invalid Profile Key`：未匹配到有效的接入點令牌或配置檔案金鑰。
  - `413 Payload Too Large`：Serverfull HTTP 處理器拒絕超過 64 KB 的 DoH `POST` 請求體。
  - `502 Upstream Resolution Failed` / `500 Internal Server Error`：流水線或資料庫異常時會先嚐試通過 `FAIL_OPEN_UPSTREAM` 完成應急解析後再決定是否返回錯誤。

```bash
# 示例：通过 HTTP/2 POST 发送二进制 DNS 请求包到指定 Key 的 DoH 端点
curl --http2 -sS -X POST https://dns.example.com/<accessKey> \
  -H "Content-Type: application/dns-message" \
  -H "Accept: application/dns-message" \
  --data-binary @query.dns -o response.dns

# 示例：获取指定 Key 的 Linux cloudflared 一键配置脚本
curl -fsSL "https://dns.example.com/setup.sh?key=<accessKey>"
```

### 非 HTTP DNS 傳輸介面（Serverfull 模式）

在獨立部署的 Serverfull 模式下，除 HTTP / DoH 服務外還會監聽以下原生 DNS 網路埠：

- **DNS-over-TLS（DoT，RFC 7858）**：使用 ALPN `dot` 協議並要求配置泛域名證書（`*.domain`）。支援從 TLS SNI 中提取 `5–12` 位字母數字金鑰（例如 `<accessKey>.dns.example.com`）以繫結對應配置檔案或接入點；直接連線基礎域名時回退至 `resolveDefaultProfile`（`SERVERFULL_DEFAULT_PROFILE_KEY` / `DEFAULT_PROFILE_KEY` / `FAIL_OPEN_UPSTREAM`）。
- **傳統 UDP DNS（RFC 1035 / RFC 6891）**：原生 UDP 監聽器，內建單 IP 令牌桶限流（突發容量 `120` 包、速率 `60/s`），統一通過 `resolveDefaultProfile` 解析請求。

---

## 認證機制、CSRF 與前置攔截

### Bearer Token 與 Refresh Cookie

- **公開介面**無需攜帶 `Authorization` 請求頭：
  - `GET /api/auth/config`、`GET /api/auth/check-username`
  - `POST /api/auth/signup`、`POST /api/auth/prelogin`、`POST /api/auth/login`
  - `POST /api/auth/refresh`、`POST /api/auth/logout`
  - `GET|POST /api/auth/unlock-session`（在鎖屏處理器內部直接校驗 `Authorization: Bearer <accessToken>`）
  - `POST /api/auth/forgot-password/init`、`POST /api/auth/forgot-password/verify`、`POST /api/auth/forgot-password/reset`
  - `GET /api/clientinfo`、`GET /api/substitute`、`GET /api/resolve`、`GET /api/geoip`、`GET /api/icon/:domain`、`GET /api/presets/*`
- **受保護介面**必須在請求頭中攜帶 `Authorization: Bearer <accessToken>`。令牌缺失或無效時返回 `401 Unauthorized`。
- **重新整理流程**：`POST /api/auth/login` 與 `POST /api/auth/signup` 會下發 `HttpOnly` 的 `refresh_token` Cookie，客戶端隨後可呼叫 `POST /api/auth/refresh` 換取新的 Access Token。

### 雙重提交 CSRF 防護（Double-Submit）

所有已認證的變更類請求（`POST`、`PUT`、`PATCH`、`DELETE`），以及攜帶 Refresh Cookie 發起的 `POST /api/auth/refresh` 和 `POST /api/auth/logout`，均受雙重提交 CSRF 校驗保護：

1. 服務端響應會寫入 `csrf_token` Cookie。
2. 客戶端發起變更請求時，必須在請求頭 `X-CSRF-Token` 中攜帶一致的值。
3. 缺失或不匹配時將返回 `403 Forbidden`（`CSRF validation failed`）。

### 會話鎖定（Paused / Locked Sessions）

當通過 `POST /api/auth/lock-session` 鎖定會話後，後續已認證 API 請求將返回 `403`（`session_paused`），僅放行以下介面：

- `GET|POST /api/auth/unlock-session`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `PATCH /api/account/me`（僅限修改 `locale` 語言欄位）

### 就緒檢查、配額門控與常見狀態碼

| 狀態碼 | 含義 | 說明 |
| --- | --- | --- |
| `400` | Bad Request | JSON 請求體格式錯誤、缺少必填引數或欄位校驗未通過 |
| `401` | Unauthorized | 缺少 Bearer Token，或會話已過期 / 被吊銷 |
| `403` | Forbidden | CSRF 校驗失敗、`session_paused` 鎖定中、缺少二次高危認證，或非管理員呼叫 `/api/admin/*` |
| `503` | Service Unavailable | `error: "configuration_error"`（資料庫或 `JWT_SECRET` 未就緒）或 `error: "database_quota_exceeded"`（Turso 讀取配額耗盡；此時 DoH 故障開放解析仍保持可用） |

---

## 快速示例（`curl`）

```bash
# 1. 登录并保存 Cookie（包含 refresh_token 与 csrf_token）
curl -s -c cookies.txt -X POST https://dns.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'

# 从 cookies.txt 提取 CSRF Token，并将登录响应中的 accessToken 赋值给 ACCESS_TOKEN
CSRF=$(awk '$6=="csrf_token"{print $7}' cookies.txt)

# 2. 获取配置文件列表
curl -s -b cookies.txt https://dns.example.com/api/profiles \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 3. 测试指定配置文件的域名规则匹配（变更类请求必须携带 X-CSRF-Token）
curl -s -b cookies.txt -X POST https://dns.example.com/api/profiles/<profileId>/test \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"domain":"ads.example.com","type":"A"}'
```

---

## 身份認證（`/api/auth/*`）

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/auth/config` | Public | 返回公開認證配置（是否開放註冊、Turnstile Site Key、執行模式標識等）。 |
| `GET` | `/api/auth/check-username?username=...` | Public | 註冊前檢查使用者名稱是否可用及密碼策略元資訊。 |
| `POST` | `/api/auth/signup` | Public | 註冊新賬戶並簽發 Access / Refresh Token。 |
| `POST` | `/api/auth/prelogin` | Public | 查詢目標使用者的登入方式（Passkey、MFA、無密碼登入狀態等）。 |
| `POST` | `/api/auth/login` | Public | 使用密碼、Passkey 斷言或 TOTP / MFA 完成登入並寫入會話 Cookie。 |
| `POST` | `/api/auth/refresh` | Cookie + CSRF | 輪換 `refresh_token` Cookie 並返回新的短期 Access Token。 |
| `POST` | `/api/auth/logout` | Cookie + CSRF | 登出當前會話並清理認證 Cookie。 |
| `GET` | `/api/auth/unlock-session` | Bearer | 獲取當前會話鎖定狀態及可用解鎖方式（PIN / Passkey / 密碼）。 |
| `POST` | `/api/auth/unlock-session` | Bearer | 使用 PIN、Passkey 或密碼解鎖已暫停的會話。 |
| `POST` | `/api/auth/lock-session` | Bearer + CSRF | 將當前會話標記為鎖定（Paused）狀態。 |
| `POST` | `/api/auth/forgot-password/init` | Public | 初始化找回密碼流程。 |
| `POST` | `/api/auth/forgot-password/verify` | Public | 校驗找回密碼恢復金鑰或挑戰資訊。 |
| `POST` | `/api/auth/forgot-password/reset` | Public | 完成密碼重置並更新相關憑據狀態。 |

---

## 系統與公共工具（`/api/*`）

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/clientinfo` | Public | 返回探測到的客戶端 IP 與請求網路資訊。 |
| `GET` | `/api/substitute` | Public | 返回部署元資訊、執行模式（`serverfull` 或 Worker）及版本號。 |
| `GET` | `/api/presets/upstreams` | Public | 獲取內建上游 DoH/DoT 解析器預設列表。 |
| `GET` | `/api/presets/filters` | Public | 獲取預設過濾規則列表 URL 與分類。 |
| `GET` | `/api/presets/ech-fronting-domains` | Public | 獲取預設 ECH / Fronting 域名列表。 |
| `GET` | `/api/icon/:domain` | Public | 代理獲取目標域名的站點圖示（Favicon）。 |
| `GET` | `/api/geoip?ip=...` | Public | 查詢指定 IP 的 GeoIP 地理位置與 ASN 資訊。 |
| `GET` | `/api/resolve?name=...` | Public | 執行 DNS 記錄解析查詢（支援 `name` 或 `domain` 查詢引數）。 |

---

## 賬戶與安全（`/api/account/*`）

### 個人資料、審計日誌與會話管理

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/account/me` | Bearer | 獲取當前賬戶資訊、角色、偏好設定（`locale`）及安全狀態摘要。 |
| `PATCH` | `/api/account/me` | Bearer + CSRF | 更新賬戶偏好設定（如 `locale`；鎖屏狀態下僅允許更新 `locale`）。 |
| `DELETE` | `/api/account/me` | Bearer + CSRF | 登出並刪除當前賬戶（需先通過高危二次認證 Step-up Reauth）。 |
| `POST` | `/api/account/delete` | Bearer + CSRF | 刪除賬戶的備選 POST 介面（需 Step-up Reauth）。 |
| `DELETE` | `/api/account/logs` | Bearer + CSRF | 清空當前使用者旗下所有配置檔案的 DNS 查詢日誌。 |
| `GET` | `/api/account/activity?limit=&before=` | Bearer | 分頁查詢賬戶安全審計事件記錄。 |
| `GET` | `/api/account/sessions` | Bearer | 列出當前賬戶所有活躍會話。 |
| `DELETE` | `/api/account/sessions/others` | Bearer + CSRF | 踢出除當前會話外的所有其他會話。 |
| `DELETE` | `/api/account/sessions/:id` | Bearer + CSRF | 按會話 ID 登出指定會話。 |

### 憑據、MFA、Passkeys 與恢復金鑰

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `POST` | `/api/account/password` | Bearer + CSRF | 修改賬戶登入密碼（需 Step-up Reauth）。 |
| `POST` | `/api/account/migrate-password` | Bearer + CSRF | 遷移或升級密碼雜湊版本。 |
| `POST` | `/api/account/pin` | Bearer + CSRF | 設定或更新會話快速鎖屏 PIN 碼。 |
| `DELETE` | `/api/account/pin` | Bearer + CSRF | 移除會話鎖屏 PIN 碼。 |
| `POST` | `/api/account/recovery-keys/rotate` | Bearer + CSRF | 輪換並生成新的一次性恢復金鑰，舊金鑰隨即失效。 |
| `GET` | `/api/account/totp/setup` | Bearer | 生成 TOTP 金鑰及 `otpauth://` 配置 URI。 |
| `POST` | `/api/account/totp/confirm` | Bearer + CSRF | 校驗動態驗證碼並正式啟用 TOTP。 |
| `POST` | `/api/account/totp/test` | Bearer + CSRF | 測試當前輸入的 TOTP 驗證碼是否有效。 |
| `PATCH` | `/api/account/totp/settings` | Bearer + CSRF | 更新 MFA 與無密碼登入開關（與 `/api/account/mfa/settings` 共用處理邏輯）。 |
| `DELETE` | `/api/account/totp` | Bearer + CSRF | 關閉並解除當前賬戶的 TOTP 兩步驗證。 |
| `PATCH` | `/api/account/mfa/settings` | Bearer + CSRF | 更新 MFA / 無密碼登入安全策略設定。 |
| `GET` | `/api/account/passkeys` | Bearer | 列出已繫結的 WebAuthn Passkeys。 |
| `POST` | `/api/account/passkeys/auth-options` | Bearer + CSRF | 下發用於二次校驗或測試的 WebAuthn 認證挑戰選項。 |
| `POST` | `/api/account/passkeys/test` | Bearer + CSRF | 驗證 Passkey 斷言（不修改憑據）。 |
| `POST` | `/api/account/passkeys/register/options` | Bearer + CSRF | 下發註冊新 Passkey 所需的 WebAuthn 註冊選項。 |
| `POST` | `/api/account/passkeys/register/verify` | Bearer + CSRF | 校驗新 Passkey 註冊憑據並儲存。 |
| `PATCH` | `/api/account/passkeys/:id` | Bearer + CSRF | 重新命名已繫結的 Passkey。 |
| `DELETE` | `/api/account/passkeys/:id` | Bearer + CSRF | 刪除已繫結的 Passkey。 |

### 使用者級過濾列表與賬戶 E2EE

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/account/user-lists` | Bearer | 獲取賬戶級過濾列表（自動繼承至名下所有配置檔案）。 |
| `POST` | `/api/account/user-lists` | Bearer + CSRF | 新增使用者級過濾列表。 |
| `PATCH` | `/api/account/user-lists/:id` | Bearer + CSRF | 更新使用者級過濾列表狀態（如啟用 / 停用）。 |
| `DELETE` | `/api/account/user-lists/:id` | Bearer + CSRF | 刪除使用者級過濾列表。 |
| `GET` | `/api/account/e2ee/status` | Bearer | 查詢賬戶級 E2EE 狀態與金鑰封裝情況。 |
| `GET` | `/api/account/e2ee/wrapped-key` | Bearer | 獲取使用密碼 / Passkey PRF 封裝的資料加密金鑰（DEK）。 |
| `GET` | `/api/account/e2ee/recovery-wrapped-key` | Bearer | 獲取使用恢復金鑰封裝的 DEK。 |
| `POST` | `/api/account/e2ee/init` | Bearer + CSRF | 初始化賬戶 E2EE 封裝金鑰。 |
| `POST` | `/api/account/e2ee/wrap` | Bearer + CSRF | 追加儲存 DEK 的新封裝副本（例如繫結新 Passkey PRF 時）。 |
| `POST` | `/api/account/e2ee/wrap-recovery` | Bearer + CSRF | 儲存由恢復金鑰封裝的 DEK 副本。 |
| `POST` | `/api/account/e2ee/enable` | Bearer + CSRF | 在賬戶上啟用 E2EE 加密模式。 |
| `DELETE` | `/api/account/e2ee` | Bearer + CSRF | 停用賬戶 E2EE（傳入 `?purge=true` 可一併清理密文資料）。 |

---

## 配置檔案（`/api/profiles/*`）

### 核心配置、引數與測試

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles` | Bearer | 列出當前使用者擁有的所有 DNS 配置檔案。 |
| `POST` | `/api/profiles` | Bearer + CSRF | 建立新的 DNS 配置檔案並生成預設 DoH 金鑰。 |
| `GET` | `/api/profiles/:id` | Bearer | 獲取指定配置檔案的完整配置詳情。 |
| `PATCH` | `/api/profiles/:id` | Bearer + CSRF | 更新配置檔案基本資訊（如重新命名，帶同使用者重名校驗）。 |
| `DELETE` | `/api/profiles/:id` | Bearer + CSRF | 刪除配置檔案及其規則、列表與日誌；原繫結的接入點保留並解綁（`profile_id = NULL`，自動回退 Fail-Open）並清理快取。 |
| `POST` | `/api/profiles/:id/rotate_key` | Bearer + CSRF | 輪換配置檔案主 DoH 接入金鑰（`/:key`）。 |
| `PATCH` | `/api/profiles/:id/settings` | Bearer + CSRF | 更新解析器進階設定（上游 DoH/DoT、ECS、ECH、日誌隱私與快取選項等）。 |
| `POST` | `/api/profiles/:id/test` | Bearer + CSRF | 模擬測試 `{ "domain": "...", "type": "A" }` 的規則與列表命中結果（`domain` 最長 253 字元，`type` 預設為 `A`）。 |

### 接入點（使用者級解耦管理與動態繫結）

接入點（Access Points）直接歸屬於當前認證使用者（`owner_id`），可隨時繫結、切換或解綁目標 `profile_id`（`string | null`）：

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/access_points` | Bearer | 列出當前使用者擁有的所有接入點及其當前繫結的 `profile_id`（未繫結為 `null`）。 |
| `POST` | `/api/access_points` | Bearer + CSRF | 建立新的使用者級接入點（`{ "name": "...", "profile_id"?: string \| null }`），可選初始繫結 Profile。 |
| `PATCH` | `/api/access_points/:apId` | Bearer + CSRF | 重新命名接入點或動態切換/解綁 `profile_id`（`string \| null`），並立即清理 L1/L2、Cluster 與 DO 快取。 |
| `POST` | `/api/access_points/:apId/rotate_token` | Bearer + CSRF | 輪換接入點 DoH Token 並吊銷舊令牌快取。 |
| `DELETE` | `/api/access_points/:apId` | Bearer + CSRF | 永久刪除使用者擁有的接入點並清理對應快取。 |

同時保留 `/api/profiles/:id/access_points`（`GET`、`POST`、`PATCH /:apId`、`POST /:apId/rotate_token`、`DELETE /:apId`）作為按當前繫結 Profile 作用域篩選的相容介面（供日誌/統計篩選或按指定 Profile 建立場景使用）。

### 自定義規則

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/rules` | Bearer | 列出配置檔案的放行、攔截與重寫規則。 |
| `POST` | `/api/profiles/:id/rules` | Bearer + CSRF | 新增單條規則或批次匯入多條規則。 |
| `PUT` | `/api/profiles/:id/rules` | Bearer + CSRF | 覆蓋或更新配置檔案下的自定義規則。 |
| `DELETE` | `/api/profiles/:id/rules` | Bearer + CSRF | 刪除一條或多條自定義規則。 |

### 過濾列表

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/lists` | Bearer | 獲取配置檔案關聯的過濾列表（含配置檔案級、使用者級 `User` 與系統級 `System` 標籤）。 |
| `GET` | `/api/profiles/:id/lists/sync-status` | Bearer | 查詢各過濾列表的最近同步時間、規則條目數及異常狀態。 |
| `GET` | `/api/profiles/:id/lists/:listId/check?domain=...` | Bearer | 檢查指定域名是否命中該過濾列表。 |
| `POST` | `/api/profiles/:id/lists` | Bearer + CSRF | 向配置檔案新增單個或批次外部過濾列表 URL。 |
| `PATCH` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | 啟用、停用或修改過濾列表掛載配置。 |
| `POST` | `/api/profiles/:id/lists/sync` | Bearer + CSRF | 立即同步該配置檔案下的所有可用過濾列表。 |
| `POST` | `/api/profiles/:id/lists/:listId/sync` | Bearer + CSRF | 立即同步單個過濾列表。 |
| `DELETE` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | 從配置檔案移除配置檔案級過濾列表。 |

### 查詢日誌、即時推送與統計分析

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/logs` | Bearer | 分頁檢索 DNS 查詢日誌（支援狀態、域名、客戶端、時間區間過濾）。 |
| `GET` | `/api/profiles/:id/logs/export` | Bearer | 匯出配置檔案的查詢日誌。 |
| `GET` | `/api/profiles/:id/logs/:logId` | Bearer | 查詢單條日誌記錄詳情。 |
| `DELETE` | `/api/profiles/:id/logs` | Bearer + CSRF | 清空該配置檔案下儲存的查詢日誌。 |
| `POST` | `/api/profiles/:id/logs/ws-ticket` | Bearer + CSRF | 簽發一次性短期 Ticket，用於建立即時日誌 WebSocket 連線。 |
| `GET` (WS) | `/api/profiles/:id/logs/ws` | Ticket | WebSocket 升級端點，用於即時接收 DNS 查詢事件流。 |
| `GET` | `/api/profiles/:id/analytics` | Bearer | 獲取配置檔案綜合統計分析概覽。 |
| `GET` | `/api/profiles/:id/analytics/summary` | Bearer | 獲取請求總數、攔截量、快取命中及響應延遲彙總。 |
| `GET` | `/api/profiles/:id/analytics/trend` | Bearer | 獲取按時間分桶的查詢趨勢與攔截率資料。 |
| `GET` | `/api/profiles/:id/analytics/top_allowed` | Bearer | 獲取最常放行的域名排行榜。 |
| `GET` | `/api/profiles/:id/analytics/top_blocked` | Bearer | 獲取最常攔截的域名排行榜。 |
| `GET` | `/api/profiles/:id/analytics/clients` | Bearer | 按客戶端 IP / 接入點統計查詢分佈。 |
| `GET` | `/api/profiles/:id/analytics/destinations` | Bearer | 按目標國家 / GeoIP 統計流量分佈。 |
| `GET` | `/api/profiles/:id/analytics/isps` | Bearer | 按目標 ASN / ISP 運營商統計查詢分佈。 |

### 配置檔案級 E2EE

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/e2ee/status` | Bearer | 查詢該配置檔案是否已啟用獨立 E2EE。 |
| `GET` | `/api/profiles/:id/e2ee/wrapped-key` | Bearer | 獲取該配置檔案已封裝的加密金鑰。 |
| `POST` | `/api/profiles/:id/e2ee/init` | Bearer + CSRF | 初始化配置檔案級 E2EE 金鑰。 |
| `POST` | `/api/profiles/:id/e2ee/wrap` | Bearer + CSRF | 更新或追加配置檔案金鑰封裝副本。 |
| `DELETE` | `/api/profiles/:id/e2ee` | Bearer + CSRF | 停用配置檔案級 E2EE。 |

---

## 系統管理（`/api/admin/*`）

所有 `/api/admin/*` 介面均要求當前已認證使用者具備 `role === 'admin'` 許可權，否則返回 `403 Forbidden`。

| 方法 | 路徑 | 許可權 | 說明 |
| --- | --- | --- | --- |
| `GET` | `/api/admin/users` | Admin | 列出所有已註冊使用者及其配額使用情況。 |
| `POST` | `/api/admin/users` | Admin + CSRF | 以管理員身份建立新使用者賬戶。 |
| `DELETE` | `/api/admin/users/:id` | Admin + CSRF | 刪除指定使用者賬戶及其名下資源。 |
| `GET` | `/api/admin/settings` | Admin | 獲取全域性系統設定（Turnstile、註冊開關、配額限制等）。 |
| `PATCH` | `/api/admin/settings` | Admin + CSRF | 更新全域性系統設定。 |
| `GET` | `/api/admin/database` | Admin | 檢查資料庫驅動型別、遷移狀態、Schema 就緒情況及執行模式（`serverfull` 或 Worker）。 |
| `POST` | `/api/admin/database/migrate` | Admin + CSRF | 執行待處理的資料庫 Schema 遷移。 |
| `GET` | `/api/admin/distribute-filter` | Admin | 列出當前生效的系統級下發過濾列表。 |
| `POST` | `/api/admin/distribute-filter` | Admin + CSRF | 下發系統級過濾列表至全域性配置（標記為 `System`）。 |
| `DELETE` | `/api/admin/distribute-filter` | Admin + CSRF | 撤銷已下發的系統級過濾列表。 |
| `POST` | `/api/admin/distribute-filter/revoke` | Admin + CSRF | 撤銷系統級過濾列表的備選 POST 介面。 |
