import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App';

function renderApp(element: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={['/jobs']}>{element}</MemoryRouter>);
}

describe('App', () => {
  it('renders an accessible labeled login form for a signed-out user', () => {
    const html = renderApp(<App initialUser={null} />);

    expect(html).toContain('<main');
    expect(html).toContain('>Hesabınıza giriş yapın</h1>');
    expect(html).toContain('İş ve operasyon yönetimi');
    // One centred column: the marketing intro band and its duplicate brand
    // sentence are gone (UI audit F-16).
    expect(html).not.toContain('Günlük işlerinizi tek yerden yönetin.');
    expect(html).not.toContain('Dünya Dental — iş ve operasyon yönetimi');
    expect(html).not.toContain('Güvenli erişim');
    expect((html.match(/class="eyebrow"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-describedby="login-help"');
    expect(html).not.toContain('Medikal ve dental ekipler');
    expect(html).not.toContain('Saha operasyonları');
    expect(html).toContain('<label for="email">E-posta</label>');
    expect(html).toContain('<label for="password">Parola</label>');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).not.toContain('dashboard');
  });

  it('offers a labeled password visibility toggle and keeps build metadata off the login screen', () => {
    const html = renderApp(<App initialUser={null} />);

    expect(html).toContain('class="password-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Parolayı göster"');
    expect(html).toContain('>Göster</button>');
    expect(html).toContain('id="password-caps-hint"');
    expect(html).toContain('role="status"');
    // Release identity remains in the authenticated shell only.
    expect(html).not.toContain('build-identity');
    expect(html).not.toContain('Servora Med');
  });

  it('renders a backend-derived protected shell without fake metrics', () => {
    const html = renderApp(<App initialUser={{
      id: 'user-1', organizationId: 'org-1', name: 'Emrah Admin',
      email: 'admin@example.com', role: 'ADMIN', mustChangePassword: false,
    }} />);
    expect(html).toContain('Emrah Admin');
    expect(html).toContain('İşler');
    expect(html).toContain('Oturumu kapat');
    expect(html).toContain('İşler yükleniyor');
    expect(html).toContain('<aside');
    expect(html).toContain('aria-label="Ana navigasyon"');
  });
});
