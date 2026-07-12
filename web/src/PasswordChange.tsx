import { useEffect, useRef, useState, type FormEvent } from 'react';

import { changePassword, logout, type CurrentUser } from './services/api';

export function validatePasswordChange(current: string, next: string, confirmation: string) {
  if (!current) return 'Mevcut parola zorunludur.';
  if (next.length < 12 || next.length > 128) return 'Yeni parola 12 ile 128 karakter arasında olmalıdır.';
  if (next !== confirmation) return 'Yeni parola ve doğrulama alanları eşleşmiyor.';
  return null;
}

export function PasswordChangeScreen({ user, onChanged, onSignedOut }: {
  user: CurrentUser; onChanged: () => void; onSignedOut: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    const validation = validatePasswordChange(currentPassword, newPassword, confirmation);
    if (validation) { setError(validation); return; }
    setPending(true);
    try { await changePassword({ currentPassword, newPassword }); setChanged(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Parola değiştirilemedi.'); }
    finally { setPending(false); }
  }

  async function signOut() {
    setPending(true);
    try { await logout(); } finally { onSignedOut(); }
  }

  if (changed) return <main className="login-panel"><section className="login-form-wrap" aria-labelledby="password-changed-title">
    <p className="eyebrow">Güvenli erişim</p><h1 id="password-changed-title">Parolanız değiştirildi</h1>
    <p className="form-intro" role="status">Yeni parolanızla yeniden giriş yapabilirsiniz.</p>
    <button className="primary-button" type="button" onClick={onChanged}>Giriş ekranına dön</button>
  </section></main>;

  return <main className="login-panel"><section className="login-form-wrap" aria-labelledby="password-change-title">
    <p className="eyebrow">İlk giriş güvenliği</p><h1 id="password-change-title">Parolanızı değiştirin</h1>
    <p className="form-intro">{user.name}, devam etmek için size verilen geçici parolayı yenileyin.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    <form onSubmit={submit}>
      <div className="field-group"><label htmlFor="current-password">Mevcut parola</label>
        <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required disabled={pending} /></div>
      <div className="field-group"><label htmlFor="new-password">Yeni parola</label>
        <input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} /></div>
      <div className="field-group"><label htmlFor="password-confirmation">Yeni parolayı doğrulayın</label>
        <input id="password-confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} /></div>
      <button className="primary-button" type="submit" disabled={pending}>{pending ? 'Değiştiriliyor…' : 'Parolayı değiştir'}</button>
      <button className="secondary-button password-signout" type="button" onClick={signOut} disabled={pending}>Oturumu kapat</button>
    </form>
  </section></main>;
}
