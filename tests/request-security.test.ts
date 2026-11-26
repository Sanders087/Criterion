import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, clientAddress } from '../lib/criterion/request-security.ts';

test('CSRF uses the configured public origin behind a proxy and rejects forged origins', t => {
  const previous = process.env.AUTH_PUBLIC_URL;
  t.after(() => { if (previous === undefined) delete process.env.AUTH_PUBLIC_URL; else process.env.AUTH_PUBLIC_URL = previous; });
  process.env.AUTH_PUBLIC_URL = 'https://criterion.example';
  const request = (origin: string) => new Request('http://internal:3000/api/auth', { headers: { Origin: origin, Host: 'forged.example' } });
  assert.equal(sameOrigin(request('https://criterion.example')), true);
  for (const origin of ['https://evil.example', 'http://criterion.example', 'null', '']) assert.equal(sameOrigin(request(origin)), false);
});
test('Forwarded client addresses are ignored unless an administrator explicitly trusts a header', t => {
  const previous = process.env.TRUSTED_CLIENT_IP_HEADER;
  t.after(() => { if (previous === undefined) delete process.env.TRUSTED_CLIENT_IP_HEADER; else process.env.TRUSTED_CLIENT_IP_HEADER = previous; });
  delete process.env.TRUSTED_CLIENT_IP_HEADER;
  const request = (value: string) => new Request('http://localhost', { headers: { 'x-real-ip': value, 'cf-connecting-ip': '192.0.2.2' } });
  assert.equal(clientAddress(request('192.0.2.1')), 'unknown');
  process.env.TRUSTED_CLIENT_IP_HEADER = 'X-Forwarded-For';
  assert.equal(clientAddress(new Request('http://localhost',{headers:{'X-Forwarded-For':'192.0.2.1'}})), 'unknown');
  process.env.TRUSTED_CLIENT_IP_HEADER = 'cookie';
  assert.equal(clientAddress(new Request('http://localhost',{headers:{cookie:'192.0.2.1'}})), 'unknown');
  process.env.TRUSTED_CLIENT_IP_HEADER = 'x-real-ip';
  assert.equal(clientAddress(request('192.0.2.1')), '192.0.2.1');
  assert.equal(clientAddress(request('2001:db8::1')), '2001:db8::1');
  for (const invalid of ['unknown', '', '192.0.2.1, 192.0.2.2', 'name.example']) assert.equal(clientAddress(request(invalid)), 'unknown');
});
