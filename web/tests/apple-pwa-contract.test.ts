import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(__dirname, '..');
const publicRoot = resolve(webRoot, 'public');

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(8)).toBe(13);
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('Apple / PWA identity contract', () => {
  it('keeps the manifest identity contract', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'manifest.webmanifest'), 'utf8'));
    expect(manifest.id).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url).toBe('/jobs');
    expect(manifest.name).toBe('Dünya Dental Servora');
    expect(manifest.short_name).toBe('Servora');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('tr');
    expect(manifest.prefer_related_applications).toBe(false);
    expect(manifest.icons).toEqual([
      { src: '/icons/servora-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/servora-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/servora-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('keeps manifest theme and background colors aligned with the HTML meta', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'manifest.webmanifest'), 'utf8'));
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
    expect(manifest.theme_color).toBe('#f7f8f8');
    expect(manifest.background_color).toBe('#f7f8f8');
    expect(html).toContain('name="theme-color" content="#f7f8f8"');
  });

  it('keeps the generated icon family with exact dimensions and PNG signatures', () => {
    const expected = {
      'icons/apple-touch-icon.png': { width: 180, height: 180 },
      'icons/servora-192.png': { width: 192, height: 192 },
      'icons/servora-512.png': { width: 512, height: 512 },
      'icons/servora-maskable-512.png': { width: 512, height: 512 },
    };
    for (const [relative, dimensions] of Object.entries(expected)) {
      expect(pngDimensions(resolve(publicRoot, relative))).toEqual(dimensions);
    }
  });

  it('provides the cropped sidebar branding asset', () => {
    const asset = resolve(publicRoot, 'branding/dunya-dental-sidebar.png');
    expect(pngDimensions(asset)).toEqual({ width: 4538, height: 3210 });
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Servora" />');
    expect(html).toContain('<title>Dünya Dental Servora</title>');
  });

  it('records asset provenance without .png.png filenames', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(webRoot, '..', 'docs/evidence/apple-pwa-reconciliation/asset-manifest.json'),
      'utf8',
    ));
    for (const entry of manifest.assets) {
      expect(entry.output.path).not.toMatch(/\.png\.png$/);
      expect(entry.output.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.assets.map((entry: { output: { path: string } }) => entry.output.path))
      .toContain('web/public/icons/apple-touch-icon.png');
  });

  it('keeps the push-only service worker contract without offline caching', () => {
    const worker = readFileSync(resolve(publicRoot, 'service-worker.js'), 'utf8');
    expect(worker).toContain('/icons/servora-192.png');
    expect(worker).not.toMatch(/addEventListener\(['"]fetch/);
    expect(worker).not.toContain('caches.open');
    expect(worker).not.toMatch(/\.sync\./);
    expect(worker).not.toContain("'sync'");
  });
});
