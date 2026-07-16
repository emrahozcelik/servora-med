import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PasswordChangeScreen, validatePasswordChange } from '../src/PasswordChange';
import { App } from '../src/App';

const forcedUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF' as const, mustChangePassword: true, isActive: true, version: 1 };

describe('mandatory password change UI', () => {
  it('validates confirmation before submission', () => {
    expect(validatePasswordChange('current-password', 'new-secure-password', 'different-password'))
      .toBe('Yeni parola ve doğrulama alanları eşleşmiyor.');
    expect(validatePasswordChange('current-password', 'short', 'short'))
      .toBe('Yeni parola 12 ile 128 karakter arasında olmalıdır.');
    expect(validatePasswordChange('current-password', 'new-secure-password', 'new-secure-password')).toBeNull();
  });

  it('renders labeled password controls with correct autocomplete', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen user={forcedUser} onChanged={() => {}} onSignedOut={() => {}} />);
    expect(html).toContain('Parolanızı değiştirin');
    expect(html).toContain('for="current-password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('Yeni parolayı doğrulayın');
  });

  it('shows length requirements before submit with aria-describedby', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen user={forcedUser} onChanged={() => {}} onSignedOut={() => {}} />);
    expect(html).toMatch(/12/);
    expect(html).toMatch(/128/);
    expect(html).toContain('aria-describedby="new-password-hint"');
    expect(html).toContain('En az 12, en fazla 128 karakter.');
  });

  it('intercepts the protected workspace for forced-change users', () => {
    const html = renderToStaticMarkup(<App initialUser={forcedUser} />);
    expect(html).toContain('Parolanızı değiştirin');
    expect(html).not.toContain('İşlerim');
    expect(html).not.toContain('Onay kuyruğu');
  });
});
