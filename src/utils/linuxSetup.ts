export function generateLinuxSetupScript(origin: string, key: string): string {
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(origin)) {
    throw new Error('Invalid origin for setup script');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
    throw new Error('Invalid profile key for setup script');
  }
  const upstreamUrl = `${origin}/${key}`;
  return `#!/bin/bash
sudo curl -L 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64' -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
sudo tee /etc/systemd/system/cloudflared-dns.service > /dev/null <<'EOF'
[Unit]
Description=DNS Worker DoH Proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared proxy-dns --upstream __UPSTREAM_URL__ --port 53
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo sed -i "s|__UPSTREAM_URL__|${upstreamUrl}|g" /etc/systemd/system/cloudflared-dns.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-dns
echo "DNS Worker DoH Proxy installed successfully."
echo "Please change your system DNS to 127.0.0.1"
`;
}
