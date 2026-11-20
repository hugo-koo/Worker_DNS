---
title: Cloudflare Workers Edge Deployment
description: Deploy serverless across 300+ edge locations with Cloudflare Workers and D1 database.
---

The Cloudflare Workers deployment allows you to run a globally distributed, high-availability DoH resolver with zero infrastructure management.

## Method 1: Git-Connected Automated Deployment (Recommended)

1. **Fork the Repository**: Click `Fork` at the top right of the GitHub repository to clone it to your account.
2. **Create D1 Database**:
   - In Cloudflare Dashboard, go to `Workers & Pages` > `D1`;
   - Create a database named `dns_worker_db` and copy the generated Database ID.
3. **Configure wrangler.toml**:
   - In your forked repository, edit `wrangler.toml`;
   - Replace `database_id` with your database ID.
4. **Deploy Application**:
   - Go to `Workers & Pages` > `Create application` > `Continue with GitHub`;
   - Connect your repository and configure build settings:
     - Build command: `npm run build`
     - Deploy command: `npm run deploy`
     - Output directory: `/`
5. **Set Secrets**:
   - After initial deployment, go to `Settings` > `Variables and secrets`;
   - Add `JWT_SECRET` (type: `Secret`, strong random string);
   - *(Optional)* Add `KEK_v1` (type: `Secret`) for server-side credential envelope encryption.

---

## Method 2: Local CLI Development & Deployment

```bash
# 1. Clone repository and install dependencies
npm install

# 2. Initialize and migrate local D1 database
npm run db:setup
npm run db:migrate:dev

# 3. Configure local development secrets (.dev.vars)
echo "JWT_SECRET=your_secure_random_jwt_secret" > .dev.vars
echo "KEK_v1=your_secure_kek_v1_secret" >> .dev.vars

# 4. Start local development server
npm run dev

# 5. Deploy to Cloudflare Workers
npm run deploy
```

---

## Cloudflare D1 Database Studio & Inspection

Once deployed, all users, profiles, rules, and query logs are persisted in your Cloudflare D1 database. You can inspect live tables, schema, and query records directly in the Cloudflare Dashboard under **Workers & Pages** > **D1** > your database > **Console / Explore Data**.

---

## Environment Variables Reference

In addition to `JWT_SECRET` and `KEK_v1` stored as Cloudflare Worker Secrets, common runtime variables can be customized in `wrangler.toml` `[vars]` or in the Cloudflare Dashboard:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAIL_OPEN_UPSTREAM` | `tls://no-ads-malware-typo.freedns.controld.com` | Fallback upstream used when a DB is offline or an Access Point is unbound (`profile_id = null`). |
| `SUBSTITUTE_DOMAIN` | `www.wto.org` | Auxiliary domain queried to display edge IPv4/IPv6 connectivity examples in the setup guide. |
| `MAX_PROFILES_PER_USER` | `10` | Maximum number of DNS Profiles per user account. |
| `MAX_ACCESS_POINTS_PER_PROFILE` | `100` | Maximum number of Access Points allowed per account. |
| `MAX_LOG_RETENTION_DAYS` | `30` | Hard cap on retention days configurable for admin profiles. |
| `INACTIVITY_THRESHOLD_DAYS` | `180` | Days of DNS inactivity before abandoned accounts are cleaned up by cron tasks. |
| `DEMO_MODE` | `false` | Optional demonstration mode (`"true"` displays the Demo Mode badge, masks real client telemetry, and seeds sample datasets). Must be uppercase `DEMO_MODE`. |
| `DEMO_DOMAIN` | `dns.worker.domain` | Canonical display hostname used across endpoints and UI cards when `DEMO_MODE` is enabled. Must be uppercase `DEMO_DOMAIN`. |

When `DEMO_MODE=true` is enabled, setup URLs and public telemetry mask real client IPs/hosts with `DEMO_DOMAIN`, and accounts are idempotently populated with sample profiles, 10 device-form Access Points (including one unbound example), rules, external filter lists, logs, and range-independent `/stats` analytics.
