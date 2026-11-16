#!/bin/bash
set -euo pipefail
umask 077
stage=/root/criterion-live-staging
target=/opt/criterion-tbank-live
test "$(id -u)" = 0
test ! -e "$target"
test -z "$(ss -H -ltn '( sport = :8789 )')"
test -f "$stage/gateway.env"
test -x /opt/criterion-tbank/runtime/bin/node
systemctl is-active --quiet criterion-tbank criterion-tbank-https
install -d -m 755 "$target" "$target/certs"
install -m 644 "$stage/server.mjs" "$target/server.mjs"
install -m 644 /opt/criterion-tbank/certs/*.crt "$target/certs/"
/opt/criterion-tbank/runtime/bin/node --check "$target/server.mjs"
if ! id criterion-tbank-live >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin criterion-tbank-live; fi
install -d -m 700 /etc/criterion-tbank-live
install -m 600 "$stage/gateway.env" /etc/criterion-tbank-live/gateway.env
install -m 644 "$stage/criterion-tbank-live.service" /etc/systemd/system/criterion-tbank-live.service
/opt/criterion-tbank/caddy validate --config "$stage/Caddyfile.live" --adapter caddyfile
systemctl daemon-reload
systemctl enable --now criterion-tbank-live
curl --fail --silent http://127.0.0.1:8789/health
cp --no-clobber /opt/criterion-tbank/Caddyfile "$stage/Caddyfile.before-live"
install -m 644 "$stage/Caddyfile.live" /opt/criterion-tbank/Caddyfile
if ! systemctl restart criterion-tbank-https; then
  install -m 644 "$stage/Caddyfile.before-live" /opt/criterion-tbank/Caddyfile
  systemctl restart criterion-tbank-https
  exit 1
fi
systemctl is-active criterion-tbank criterion-tbank-live criterion-tbank-https
rm -- "$stage/gateway.env"
printf '\nCriterion live gateway installed\n'
