import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App';

describe('App', () => {
  it('renders an accessible labeled login form for a signed-out user', () => {
    const html = renderToStaticMarkup(<App initialUser={null} />);

    expect(html).toContain('<main');
    expect(html).toContain('>Hesabınıza giriş yapın</h1>');
    expect(html).toContain('<label for="email">E-posta</label>');
    expect(html).toContain('<label for="password">Parola</label>');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('dashboard');
  });

  it('renders a backend-derived protected shell without fake metrics', () => {
    const html = renderToStaticMarkup(<App initialUser={{
      id: 'user-1', organizationId: 'org-1', name: 'Emrah Admin',
      email: 'admin@example.com', role: 'ADMIN', mustChangePassword: false,
    }} />);
    expect(html).toContain('Emrah Admin');
    expect(html).toContain('Onay kuyruğu');
    expect(html).toContain('Oturumu kapat');
    expect(html).toContain('Onay bekleyen işler yükleniyor');
  });
});
