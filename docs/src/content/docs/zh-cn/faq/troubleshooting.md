---
title: 常见问题与排错指引
description: 覆盖权限问题 (EACCES)、DoT 证书要求、401 会话过期等常见场景。
---

## 1. TLS 证书显示 Permission denied (EACCES)

### 现象
后台服务日志中显示：
`• DoT (TLS DNS) : Disabled (Files Inaccessible: Permission denied (EACCES))`

### 原因
后台服务默认以普通用户（非 root）降权运行，无法直接读取 Certbot 生成在 `/etc/letsencrypt/` 下默认权限为 `0600 (root:root)` 的私钥。

### 解决方法
推荐使用系统 `ssl-cert` 用户组授权（无需提升至 root，安全规范）：
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

## 2. DoT 显示 Paused (Requires Wildcard Certificate *.domain)

### 现象
HTTPS Web 仪表盘能正常启动，但 DoT 处于暂停状态。

### 原因
DoT 需要基于 TLS SNI 识别并路由不同的配置 Profile（`<profileKey>.dns.example.com`）。单域名证书无法覆盖子域名，因此必须使用通配符证书。

### 解决方法
使用 Certbot 通过 DNS 挑战重新申请通配符证书：
```bash
certbot certonly -d *.your.domain -d your.domain --manual --preferred-challenges dns
```

---

## 3. 为什么后台服务修改了当前目录的 .env 没有生效？

### 现象
在个人目录编辑了 `.env` 并重启了服务，但服务显示未配置。

### 原因
通过 `systemd` 托管的 Service 模式下，系统加载的环境变量文件固定为 **/etc/dns-worker/.env**。请确保配置已写入 `/etc/dns-worker/.env`。

---

## 4. 设备接入正常，但过滤规则未生效且没有查询日志？

### 现象
客户端使用分配的 DoH 地址或 DoT 域名可以正常上网，但配置的拦截规则不生效，且在 **解析日志** 页面看不到对应请求记录。

### 原因
接入点与配置文件采用解耦设计。当某个接入点处于 **未绑定** 状态（例如新建时未绑定，或原本绑定的配置文件被删除导致 `profile_id` 置空）时，系统为保障不断网会将其路由至 `FAIL_OPEN_UPSTREAM` 应急上游，跳过规则过滤且不写入日志。

### 解决方法
进入左侧 **接入点 > 管理**（`/access-points/manage`），找到对应设备卡片，在 **绑定配置** 下拉框中重新绑定目标配置文件即可立即生效。

---

## 5. `npm run dev` 本地开发时统计页世界地图不显示（仅见零星圆点）？

### 现象
统计页地图区域能看到微缩地区圆点与图例、缩放按钮，但各大洲地理轮廓未渲染。

### 原因
世界地图数据依赖 `/world-110m.json`（由服务代理上游并携带 `Cache-Control: max-age=2592000` 缓存）。若本地 `.wrangler/state/v3/cache` 缓存块损坏、浏览器命中此前 30 天旧缓存或开发服务尚未完全启动时请求超时，会导致地图轮廓数据未能加载。

### 解决方法
1. 停止 `npm run dev`，清理 `.wrangler/state/v3/cache` 目录（保留 `.wrangler/state/v3/d1` 与 `.wrangler/state/v3/do` 数据库数据），重新启动 `npm run dev`。
2. 在浏览器执行一次强制刷新（`Ctrl + Shift + R` / `Cmd + Shift + R`），跳过旧缓存重新拉取 `/world-110m.json?v=3`。
