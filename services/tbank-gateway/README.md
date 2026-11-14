# Criterion T-Bank payment gateway

Prepared for a separate Debian 12 VPS with Node.js. Keep existing web services and databases intact; do not reinstall the OS or replace unrelated configuration. Account, billing and infrastructure inventory details are omitted from the public source export.

The DEMO gateway was deployed on 2026-11-13. A separate live service was subsequently enabled with the owner's approval. As of 2026-11-14 (Asia/Bangkok), live payment confirmation and notification delivery to the private Site have been verified. The DEMO instructions below remain for the separate test service; see **Private live service** for the active payment path.

## Purpose and limits

Sites runs on Cloudflare Workers, which cannot add the bank's private CA to its outbound TLS trust. Direct requests currently fail with HTTP 526. This separate Node process uses the certificates linked by [T-Bank](https://status.tbank-online.com/certificates/) ONLY for `securepay.tinkoff.ru`. It does not alter the machine's trust store or disable certificate verification.

The default service accepts only DEMO terminals. The separate live service requires CRITERION_MODE=live and one exact numeric terminal; both enforce the existing 19900 kopeck price. Allowed bank methods: Init, GetState, CheckOrder, Cancel. No arbitrary target URLs, redirects, or bank passwords are accepted. Sites signs the bank payload itself; the bank password stays in Sites. Gateway requests additionally use HMAC-SHA256 over timestamp, nonce, method and the full JSON body. The gateway checks freshness and rejects replayed nonces. Logs omit payment data and signatures.

The Node process listens only on `127.0.0.1:8788`. A separate Caddy service exposes it at `https://srv678677.hstgr.cloud/criterion-tbank/`, stripping `/criterion-tbank` before forwarding, with a 32 KB body limit and short timeouts. The gateway limits simultaneous requests to eight. Caddy uses port 443 and TLS-ALPN certificate renewal; HTTP redirects and the HTTP ACME challenge are disabled. Existing Nginx on port 80 and Apache on port 8080 remain active. The local Node port is not public.

Environment on the gateway (root-readable file loaded by systemd):

```
CRITERION_GATEWAY_SECRET=<random 32 bytes, lowercase hex>
CRITERION_DEMO_TERMINAL=1794211361391DEMO
PORT=8788
```

Environment in Sites:

```
TBANK_GATEWAY_URL=https://srv678677.hstgr.cloud/criterion-tbank/
TBANK_GATEWAY_SECRET=<same secret, stored as a secret>
```

For the DEMO service, keep `TBANK_API_URL=https://securepay.tinkoff.ru/v2/` and the DEMO terminal, and use server-side reconciliation. The private Site's public URL cannot directly receive unauthenticated bank callbacks. The live service described below provides the approved notification path and authenticates to the private Site; the Site then verifies the original bank signature and payment details.

## Runtime and checks

Node 24 LTS. Official Linux x64 runtime verified during preparation: `node-v24.22.3-linux-x64.tar.xz`, SHA256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb` from `https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt`.

Caddy 2.11.9 is installed separately under `/opt/criterion-tbank` from the official release, verified against SHA256 `5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb`. Both services use separate non-login accounts; their executable files are owned by root. The gateway secret is kept in `/etc/criterion-tbank/gateway.env`, readable by root only. No bank password is stored on this server.

Run `node --test services/tbank-gateway/server.test.mjs tests/billing.test.ts` in the repository. The gateway transport was also checked against the real bank using deliberately invalid, non-customer credentials: TLS verification succeeded and the bank returned JSON error 501, as expected. No payment was attempted by this probe.

Three public RSA certificates are included under `certs/`. Their origin is preserved in `download-ca.mjs`. The root SHA256 is `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`. Certificates are not secrets. Review changed certificates against the official bank source before updating them. The oldest intermediate expires on 2027-03-06.

## Private live service

The live service uses `/opt/criterion-tbank-live`, a separate non-login user, port 8789 and `/criterion-tbank-live/`. `install-live.sh` preserves the DEMO service, shares only its Node runtime and public certificates, and keeps a Caddy rollback copy. Configuration is root-readable at `/etc/criterion-tbank-live/gateway.env`.

Required configuration: `CRITERION_MODE=live`, exact `CRITERION_LIVE_TERMINAL`, fresh `CRITERION_GATEWAY_SECRET`, `PORT=8789`, `CRITERION_SITE_ORIGIN` pinned to the working private Site, and its `CRITERION_SITE_TOKEN`. The bank password remains only in Sites. The public `/notification` path forwards the original JSON only to that Site’s bank notification endpoint, with service access. It never follows redirects or forwards caller headers. The Site checks the bank signature, terminal, order, payment ID and amount; only an exact successful `OK` is acknowledged to the bank. Retries remain idempotent. Logs omit bodies and credentials.

Sites live configuration requires `TBANK_MODE=live`, `TBANK_GATEWAY_URL=https://srv678677.hstgr.cloud/criterion-tbank-live/`, the matching HMAC secret, and `TBANK_NOTIFICATION_URL=https://srv678677.hstgr.cloud/criterion-tbank-live/notification`. Keep access owner-private. New live orders must not reuse DEMO orders.
