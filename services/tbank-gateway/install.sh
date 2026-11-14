#!/bin/bash
set -euo pipefail
umask 077
stage=/root/criterion-tbank-staging
target=/opt/criterion-tbank
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
test -f "$stage/server.mjs"
test -f "$stage/gateway.env"
test ! -e "$target"
test -z "$(ss -H -ltn '( sport = :443 or sport = :8788 )')"
grep -Eq '^CRITERION_GATEWAY_SECRET=[a-f0-9]{64}$' "$stage/gateway.env"
grep -qx 'CRITERION_DEMO_TERMINAL=1794211361391DEMO' "$stage/gateway.env"

install -d -m 755 "$target" "$target/runtime" "$target/certs"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz -o "$stage/node.tar.xz"
printf '%s  %s\n' '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb' "$stage/node.tar.xz" | sha256sum --check --status
tar --no-same-owner -xJf "$stage/node.tar.xz" -C "$target/runtime" --strip-components=1
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz -o "$stage/caddy.tar.gz"
printf '%s  %s\n' '5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb' "$stage/caddy.tar.gz" | sha256sum --check --status
tar --no-same-owner -xzf "$stage/caddy.tar.gz" -C "$target" caddy
chmod 755 "$target/caddy"
install -m 644 "$stage/server.mjs" "$stage/Caddyfile" "$target/"
install -m 644 "$stage/certs/"*.crt "$target/certs/"
"$target/runtime/bin/node" --check "$target/server.mjs"
"$target/caddy" validate --config "$target/Caddyfile" --adapter caddyfile

for name in criterion-tbank criterion-tbank-proxy; do
  if ! id "$name" >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin "$name"; fi
done
install -d -m 700 /etc/criterion-tbank
install -m 600 "$stage/gateway.env" /etc/criterion-tbank/gateway.env
install -m 644 "$stage/criterion-tbank.service" "$stage/criterion-tbank-https.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now criterion-tbank.service criterion-tbank-https.service
rm -f "$stage/gateway.env" "$stage/node.tar.xz" "$stage/caddy.tar.gz"
systemctl is-active criterion-tbank.service criterion-tbank-https.service
