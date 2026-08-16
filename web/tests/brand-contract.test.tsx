/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DunyaDentalBrand } from '../src/shell/DunyaDentalBrand';

describe('DunyaDentalBrand variant source map', () => {
  it('uses the cropped mark in the sidebar and the existing wordmark elsewhere', () => {
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="sidebar" />))
      .toContain('src="/branding/dunya-dental-sidebar.png"');
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="login" />))
      .toContain('src="/branding/dunya-dental.png"');
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="topbar" />))
      .toContain('src="/branding/dunya-dental.png"');
  });

  it('keeps the decorative image and accessible label contract', () => {
    const html = renderToStaticMarkup(<DunyaDentalBrand variant="topbar" />);
    expect(html).toContain('aria-label="Dünya Dental"');
    expect(html).toContain('alt=""');
  });

  it('gives the login brand a materially larger responsive size without changing shell variants', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

    expect(css).toMatch(/\.dunya-dental-brand--login img\s*\{[^}]*height:\s*clamp\(6rem,\s*8vw,\s*7\.5rem\)/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.dunya-dental-brand--login img\s*\{[^}]*height:\s*clamp\(5rem,\s*22vw,\s*6rem\)/s);
    expect(css).toMatch(/\.dunya-dental-brand--topbar img\s*\{[^}]*height:\s*2\.25rem/s);
    expect(css).toMatch(/\.dunya-dental-brand--sidebar img\s*\{[^}]*max-height:\s*8rem/s);
  });
});
