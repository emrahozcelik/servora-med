/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AppleInstallGuidance } from '../src/install/AppleInstallGuidance';

describe('Apple install guidance card', () => {
  it('renders the accessible non-modal guidance with the full step list', () => {
    const html = renderToStaticMarkup(<AppleInstallGuidance onDismiss={() => {}} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('ana ekrana ekleyin');
    expect(html).toContain('Sayfayı Safari');
    expect(html).toContain('Paylaş düğmesine dokunun.');
    expect(html).toContain('Ana Ekrana Ekle');
    expect(html).toContain('Web Uygulaması Olarak Aç');
    expect(html).toContain('Ekle');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alertdialog"');
  });

  it('exposes the dismiss action with a clear accessible label', () => {
    const onDismiss = vi.fn();
    const html = renderToStaticMarkup(<AppleInstallGuidance onDismiss={onDismiss} />);
    expect(html).toContain('aria-label="Kurulum yönergesini kapat"');
  });
});
