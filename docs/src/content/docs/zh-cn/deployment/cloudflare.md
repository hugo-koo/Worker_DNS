---
title: Cloudflare Workers 边缘模式部署
description: 依托 Cloudflare Workers 与 D1 数据库，在 300+ 边缘节点无服务器部署。
---

Cloudflare Workers 部署方式让您能够一键运行具备全球高可用特性的现代化 DoH 解析服务，彻底免除底层服务器的运维开销。

## 方案 1：Git 关联自动化部署 (推荐)

1. **Fork 仓库**：点击 GitHub 仓库右上角的 `Fork` 按钮，将其复制到您的个人账户。
2. **创建 D1 数据库**：
   - 进入 Cloudflare 控制台，导航至 `Workers & Pages` > `D1`；
   - 创建名为 `dns_worker_db` 的数据库，并复制生成的 Database ID。
3. **配置 wrangler.toml**：
   - 在您的 Fork 仓库中编辑 `wrangler.toml`；
   - 将 `database_id` 替换为真实的 D1 数据库 ID。
4. **部署应用**：
   - 前往 `Workers & Pages` > `Create application` > `Continue with GitHub`；
   - 关联您的仓库，并配置构建参数：
     - 构建命令：`npm run build`
     - 部署命令：`npm run deploy`
     - 输出目录：`/`
5. **配置凭据密钥**：
   - 部署完成后，进入项目 `Settings` > `Variables and secrets`；
   - 添加 `JWT_SECRET`（类型选择 `Secret`，填入高强度随机字符串）；
   - *(可选)* 添加 `KEK_v1`（类型选择 `Secret`），用于启用信封加密主密钥。

---

## 方案 2：本地 CLI 开发与部署

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

## Cloudflare D1 数据库 Studio 查验

部署完成后，所有用户、接入点、过滤规则及查询日志均持久化于 Cloudflare D1 分布式数据库中。您可以在 Cloudflare 控制台导航至 **Workers & Pages** > **D1** > 目标数据库 > **Console / Explore Data** 直接检索表数据与架构。

---

## 核心环境变量

除作为机密变量存储的 `JWT_SECRET` 与 `KEK_v1` 外，以下常用运行时变量均可在 `wrangler.toml` 的 `[vars]` 或 Cloudflare 控制台环境变量中调整：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `FAIL_OPEN_UPSTREAM` | `tls://no-ads-malware-typo.freedns.controld.com` | 数据库离线或接入点处于未绑定状态（`profile_id = null`）时回退的兜底上游解析器。 |
| `SUBSTITUTE_DOMAIN` | `www.wto.org` | 接入引导卡片用于探测展示节点 IPv4 与 IPv6 连通状态的辅助域名。 |
| `MAX_PROFILES_PER_USER` | `10` | 单个账户允许创建的最大配置文件数量。 |
| `MAX_ACCESS_POINTS_PER_PROFILE` | `100` | 账户下允许创建的最大接入点数量上限。 |
| `MAX_LOG_RETENTION_DAYS` | `30` | 管理员配置文件允许设置的最长日志保留天数上限。 |
| `INACTIVITY_THRESHOLD_DAYS` | `180` | 账户连续无解析活动多少天后由定时任务自动清理。 |
| `DEMO_MODE` | `false` | 可选演示开关，设为 `"true"` 时开启演示模式（展示状态标签、脱敏网络遥测并自动注入示例数据；变量名须全大写）。 |
| `DEMO_DOMAIN` | `dns.worker.domain` | 开启 `DEMO_MODE` 后页面统一展示的接入基准域名（变量名须全大写）。 |

开启 `DEMO_MODE=true` 后，接入地址与公共探测信息会自动脱敏并替换为 `DEMO_DOMAIN`，且账号下会自动幂等填充示例配置文件、10 种常见设备形态的接入点（含 1 个未绑定智能电视示例）、自定义规则、外部过滤列表、示例日志及全时间范围动态统计数据。
