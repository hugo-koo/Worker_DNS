---
title: API Reference
description: Network and API reference for DNS Worker root non-frontend paths (DoH, Linux setup script, map proxy, DoT/UDP) and HTTP/WebSocket /api/* routes.
---

DNS Worker exposes both **root-level non-frontend paths** (such as RFC 8484 DNS-over-HTTPS under `/:key`, plus provisioning/map endpoints) and a **JSON REST / WebSocket API** under `/api/*` on the same origin as your Worker / Serverfull deployment.

## Root Network Interfaces (`/` Non-Frontend Paths)

Aside from frontend pages, static assets, and SPA fallback (`handleAssetsRouter`), requests under `/` are dispatched directly to the DNS and network helper handlers below (none of these require Bearer JWTs or CSRF tokens):

| Path / Transport | Method / Protocol | Parameters & Format | Description |
| --- | --- | --- | --- |
| `/:key` | `GET`, `POST`, `OPTIONS` (HTTPS / HTTP/2+) | `key` matches `^[a-zA-Z0-9]{5,12}$`; `GET ?dns=<base64url>` or `Accept: application/dns-message`; `POST` raw wire DNS packet (`application/dns-message`, max 64 KB in Serverfull) | **DoH endpoint (RFC 8484)**. Resolves `key` first against `access_points.token` (for per-device attribution), then `profiles.profile_key` or `profiles.id`. Bare `/dns-query` is intentionally unsupported. Returns `application/dns-message` with `Cache-Control: max-age=<ttl>` and permissive CORS (`*`). |
| `/setup.sh` | `GET` | Query parameter `key` matching `^[a-zA-Z0-9]{5,12}$` (and valid HTTP/HTTPS `Host` header) | Generates a `text/plain` bash installer script (`cloudflared` + `systemd` `cloudflared-dns.service`) preconfigured with `--upstream <origin>/<key>` on local port `53`. |
| `/world-110m.json` | `GET` | None | Edge-cached (`max-age=2592000`, 30 days) GeoIP TopoJSON world map proxy with 3-digit zero-padded country IDs and `Access-Control-Allow-Origin: *`. |

### DoH Protocol Behavior (`/:key`)

- **Access Key Verification & Durable Objects Fail-Open**: Legitimate Access Keys (`access_points.token`, `profiles.profile_key`, and `profiles.id`) are synchronized into SQLite-backed Durable Objects (`ACCESS_KEY_DO`, partitioned into 16 deterministic shards). If D1 or Turso goes offline or hits read quota (`FAIL_OPEN` state), valid Access Keys remain usable via `FAIL_OPEN_UPSTREAM` with profile/access-point attribution preserved, while unregistered or revoked keys are rejected (`404 Invalid Profile Key`).
- **HTTP/2+ Requirement (RFC 8484 §5.2)**: Requests arriving over `HTTP/1.0` or `HTTP/1.1` (via `request.cf.httpProtocol` or `X-Http-Version`) are rejected with `505 HTTP Version Not Supported`.
- **CORS Preflight (`OPTIONS`)**: Returns `204 No Content` with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Accept`, and `Access-Control-Max-Age: 86400`.
- **Error & Fail-Open Responses**:
  - `400 Invalid DNS Query`: Malformed or non-standard wire-format DNS query packet (`QR=0`, `OPCODE=0`, `QDCOUNT=1`, valid `QNAME <= 253` chars).
  - `404 Invalid Profile Key`: No matching access point token or profile key found.
  - `413 Payload Too Large`: Serverfull HTTP handler rejects DoH `POST` bodies larger than 64 KB.
  - `502 Upstream Resolution Failed` / `500 Internal Server Error`: Pipeline/database failure triggers an emergency `FAIL_OPEN_UPSTREAM` resolution attempt before returning an error status.

```bash
# Example: Query DoH over HTTP/2 POST using a wire-format DNS packet
curl --http2 -sS -X POST https://dns.example.com/<accessKey> \
  -H "Content-Type: application/dns-message" \
  -H "Accept: application/dns-message" \
  --data-binary @query.dns -o response.dns

# Example: Download the cloudflared Linux setup script for a profile/access point key
curl -fsSL "https://dns.example.com/setup.sh?key=<accessKey>"
```

### Non-HTTP DNS Transports (Serverfull Mode)

When running in standalone Serverfull mode, DNS Worker also exposes native non-HTTP DNS listeners alongside the Web/DoH HTTP server:

- **DNS-over-TLS (`DoT`, RFC 7858)**: TLS listener with ALPN `dot` and a required wildcard TLS certificate (`*.domain`). Extracts the `5–12` alphanumeric key from TLS SNI (e.g. `<accessKey>.dns.example.com`), or falls back to `resolveDefaultProfile` (`SERVERFULL_DEFAULT_PROFILE_KEY` / `DEFAULT_PROFILE_KEY` / `FAIL_OPEN_UPSTREAM`) when connecting to the bare base domain.
- **Classic UDP DNS (RFC 1035 / RFC 6891)**: UDP listener with per-IP token-bucket rate limiting (`120` packet burst, `60/s` refill), resolving through `resolveDefaultProfile`.

---

## Authentication, CSRF & Error Gates

### Bearer Token & Refresh Cookie

- **Public endpoints** require no `Authorization` header:
  - `GET /api/auth/config`, `GET /api/auth/check-username`
  - `POST /api/auth/signup`, `POST /api/auth/prelogin`, `POST /api/auth/login`
  - `POST /api/auth/refresh`, `POST /api/auth/logout`
  - `GET|POST /api/auth/unlock-session` (checks `Authorization: Bearer <accessToken>` directly in the lock handler)
  - `POST /api/auth/forgot-password/init`, `POST /api/auth/forgot-password/verify`, `POST /api/auth/forgot-password/reset`
  - `GET /api/clientinfo`, `GET /api/substitute`, `GET /api/resolve`, `GET /api/geoip`, `GET /api/icon/:domain`, `GET /api/presets/*`
- **Authenticated endpoints** require `Authorization: Bearer <accessToken>` in the request headers. Missing or invalid tokens return `401 Unauthorized`.
- **Refresh flow**: `POST /api/auth/login` and `POST /api/auth/signup` set an `HttpOnly` `refresh_token` cookie, which `POST /api/auth/refresh` exchanges for a fresh access token.

### Double-Submit CSRF Protection

State-changing authenticated requests (`POST`, `PUT`, `PATCH`, `DELETE`), as well as `POST /api/auth/refresh` and `POST /api/auth/logout` when a refresh cookie is present, enforce double-submit CSRF validation:

1. Responses from the server set the `csrf_token` cookie.
2. Client mutations must send the matching value in the `X-CSRF-Token` request header.
3. Missing or mismatched tokens return `403 Forbidden` (`CSRF validation failed`).

### Paused (Locked) Sessions

When a session is locked via `POST /api/auth/lock-session`, subsequent authenticated API requests return `403` with `session_paused`, except:

- `GET|POST /api/auth/unlock-session`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `PATCH /api/account/me` (restricted to updating `locale` only)

### Readiness, Quota & RBAC Status Codes

| Status | Meaning | Notes |
| --- | --- | --- |
| `400` | Bad Request | Invalid JSON body, missing required fields, or validation failure |
| `401` | Unauthorized | Missing, expired, or revoked Bearer / session token |
| `403` | Forbidden | CSRF mismatch, `session_paused`, step-up re-authentication required, or non-admin calling `/api/admin/*` |
| `503` | Service Unavailable | `error: "configuration_error"` (DB / `JWT_SECRET` not ready) or `error: "database_quota_exceeded"` (Turso read quota reached; DoH resolution fail-open continues) |

---

## Quick Example (`curl`)

```bash
# 1. Sign in and capture cookies (refresh_token + csrf_token)
curl -s -c cookies.txt -X POST https://dns.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'

# Extract CSRF token from cookies.txt and set ACCESS_TOKEN from the login JSON response
CSRF=$(awk '$6=="csrf_token"{print $7}' cookies.txt)

# 2. List profiles
curl -s -b cookies.txt https://dns.example.com/api/profiles \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# 3. Trigger a rule lookup test on a profile (requires X-CSRF-Token on mutations)
curl -s -b cookies.txt -X POST https://dns.example.com/api/profiles/<profileId>/test \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"domain":"ads.example.com","type":"A"}'
```

---

## Authentication (`/api/auth/*`)

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/auth/config` | Public | Returns public auth configuration (registration enabled, Turnstile site key, deployment mode flags). |
| `GET` | `/api/auth/check-username?username=...` | Public | Checks username availability and password-policy metadata before signup. |
| `POST` | `/api/auth/signup` | Public | Registers a new account and issues access + refresh tokens. |
| `POST` | `/api/auth/prelogin` | Public | Inspects login requirements for a username (e.g., passkey / MFA / passwordless status). |
| `POST` | `/api/auth/login` | Public | Authenticates via password, passkey assertion, or TOTP / MFA step and sets session cookies. |
| `POST` | `/api/auth/refresh` | Cookie + CSRF | Rotates the `refresh_token` cookie and returns a new short-lived access token. |
| `POST` | `/api/auth/logout` | Cookie + CSRF | Revokes the active session and clears auth cookies. |
| `GET` | `/api/auth/unlock-session` | Bearer | Checks session lock state and available unlock methods (PIN / passkey / password). |
| `POST` | `/api/auth/unlock-session` | Bearer | Unlocks a paused session with PIN, passkey, or password. |
| `POST` | `/api/auth/lock-session` | Bearer + CSRF | Marks the current session as paused (screen lock). |
| `POST` | `/api/auth/forgot-password/init` | Public | Starts password recovery flow for an account. |
| `POST` | `/api/auth/forgot-password/verify` | Public | Verifies recovery key / challenge during password reset. |
| `POST` | `/api/auth/forgot-password/reset` | Public | Completes password reset and optionally wraps/rotates credentials. |

---

## System & Utility (`/api/*`)

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/clientinfo` | Public | Returns detected client IP and request network metadata. |
| `GET` | `/api/substitute` | Public | Returns deployment metadata, runtime mode (`serverfull` vs Worker), and version info. |
| `GET` | `/api/presets/upstreams` | Public | Lists built-in upstream DoH/DoT resolver presets. |
| `GET` | `/api/presets/filters` | Public | Lists curated preset filter-list URLs and categories. |
| `GET` | `/api/presets/ech-fronting-domains` | Public | Lists preset ECH/fronting domains. |
| `GET` | `/api/icon/:domain` | Public | Fetches/proxies the favicon for a domain. |
| `GET` | `/api/geoip?ip=...` | Public | Resolves GeoIP location / ASN metadata for an IP address. |
| `GET` | `/api/resolve?name=...` | Public | Queries DNS record resolution (`name` or `domain` query parameter). |

---

## Account & Security (`/api/account/*`)

### Profile, Activity & Sessions

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/account/me` | Bearer | Returns current user profile, role, preferences (`locale`), and security summary. |
| `PATCH` | `/api/account/me` | Bearer + CSRF | Updates account settings (such as `locale`; `locale`-only updates remain allowed when paused). |
| `DELETE` | `/api/account/me` | Bearer + CSRF | Deletes the current user account (requires step-up re-authentication). |
| `POST` | `/api/account/delete` | Bearer + CSRF | Alternative POST endpoint for account deletion with step-up re-authentication. |
| `DELETE` | `/api/account/logs` | Bearer + CSRF | Purges DNS query logs across all profiles owned by the user. |
| `GET` | `/api/account/activity?limit=&before=` | Bearer | Lists paginated account security and audit events. |
| `GET` | `/api/account/sessions` | Bearer | Lists active sessions for the current user. |
| `DELETE` | `/api/account/sessions/others` | Bearer + CSRF | Revokes all sessions except the current one. |
| `DELETE` | `/api/account/sessions/:id` | Bearer + CSRF | Revokes a specific session by ID. |

### Credentials, MFA, Passkeys & Recovery Keys

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/account/password` | Bearer + CSRF | Changes account password (step-up re-authentication required). |
| `POST` | `/api/account/migrate-password` | Bearer + CSRF | Migrates/upgrades password hashing format. |
| `POST` | `/api/account/pin` | Bearer + CSRF | Sets or updates the quick-lock session PIN. |
| `DELETE` | `/api/account/pin` | Bearer + CSRF | Removes the session lock PIN. |
| `POST` | `/api/account/recovery-keys/rotate` | Bearer + CSRF | Generates a fresh set of single-use recovery keys, invalidating prior keys. |
| `GET` | `/api/account/totp/setup` | Bearer | Generates TOTP provisioning secret and `otpauth://` URI. |
| `POST` | `/api/account/totp/confirm` | Bearer + CSRF | Verifies an authenticator code to enable TOTP. |
| `POST` | `/api/account/totp/test` | Bearer + CSRF | Tests a TOTP code against the enrolled secret. |
| `PATCH` | `/api/account/totp/settings` | Bearer + CSRF | Updates MFA / passwordless login flags (shares handler with `/api/account/mfa/settings`). |
| `DELETE` | `/api/account/totp` | Bearer + CSRF | Disables TOTP MFA for the account. |
| `PATCH` | `/api/account/mfa/settings` | Bearer + CSRF | Updates MFA / passwordless login preferences. |
| `GET` | `/api/account/passkeys` | Bearer | Lists enrolled WebAuthn passkeys. |
| `POST` | `/api/account/passkeys/auth-options` | Bearer + CSRF | Issues WebAuthn assertion options for step-up verification or testing. |
| `POST` | `/api/account/passkeys/test` | Bearer + CSRF | Verifies a passkey assertion without mutating credentials. |
| `POST` | `/api/account/passkeys/register/options` | Bearer + CSRF | Issues WebAuthn registration options for a new passkey. |
| `POST` | `/api/account/passkeys/register/verify` | Bearer + CSRF | Verifies attestation and stores a new passkey. |
| `PATCH` | `/api/account/passkeys/:id` | Bearer + CSRF | Renames an enrolled passkey. |
| `DELETE` | `/api/account/passkeys/:id` | Bearer + CSRF | Deletes an enrolled passkey. |

### User-Level Filter Lists & Account E2EE

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/account/user-lists` | Bearer | Lists account-wide filter lists inherited across all user profiles. |
| `POST` | `/api/account/user-lists` | Bearer + CSRF | Adds a user-level filter list. |
| `PATCH` | `/api/account/user-lists/:id` | Bearer + CSRF | Updates a user-level filter list (e.g., enabled state). |
| `DELETE` | `/api/account/user-lists/:id` | Bearer + CSRF | Removes a user-level filter list. |
| `GET` | `/api/account/e2ee/status` | Bearer | Returns account-level E2EE state and wrapped-key availability. |
| `GET` | `/api/account/e2ee/wrapped-key` | Bearer | Retrieves the wrapped Data Encryption Key (DEK) for password/PRF unwrap. |
| `GET` | `/api/account/e2ee/recovery-wrapped-key` | Bearer | Retrieves the recovery-wrapped DEK. |
| `POST` | `/api/account/e2ee/init` | Bearer + CSRF | Initializes account E2EE wrapped key material. |
| `POST` | `/api/account/e2ee/wrap` | Bearer + CSRF | Stores an additional wrapped copy of the DEK (e.g., passkey PRF wrap). |
| `POST` | `/api/account/e2ee/wrap-recovery` | Bearer + CSRF | Stores a recovery-key-wrapped copy of the DEK. |
| `POST` | `/api/account/e2ee/enable` | Bearer + CSRF | Activates E2EE enforcement on the account. |
| `DELETE` | `/api/account/e2ee` | Bearer + CSRF | Disables account E2EE (pass `?purge=true` to purge encrypted blobs). |

---

## Profiles (`/api/profiles/*`)

### Core Profiles, Settings & Testing

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles` | Bearer | Lists all DNS profiles owned by the authenticated user. |
| `POST` | `/api/profiles` | Bearer + CSRF | Creates a new DNS profile with its DoH key. |
| `GET` | `/api/profiles/:id` | Bearer | Fetches full configuration for a profile. |
| `PATCH` | `/api/profiles/:id` | Bearer + CSRF | Updates profile metadata (such as name). |
| `DELETE` | `/api/profiles/:id` | Bearer + CSRF | Deletes a profile and its associated rules, lists, and logs. |
| `POST` | `/api/profiles/:id/rotate_key` | Bearer + CSRF | Rotates the profile's primary DoH endpoint key (`/:key`). |
| `PATCH` | `/api/profiles/:id/settings` | Bearer + CSRF | Updates resolver settings (upstream DoH/DoT, ECS, ECH, logging toggles, cache, etc.). |
| `POST` | `/api/profiles/:id/test` | Bearer + CSRF | Simulates DNS rule/list evaluation for `{ "domain": "...", "type": "A" }` (`domain` max 253 chars, `type` defaults to `A`). |

### Access Points

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/access_points` | Bearer | Lists per-device/named DoH access points under a profile. |
| `POST` | `/api/profiles/:id/access_points` | Bearer + CSRF | Creates a new named access point token for client attribution. |
| `POST` | `/api/profiles/:id/access_points/:apId/rotate_token` | Bearer + CSRF | Rotates an access point's DoH token. |
| `PATCH` | `/api/profiles/:id/access_points/:apId` | Bearer + CSRF | Updates an access point's label or enabled state. |
| `DELETE` | `/api/profiles/:id/access_points/:apId` | Bearer + CSRF | Deletes an access point. |

### Custom Rules

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/rules` | Bearer | Lists custom allow/block/rewrite rules for the profile. |
| `POST` | `/api/profiles/:id/rules` | Bearer + CSRF | Creates a single rule or bulk-imports multiple rules. |
| `PUT` | `/api/profiles/:id/rules` | Bearer + CSRF | Replaces or updates rules on the profile. |
| `DELETE` | `/api/profiles/:id/rules` | Bearer + CSRF | Deletes one or more rules on the profile. |

### Filter Lists

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/lists` | Bearer | Lists profile-level, user-level (`User`), and distributed system-level (`System`) filter lists attached to the profile. |
| `GET` | `/api/profiles/:id/lists/sync-status` | Bearer | Returns sync timestamps, entry counts, and error status for attached lists. |
| `GET` | `/api/profiles/:id/lists/:listId/check?domain=...` | Bearer | Checks whether `domain` matches a specific filter list. |
| `POST` | `/api/profiles/:id/lists` | Bearer + CSRF | Adds one or more filter list URLs to the profile. |
| `PATCH` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | Enables/disables or updates a filter list attachment on the profile. |
| `POST` | `/api/profiles/:id/lists/sync` | Bearer + CSRF | Synchronizes all eligible filter lists for the profile. |
| `POST` | `/api/profiles/:id/lists/:listId/sync` | Bearer + CSRF | Synchronizes a single filter list immediately. |
| `DELETE` | `/api/profiles/:id/lists/:listId` | Bearer + CSRF | Detaches/deletes a profile-level filter list. |

### Query Logs, Live Stream & Analytics

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/logs` | Bearer | Queries paginated DNS query logs (supports filters such as status, domain, client, date range). |
| `GET` | `/api/profiles/:id/logs/export` | Bearer | Exports profile query logs. |
| `GET` | `/api/profiles/:id/logs/:logId` | Bearer | Retrieves details for a single log record. |
| `DELETE` | `/api/profiles/:id/logs` | Bearer + CSRF | Clears stored query logs for the profile. |
| `POST` | `/api/profiles/:id/logs/ws-ticket` | Bearer + CSRF | Issues a short-lived single-use ticket for upgrading to the live log WebSocket. |
| `GET` (WS) | `/api/profiles/:id/logs/ws` | Ticket | WebSocket upgrade endpoint streaming live DNS query events in real time. |
| `GET` | `/api/profiles/:id/analytics` | Bearer | Returns combined profile analytics overview. |
| `GET` | `/api/profiles/:id/analytics/summary` | Bearer | Returns total/blocked/cached counters and latency summary. |
| `GET` | `/api/profiles/:id/analytics/trend` | Bearer | Returns time-series query volume and block rate buckets. |
| `GET` | `/api/profiles/:id/analytics/top_allowed` | Bearer | Lists top allowed domains. |
| `GET` | `/api/profiles/:id/analytics/top_blocked` | Bearer | Lists top blocked domains. |
| `GET` | `/api/profiles/:id/analytics/clients` | Bearer | Breaks down queries by client IP / access point. |
| `GET` | `/api/profiles/:id/analytics/destinations` | Bearer | Summarizes destination countries / GeoIP distributions. |
| `GET` | `/api/profiles/:id/analytics/isps` | Bearer | Summarizes queried destination ASNs / ISPs. |

### Profile-Level E2EE

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/profiles/:id/e2ee/status` | Bearer | Checks whether per-profile E2EE is configured and active. |
| `GET` | `/api/profiles/:id/e2ee/wrapped-key` | Bearer | Retrieves the profile's wrapped encryption key. |
| `POST` | `/api/profiles/:id/e2ee/init` | Bearer + CSRF | Initializes profile-level E2EE key material. |
| `POST` | `/api/profiles/:id/e2ee/wrap` | Bearer + CSRF | Stores an updated wrapped profile key. |
| `DELETE` | `/api/profiles/:id/e2ee` | Bearer + CSRF | Disables profile-level E2EE. |

---

## Administration (`/api/admin/*`)

All `/api/admin/*` endpoints require an authenticated user with `role === 'admin'`; non-admin requests receive `403 Forbidden`.

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/admin/users` | Admin | Lists all registered users and quotas. |
| `POST` | `/api/admin/users` | Admin + CSRF | Creates a user account as an administrator. |
| `DELETE` | `/api/admin/users/:id` | Admin + CSRF | Deletes a user account and its owned resources. |
| `GET` | `/api/admin/settings` | Admin | Retrieves global system settings (Turnstile, signup toggles, quota limits, etc.). |
| `PATCH` | `/api/admin/settings` | Admin + CSRF | Updates global system settings. |
| `GET` | `/api/admin/database` | Admin | Inspects database driver, migration status, schema readiness, and runtime mode (`serverfull` vs Worker). |
| `POST` | `/api/admin/database/migrate` | Admin + CSRF | Runs pending SQL schema migrations. |
| `GET` | `/api/admin/distribute-filter` | Admin | Lists active system-level distributed filter lists. |
| `POST` | `/api/admin/distribute-filter` | Admin + CSRF | Distributes a system-level filter list across profiles (`System` tag). |
| `DELETE` | `/api/admin/distribute-filter` | Admin + CSRF | Revokes a distributed system-level filter list from all profiles. |
| `POST` | `/api/admin/distribute-filter/revoke` | Admin + CSRF | Alternative POST endpoint to revoke a distributed system filter list. |
