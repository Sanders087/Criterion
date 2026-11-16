import http from 'node:http';
import https from 'node:https';
import { rootCertificates } from 'node:tls';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METHODS = new Set(['Init', 'GetState', 'CheckOrder', 'Cancel']);
const BODY_LIMIT = 32768;
const RESPONSE_LIMIT = 1048576;
const WINDOW_SECONDS = 90;
const LIVE_SITE = 'https://criterion-publish-diagnostic-20261113.serenewisteria2.chatgpt.site';

export function configuration(env = process.env) {
  const secret = env.CRITERION_GATEWAY_SECRET || '';
  const mode = env.CRITERION_MODE || 'demo';
  const terminal = mode === 'live' ? env.CRITERION_LIVE_TERMINAL || '' : env.CRITERION_DEMO_TERMINAL || '';
  const port = Number(env.PORT || 8788);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('A 256-bit gateway secret is required');
  if (!['demo', 'live'].includes(mode) || !(mode === 'live' ? /^\d{5,24}$/ : /^\d{5,24}DEMO$/).test(terminal)) throw new Error('Explicit matching payment mode and terminal required');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
  const siteToken = env.CRITERION_SITE_TOKEN || '';
  if (mode === 'live' && (!/^[A-Za-z0-9._~-]{32,4096}$/.test(siteToken) || env.CRITERION_SITE_ORIGIN !== LIVE_SITE)) throw new Error('Private Site notification access required');
  return { secret, terminal, port, mode, siteToken, siteOrigin: mode === 'live' ? LIVE_SITE : undefined };
}

export function notificationTransport(config, send = fetch) {
  if (config.mode !== 'live' || config.siteOrigin !== LIVE_SITE || !config.siteToken) throw new Error('Notification forwarding is not configured');
  return async body => {
    const result = await send(LIVE_SITE + '/api/payments/tbank/notification', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), body,
      headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': `Bearer ${config.siteToken}` },
    });
    if (result.status !== 200) { await result.body?.cancel(); return result.status === 400 || result.status === 404 ? 400 : 502; }
    const reader = result.body?.getReader();
    if (!reader) return 502;
    let text = '', size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16) return 502;
        text += Buffer.from(value).toString('utf8');
      }
      return text === 'OK' ? 200 : 502;
    } finally { await reader.cancel(); }
  };
}

export function signature(secret, timestamp, nonce, method, body) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${timestamp}\n${nonce}\n${method}\n${body}`).digest('hex');
}

export function bankTransport() {
  const names = ['russian_trusted_root_ca_pem.crt', 'russian_trusted_sub_ca_2024_pem.crt', 'russian_trusted_sub_ca_pem.crt'];
  // Additional CAs apply ONLY to this fixed bank connection. System trust is untouched.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8, proxyEnv: process.env,
    ca: [...rootCertificates, ...names.map(name => readFileSync(new URL(`./certs/${name}`, import.meta.url), 'utf8'))] });
  return (method, body) => new Promise((resolve, reject) => {
    const request = https.request(`https://securepay.tinkoff.ru/v2/${method}`, {
      agent, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      signal: AbortSignal.timeout(12000),
    }, response => {
      // No redirects, cookies, or upstream response headers are forwarded.
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Bank transport failed')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > RESPONSE_LIMIT) request.destroy(new Error('Bank response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid bank response');
          resolve(value);
        } catch { reject(new Error('Invalid bank response')); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

export function createGateway(config, forward = bankTransport(), now = () => Date.now(), notify = config.mode === 'live' ? notificationTransport(config) : null) {
  const seen = new Map(); let inflight = 0;
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/health') { send(200, { ok: true, mode: config.mode || 'demo' }); return; }
    const notification = request.url === '/notification' && config.mode === 'live' && notify;
    const method = request.url?.match(/^\/bank\/(Init|GetState|CheckOrder|Cancel)$/)?.[1];
    if (request.method !== 'POST' || (!notification && !METHODS.has(method))) { send(404, { error: 'Not found' }); return; }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) { send(413, { error: 'Invalid request size' }); return; }
    if (inflight >= 8) { send(503, { error: 'Busy' }); return; }
    inflight++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_LIMIT) { send(413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (notification) {
        let payload; try { payload = JSON.parse(body); } catch { send(400, { error: 'Invalid JSON' }); return; }
        if (size > 16000 || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.TerminalKey !== config.terminal ||
            typeof payload.Token !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.Token) || Object.hasOwn(payload, 'Password')) { send(400, { error: 'Invalid notification' }); return; }
        // The private Site verifies the bank signature and exact order/amount before applying anything.
        const status = await notify(body);
        if (status !== 200) { send(status, { error: 'Notification not accepted' }); return; }
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' });
        response.end('OK'); return;
      }
      const timestamp = request.headers['x-criterion-timestamp'];
      const nonce = request.headers['x-criterion-nonce'];
      const actual = request.headers['x-criterion-signature'];
      if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(now() / 1000 - Number(timestamp)) > WINDOW_SECONDS ||
          typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce) || typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) ||
          !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(signature(config.secret, timestamp, nonce, method, body), 'hex'))) {
        send(401, { error: 'Unauthorized' }); return;
      }
      for (const [key, expiry] of seen) if (expiry <= now()) seen.delete(key);
      if (seen.has(nonce)) { send(409, { error: 'Replay rejected' }); return; }
      if (seen.size >= 4096) { send(429, { error: 'Rate limit' }); return; }
      let payload; try { payload = JSON.parse(body); } catch { send(400, { error: 'Invalid JSON' }); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.TerminalKey !== config.terminal ||
          typeof payload.Token !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.Token) || Object.hasOwn(payload, 'Password') ||
          (method === 'Init' && payload.Amount !== 19900)) { send(400, { error: 'Invalid payment' }); return; }
      seen.set(nonce, now() + WINDOW_SECONDS * 2000);
      send(200, await forward(method, body));
    } catch {
      // Never log request bodies, bank signatures, customer data, or secrets.
      if (!response.headersSent) send(502, { error: 'Bank connection unavailable' });
    } finally { inflight--; }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.timeout = 15000;
  server.maxRequestsPerSocket = 1;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = configuration();
  createGateway(config).listen(config.port, '127.0.0.1', () => console.log(`Criterion ${config.mode} payment gateway ready`));
}
