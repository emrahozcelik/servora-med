/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
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
});
