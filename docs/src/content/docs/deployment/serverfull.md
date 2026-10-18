---
title: Standalone Server / VPS Guide
description: Deploy and operate DNS Worker independently on Linux, macOS, or Windows servers.
---

DNS Worker can run completely independent of Cloudflare Workers on your own VPS, home server, or virtual machine.

## System Requirements
- **Runtime (Node.js / Bun)**:
  - **Node.js**: `>= 22.5.0` (Recommended, LTS with built-in `node:sqlite`)
  - **Bun**: `>= 1.4.0` (Supported with built-in `node:sqlite` compatibility layer)
- **Memory**: Minimum 256MB RAM (512MB+ recommended)
- **Network Ports**:
  - UDP 53 (Classic DNS, optional)
  - TCP 853 (DoT, optional, requires wildcard certificate)
  - TCP 10080 (HTTP Web Dashboard & DoH)
  - TCP 10443 (HTTPS Web Dashboard & DoH, optional, requires certificate)

---

## Directory Standards

DNS Worker automatically manages standard persistent directories:

- **Linux**:
  - Configuration: `/etc/dns-worker/.env`
  - Database: `/var/lib/dns-worker/dns_worker.sqlite`
- **Windows**:
  - Configuration & Data: `%ProgramData%\DNS-Worker\` (e.g. `C:\ProgramData\DNS-Worker\.env`)

Manage configuration effortlessly with the CLI:
```bash
# View active configuration paths
dns-worker config show

# Initialize clean standard .env file
dns-worker config init
```

---

## Docker Deployment (Bun LTS Runtime)

DNS Worker provides an official containerized workflow powered by **Bun LTS** (`oven/bun:1-slim`) for minimal memory footprint and instant startup.

### Quick Run with Docker

Run the container in detached mode with persistent volumes for database, configuration, and TLS certificates:

```bash
docker run -d \
  --name dns-worker \
  --restart unless-stopped \
  -p 53:53/udp \
  -p 853:853/tcp \
  -p 80:80/tcp \
  -p 443:443/tcp \
  -v dns_worker_data:/var/lib/dns-worker \
  -v dns_worker_config:/etc/dns-worker \
  -v /etc/letsencrypt:/etc/ssl/dns-worker:ro \
  hugokoo/dns-worker:latest
```

> [!TIP]
> **HTTPS Auto-Redirection**: Direct use of plain HTTP is not recommended in production. When TLS certificates are mounted to `/etc/ssl/dns-worker` (or configured via `SERVERFULL_TLS_CERT_PATH`), DNS Worker activates HTTPS on port 443, and all plain HTTP requests arriving on port 80 will **automatically redirect to HTTPS (HTTP 301/307)**.

### Docker Volume & Port Reference

- **Ports**:
  - `53:53/udp`: Classic UDP DNS (RFC 1035)
  - `853:853/tcp`: DNS over TLS (DoT, RFC 7858, DoQ compatible)
  - `80:80/tcp`: HTTP Web Dashboard (Auto-redirects to HTTPS 443)
  - `443:443/tcp`: HTTPS Web Dashboard & DoH (Primary / Recommended)
- **Volumes**:
  - `/var/lib/dns-worker`: Holds persistent SQLite database (`dns_worker.sqlite`) and auto-generated JWT secrets.
  - `/etc/dns-worker`: Mount host directory to provide custom `.env` configuration file.
  - `/etc/ssl/dns-worker`: Mount host TLS certificates (`fullchain.pem` and `privkey.pem`) for automatic discovery and HTTPS activation.

### Building & Publishing to Docker Hub

Images can be published automatically via GitHub Actions upon pushing Git release tags (`v*`), or manually built using CLI scripts:

```bash
# Build local images with auto-tagging
npm run docker:build

# Build multi-platform images (linux/amd64, linux/arm64) and push to Docker Hub
npm run docker:multiarch -- --push

# Push existing local tags to Docker Hub
npm run docker:push
```

---

## Ports & Network Configuration

Customize listening ports in `/etc/dns-worker/.env`:

```ini
# Network interface binding (0.0.0.0 binds all interfaces, or 127.0.0.1 for local-only)
SERVERFULL_HOST=0.0.0.0

# Port configuration
SERVERFULL_UDP_PORT=53
SERVERFULL_DOT_PORT=853
SERVERFULL_HTTP_PORT=10080
SERVERFULL_HTTPS_PORT=10443

# Toggle specific listeners
SERVERFULL_DISABLE_HTTPS=false
```

---

## Reverse Proxying HTTP & DoH (Caddy / Nginx)

In production deployments, you can place a mature reverse proxy such as **Caddy** or **Nginx** in front of DNS Worker instead of exposing port `10080` (HTTP) directly or managing local certificates on port `10443` (HTTPS).

The reverse proxy terminates TLS on standard port `443` (with automated Let's Encrypt / ZeroSSL certificates) and forwards traffic to `http://127.0.0.1:10080`.

> [!TIP]
> When using a reverse proxy, set `SERVERFULL_DISABLE_HTTPS=true` in `.env` to disable the internal port 10443 listener and save system resources. You can also bind `SERVERFULL_HOST=127.0.0.1` so port `10080` is accessible strictly via localhost.

### Option 1: Caddy Configuration (Recommended)

Caddy provides zero-configuration automated HTTPS with automatic renewal. Add this to `/etc/caddy/Caddyfile`:

```caddy
dns.example.com {
    reverse_proxy 127.0.0.1:10080 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up CF-Connecting-IP {remote_host}
    }
}
```

> [!NOTE]
> DNS Worker automatically inspects `CF-Connecting-IP`, `X-Real-IP`, and `X-Forwarded-For` (leftmost IP) on proxied HTTP requests. DNS query logs, user session lists, and security audits will accurately record the client's external IP address instead of `127.0.0.1`.

Reload Caddy:
```bash
sudo systemctl reload caddy
```

### Option 2: Nginx Configuration

If you use Nginx, add the following server block (e.g., `/etc/nginx/sites-available/dns-worker`):

```nginx
server {
    listen 80;
    server_name dns.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name dns.example.com;

    ssl_certificate /etc/letsencrypt/live/dns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns.example.com/privkey.pem;

    # DoH and Web Dashboard reverse proxy
    location / {
        proxy_pass http://127.0.0.1:10080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for live dashboard updates)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Reload Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

> [!NOTE]
> **Client IP Forwarding**: Forwarding `X-Real-IP` and `X-Forwarded-For` is essential so that DNS Worker correctly records real client IPs, evaluates rate limits, and resolves geographic coordinates in query logs.

---

## Maintenance & Factory Reset

If you need to restore the system to its initial state, use the `reset` command:

```bash
# Interactive reset (requires secondary confirmation)
dns-worker reset

# Automated / non-interactive reset
dns-worker reset --force
```

This operation will:
1. Restore the `.env` configuration file to the built-in default template.
2. Completely clear the SQLite database and reapply all migrations from scratch.

---

## Next Steps

- [Configure systemd background daemon](/DNS-Worker/deployment/service/)
- [Configure Let's Encrypt certificates for HTTPS & DoT](/DNS-Worker/advanced/tls-certs/)

