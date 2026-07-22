import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('minimal install surface', () => {
  async function expectPng(path: string, width: number, height: number) {
    const bytes = await readFile(new URL(`../public${path}`, import.meta.url));

    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(width);
    expect(bytes.readUInt32BE(20)).toBe(height);
    expect(bytes.byteLength).toBeGreaterThan(200);
  }

  it('references the web app manifest and Apple touch icon from the root document', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
  });

  it('publishes the approved Servora-Med manifest identity and online start route', async () => {
    const source = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source);

    expect(manifest).toMatchObject({
      id: '/',
      name: 'Servora-Med',
      short_name: 'Servora-Med',
      start_url: '/jobs',
      scope: '/',
      display: 'standalone',
      background_color: '#f1f5f7',
      theme_color: '#276e9b',
      lang: 'tr',
      prefer_related_applications: false,
    });
  });

  it('publishes a non-empty 192px install icon at the manifest path', async () => {
    const source = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source);

    expect(manifest.icons).toContainEqual({
      src: '/icons/servora-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    });
    await expectPng('/icons/servora-192.png', 192, 192);
  });

  it('publishes a non-empty 512px install icon at the manifest path', async () => {
    const source = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source);

    expect(manifest.icons).toContainEqual({
      src: '/icons/servora-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    });
    await expectPng('/icons/servora-512.png', 512, 512);
  });

  it('publishes a separate maskable 512px icon at the manifest path', async () => {
    const source = await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
    const manifest = JSON.parse(source);

    expect(manifest.icons).toContainEqual({
      src: '/icons/servora-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
    await expectPng('/icons/servora-maskable-512.png', 512, 512);
  });

  it('publishes a non-empty 180px Apple touch icon', async () => {
    await expectPng('/icons/apple-touch-icon.png', 180, 180);
  });

  it('publishes a small monochrome notification badge asset', async () => {
    await expectPng('/icons/notification-badge.png', 96, 96);
    const bytes = await readFile(new URL('../public/icons/notification-badge.png', import.meta.url));
    expect(bytes[25]).toBe(6);
  });
});
