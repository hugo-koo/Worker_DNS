---
title: Troubleshooting & FAQ
description: Common issues including Permission Denied (EACCES), DoT Wildcard certificates, and service environments.
---

## 1. TLS Certificate Inaccessible: Permission denied (EACCES)

### Symptom
Startup logs report:
`• DoT (TLS DNS) : Disabled (Files Inaccessible: Permission denied (EACCES))`

### Root Cause
The background service runs under an unprivileged user by default (Principle of Least Privilege), and cannot read Certbot's `0600 (root:root)` private key files under `/etc/letsencrypt/`.

### Solution
Use the standard `ssl-cert` group delegation without elevating the process to root:
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

## 2. DoT Shows Paused (Requires Wildcard Certificate *.domain)

### Symptom
Web Dashboard works over HTTPS, but DoT is paused.

### Root Cause
DoT maps queries to user profiles via TLS Server Name Indication (`<profileToken>.dns.example.com`). A single-domain certificate cannot match subdomains, so a wildcard certificate is required.

### Solution
Register a wildcard certificate via Certbot with DNS challenge:
```bash
certbot certonly -d *.your.domain -d your.domain --manual --preferred-challenges dns
```

---

## 3. Why Are Changes to .env in Current Directory Ignored by Service?

### Symptom
Editing `.env` in your user directory has no effect after restarting the service.

### Root Cause
When managed by `systemd`, the daemon loads environment variables from `/etc/dns-worker/.env`. Ensure your changes are written to `/etc/dns-worker/.env`.

---

## 4. Device Connects Successfully but Rules Are Ignored and No Logs Appear

### Symptom
DNS resolution succeeds on the client using its DoH URL or DoT hostname, yet custom block rules do not trigger and no queries appear under **Logs**.

### Root Cause
Access Points are decoupled from Profiles. If an Access Point is in the **Unbound** (`profile_id = null`) state—for example after creating an unbound device or deleting its previously bound Profile—queries deliberately fall back to `FAIL_OPEN_UPSTREAM` with zero filtering and zero logging to prevent network outages.

### Solution
Open **Access Points > Manage** (`/access-points/manage`), locate the device card, and select a target Profile from the **Bound Profile** dropdown.

---

## 5. Analytics World Map Is Blank or Only Displays Small Dots in `npm run dev`

### Symptom
On `/dash/:id/stats`, markers for micro-regions or zoom controls appear, while the world continent silhouettes remain missing.

### Root Cause
The frontend fetches `/world-110m.json`, which is proxied and cached by the Worker (`/world-110m.json`, `Cache-Control: max-age=2592000`). A corrupted `.wrangler/state/v3/cache` blob, browser 30-day HTTP cache, or an upstream timeout during startup can prevent TopoJSON geometry loading.

### Solution
1. Stop `npm run dev`, delete `.wrangler/state/v3/cache` (preserve `.wrangler/state/v3/d1` and `.wrangler/state/v3/do`), and restart `npm run dev`.
2. Perform a hard refresh (`Ctrl + Shift + R` / `Cmd + Shift + R`) in the browser so `/world-110m.json?v=3` bypasses old browser cache.
