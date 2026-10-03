import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PasswordChangeScreen, validatePasswordChange } from '../src/PasswordChange';
import { App } from '../src/App';

const forcedUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF' as const, mustChangePassword: true, isActive: true, version: 1 };

describe('mandatory password change UI', () => {
  it('validates confirmation before submission', () => {
    expect(validatePasswordChange('current-password', 'Serv1!', 'different-password'))
      .toBe('Yeni parola ve doğrulama alanları eşleşmiyor.');
    expect(validatePasswordChange('current-password', 'Serv1!', 'Serv1!')).toBeNull();
  });

  it('mirrors the composition policy client-side', () => {
    expect(validatePasswordChange('current-password', 'A1!bc', 'A1!bc'))
      .toBe('Yeni parola 6 ile 128 karakter arasında olmalıdır.');
    expect(validatePasswordChange('current-password', 'serv1!', 'serv1!'))
      .toBe('Yeni parola en az bir büyük harf içermelidir.');
    expect(validatePasswordChange('current-password', 'Server!', 'Server!'))
      .toBe('Yeni parola en az bir rakam içermelidir.');
    expect(validatePasswordChange('current-password', 'Server1', 'Server1'))
      .toBe('Yeni parola en az bir sembol içermelidir (boşluk sembol sayılmaz).');
    expect(validatePasswordChange('current-password', 'Abc1 2', 'Abc1 2'))
      .toBe('Yeni parola en az bir sembol içermelidir (boşluk sembol sayılmaz).');
  });

  it('accepts the 6-character boundary and Turkish uppercase', () => {
    expect(validatePasswordChange('current-password', 'Serv1!', 'Serv1!')).toBeNull();
    expect(validatePasswordChange('current-password', 'Şifre1!', 'Şifre1!')).toBeNull();
  });

  it('renders labeled password controls with correct autocomplete', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen user={forcedUser} onChanged={() => {}} onSignedOut={() => {}} />);
    expect(html).toContain('Parolanızı değiştirin');
    expect(html).toContain('for="current-password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('Yeni parolayı doğrulayın');
  });

  it('shows composition requirements before submit with aria-describedby', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen user={forcedUser} onChanged={() => {}} onSignedOut={() => {}} />);
    expect(html).toContain('minLength="6"');
    expect(html).toContain('maxLength="128"');
    expect(html).toContain('aria-describedby="new-password-hint"');
    expect(html).toContain('6–128 karakter; en az bir büyük harf, bir rakam ve bir sembol.');
  });

  it('intercepts the protected workspace for forced-change users', () => {
    const html = renderToStaticMarkup(<App initialUser={forcedUser} />);
    expect(html).toContain('Parolanızı değiştirin');
    expect(html).not.toContain('İşlerim');
    expect(html).not.toContain('Onay kuyruğu');
  });
});
