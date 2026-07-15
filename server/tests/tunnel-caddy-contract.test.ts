import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const tunnelCaddyPath = fileURLToPath(
  new URL('../../ops/caddy/Caddyfile.tunnel.example', import.meta.url),
);
const cloudflaredPath = fileURLToPath(
  new URL('../../ops/cloudflared/config.yml.example', import.meta.url),
);

describe('Cloudflare Tunnel origin contracts', () => {
  const caddy = readFileSync(tunnelCaddyPath, 'utf8');
  const tunnel = readFileSync(cloudflaredPath, 'utf8');

  it('binds Caddy to loopback HTTP with explicit public Host matcher', () => {
    expect(caddy).toMatch(/http:\/\/app\.example\.com:8080/);
    expect(caddy).toMatch(/\bbind\s+127\.0\.0\.1\b/);
    expect(caddy).toMatch(/servers\s*\{/);
    expect(caddy).not.toMatch(/:\s*443\b/);
  });

  it('trusts only loopback proxies and uses CF-Connecting-IP', () => {
    expect(caddy).toMatch(/trusted_proxies\s+static\s+127\.0\.0\.0\/8\s+::1/);
    expect(caddy).toMatch(/client_ip_headers\s+CF-Connecting-IP/);
  });

  it('forwards visitor IP and public HTTPS semantics to Fastify', () => {
    expect(caddy).toMatch(/reverse_proxy\s+127\.0\.0\.1:3000/);
    // Explicit CF header (not loopback peer) so Fastify request.ip is the visitor.
    expect(caddy).toMatch(
      /header_up\s+X-Forwarded-For\s+\{http\.request\.header\.CF-Connecting-IP\}/,
    );
    expect(caddy).toMatch(/header_up\s+X-Forwarded-Proto\s+https/);
    expect(caddy).toMatch(/header_up\s+X-Forwarded-Host\s+\{host\}/);
  });

  it('keeps cache contracts for API, assets, and SPA shell', () => {
    expect(caddy).toMatch(/Cache-Control\s+"no-store"/);
    expect(caddy).toMatch(/Cache-Control\s+"no-cache"/);
    expect(caddy).toMatch(/handle\s+\/assets\/\*/);
    expect(caddy).toMatch(/max-age=31536000,\s*immutable/);
  });

  it('redacts Cookie and Authorization from access logs', () => {
    expect(caddy).toMatch(/Cookie\s+delete/);
    expect(caddy).toMatch(/Authorization\s+delete/);
  });

  it('defines a valid named-tunnel ingress with Host alignment and catch-all', () => {
    expect(tunnel).toMatch(/tunnel:\s*<TUNNEL_UUID>/);
    expect(tunnel).toMatch(/credentials-file:\s*\/etc\/cloudflared\/<TUNNEL_UUID>\.json/);
    expect(tunnel).toMatch(/hostname:\s*app\.example\.com/);
    expect(tunnel).toMatch(/service:\s*http:\/\/127\.0\.0\.1:8080/);
    expect(tunnel).toMatch(/httpHostHeader:\s*app\.example\.com/);
    expect(tunnel).toMatch(/service:\s*http_status:404/);

    // hostname and httpHostHeader must be the same public FQDN.
    const hostMatch = tunnel.match(/^\s*-?\s*hostname:\s*([^\s#]+)/m);
    const headerMatch = tunnel.match(/^\s*httpHostHeader:\s*([^\s#]+)/m);
    expect(hostMatch?.[1]).toBe('app.example.com');
    expect(headerMatch?.[1]).toBe(hostMatch?.[1]);

    const serviceLines = tunnel
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .filter((line) => /(^|-\s*)service:/.test(line));
    expect(serviceLines.at(-1)).toMatch(/service:\s*http_status:404/);
  });
});
