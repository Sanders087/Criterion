import { isIP } from 'node:net';

export function sameOrigin(request: Request) {
  try {
    const expected = new URL(process.env.AUTH_PUBLIC_URL || request.url).origin;
    return new URL(request.headers.get('origin') || '').origin === expected;
  } catch { return false; }
}
export function clientAddress(request: Request) {
  // Opt in only after the ingress is verified to overwrite this header.
  const header = process.env.TRUSTED_CLIENT_IP_HEADER;
  if (!header) return 'unknown';
  const value = request.headers.get(header)?.trim() || '';
  return isIP(value) ? value : 'unknown';
}
