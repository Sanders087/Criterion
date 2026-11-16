import { mkdir, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

// Public certificates linked by T-Bank's own installation instructions:
// https://status.tbank-online.com/certificates/
const sources = [
  'https://help-static2.tbank-online.com/certs/linux_russian_trusted_root_ca_pem/russian_trusted_root_ca_pem.crt',
  'https://help-static2.tbank-online.com/certs/russian_trusted_sub_ca_pem/russian_trusted_sub_ca_2024_pem.crt',
  'https://help-static2.tbank-online.com/certs/russian_trusted_sub_ca_pem/russian_trusted_sub_ca_pem.crt',
];
const directory = new URL('./certs/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const url of sources) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`Certificate download failed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 20000) throw new Error('Unexpected certificate size');
  const certificate = new X509Certificate(text);
  if (!certificate.ca || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Invalid CA certificate');
  await writeFile(new URL(url.split('/').at(-1), directory), certificate.toString() + '\n');
  console.log(JSON.stringify({ source: url, subject: certificate.subject, validTo: certificate.validTo, sha256: certificate.fingerprint256 }));
}
