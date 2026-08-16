/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DunyaDentalBrand } from '../src/shell/DunyaDentalBrand';

describe('DunyaDentalBrand variant source map', () => {
  it('uses the cropped mark for login and sidebar while preserving the topbar source', () => {
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="sidebar" />))
      .toContain('src="/branding/dunya-dental-sidebar.png"');
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="login" />))
      .toContain('src="/branding/dunya-dental-sidebar.png"');
    expect(renderToStaticMarkup(<DunyaDentalBrand variant="topbar" />))
      .toContain('src="/branding/dunya-dental.png"');
  });

  it('keeps the decorative image and accessible label contract', () => {
    const html = renderToStaticMarkup(<DunyaDentalBrand variant="topbar" />);
    expect(html).toContain('aria-label="Dünya Dental"');
    expect(html).toContain('alt=""');
  });

  it('uses visible-artwork-first login sizing without changing authenticated shell variants', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

    expect(css).toMatch(/\.dunya-dental-brand--login\s*\{[^}]*margin-inline-start:\s*-0\.75rem/s);
    expect(css).toMatch(/\.dunya-dental-brand--login img\s*\{[^}]*width:\s*clamp\(13rem,\s*15vw,\s*14rem\)[^}]*height:\s*auto[^}]*max-width:\s*100%/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.dunya-dental-brand--login\s*\{[^}]*margin-inline-start:\s*-0\.25rem/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.dunya-dental-brand--login img\s*\{[^}]*width:\s*clamp\(8rem,\s*35vw,\s*9rem\)[^}]*height:\s*auto/s);
    expect(css).toMatch(/\.dunya-dental-brand--topbar img\s*\{[^}]*height:\s*2\.25rem/s);
    expect(css).toMatch(/\.dunya-dental-brand--sidebar img\s*\{[^}]*max-height:\s*8rem/s);
  });
});
