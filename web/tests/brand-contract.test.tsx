/** @vitest-environment jsdom */
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DunyaDentalBrand } from '../src/shell/DunyaDentalBrand';

describe('DunyaDentalBrand variant source map', () => {
  it('uses the canonical full source for authenticated and login-hero variants', () => {
    const full = renderToStaticMarkup(<DunyaDentalBrand variant="full" />);
    const loginHero = renderToStaticMarkup(<DunyaDentalBrand variant="login-hero" />);

    expect(full).toContain('src="/branding/dunya-dental-sidebar.png"');
    expect(loginHero).toContain('src="/branding/dunya-dental-sidebar.png"');
    expect(full).not.toContain('/branding/dunya-dental.png');
    expect(loginHero).not.toContain('/branding/dunya-dental.png');
  });

  it('links only when a home target is supplied and keeps image text decorative', () => {
    const linked = renderToStaticMarkup(
      <MemoryRouter>
        <DunyaDentalBrand variant="full" to="/overview" />
      </MemoryRouter>,
    );
    const standalone = renderToStaticMarkup(<DunyaDentalBrand variant="login-hero" />);

    expect(linked).toContain('href="/overview"');
    expect(linked).toContain('aria-label="Dünya Dental ana sayfa"');
    expect(linked).toContain('alt=""');
    expect(standalone).toContain('aria-label="Dünya Dental"');
    expect(standalone).not.toContain('<a ');
    expect(standalone).toContain('alt=""');
  });

  it('preserves the fallback and activation callback for linked shell brands', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let activated = 0;

    await act(async () => root.render(
      <MemoryRouter>
        <DunyaDentalBrand variant="full" to="/jobs" onNavigate={() => { activated += 1; }} />
      </MemoryRouter>,
    ));

    const link = container.querySelector<HTMLAnchorElement>('a[href="/jobs"]')!;
    await act(async () => link.click());
    await act(async () => link.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true })));

    expect(activated).toBe(1);
    expect(link.querySelector('img')).toBeNull();
    expect(link.textContent).toContain('Dünya Dental');

    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps the non-linked login hero fallback visible and named', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<DunyaDentalBrand variant="login-hero" />));
    const brand = container.querySelector<HTMLElement>('.dunya-dental-brand--login-hero')!;
    await act(async () => brand.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true })));

    expect(brand.tagName).toBe('SPAN');
    expect(brand.getAttribute('aria-label')).toBe('Dünya Dental');
    expect(brand.querySelector('a')).toBeNull();
    expect(brand.querySelector('img')).toBeNull();
    expect(brand.textContent).toContain('Dünya Dental');

    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps login sizing and authenticated full-brand sizing explicit', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

    expect(css).toMatch(/\.dunya-dental-brand--login-hero\s*\{[^}]*margin-inline-start:\s*-0\.75rem/s);
    expect(css).toMatch(/\.dunya-dental-brand--login-hero img\s*\{[^}]*width:\s*clamp\(13rem,\s*15vw,\s*14rem\)[^}]*height:\s*auto[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.dunya-dental-brand--login-hero\s*\{[^}]*margin-inline-start:\s*-0\.25rem/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.dunya-dental-brand--login-hero img\s*\{[^}]*width:\s*clamp\(8rem,\s*35vw,\s*9rem\)[^}]*height:\s*auto/s);
    expect(css).toMatch(/\.dunya-dental-brand--full img\s*\{[^}]*max-height:\s*8rem/s);
    expect(css).not.toMatch(/dunya-dental-brand--(?:login\s|sidebar|topbar)/);
  });
});
