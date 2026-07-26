import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { validatePasswordChange } from '../PasswordChange';
import { paths } from '../paths';
import { changePassword, type CurrentUser } from '../services/api';
import { PASSWORD_LENGTH_HINT_TR } from '../ui/password-policy';
import { useWebPush } from '../web-push/WebPushProvider';

const roleLabels = {
  ADMIN: 'Yönetici',
  MANAGER: 'Müdür',
  STAFF: 'Personel',
} as const;

function SettingsHeader({ title, description }: { title: string; description: string }) {
  return <header className="workspace-heading"><div>
    <p className="eyebrow">Hesap</p><h1>{title}</h1><p>{description}</p>
  </div></header>;
}

export function SettingsLandingPage() {
  return <main className="workspace settings-workspace">
    <SettingsHeader title="Ayarlar" description="Hesap bilgilerinizi, güvenliğinizi ve bu cihazın bildirim tercihlerini yönetin." />
    <nav className="settings-card-grid" aria-label="Ayar bölümleri">
      <Link to={paths.settingsProfile}><span>Profil</span><small>Hesap ve rol bilgilerinizi görüntüleyin.</small></Link>
      <Link to={paths.settingsSecurity}><span>Güvenlik</span><small>Parolanızı güvenli biçimde değiştirin.</small></Link>
      <Link to={paths.settingsNotifications}><span>Bildirimler</span><small>Bu cihazdaki web bildirimlerini yönetin.</small></Link>
    </nav>
  </main>;
}

export function ProfileSettingsPage({ user }: { user: CurrentUser }) {
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase('tr-TR')).join('');
  return <main className="workspace settings-workspace">
    <SettingsHeader title="Profil" description="Kurumunuz tarafından yönetilen hesap bilgileri." />
    <section className="settings-panel" aria-labelledby="profile-details-title">
      <div className="profile-initials" aria-hidden="true">{initials || 'SM'}</div>
      <div><h2 id="profile-details-title">{user.name}</h2>
        <dl className="profile-details">
          <div><dt>E-posta</dt><dd>{user.email}</dd></div>
          <div><dt>Rol</dt><dd>{roleLabels[user.role]}</dd></div>
        </dl>
        <p className="field-hint">Bu bilgiler kurum yöneticiniz tarafından yönetilir.</p>
      </div>
    </section>
  </main>;
}

export function SecuritySettingsPage({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    const validation = validatePasswordChange(currentPassword, newPassword, confirmation);
    if (validation) { setError(validation); return; }
    setPending(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setChanged(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Parola değiştirilemedi.');
    } finally {
      setPending(false);
    }
  }

  if (changed) return <main className="workspace settings-workspace">
    <SettingsHeader title="Parolanız değiştirildi" description="Güvenliğiniz için mevcut oturumlarınız kapatıldı." />
    <section className="settings-panel"><p role="status">Yeni parolanızla yeniden giriş yapabilirsiniz.</p>
      <button type="button" className="primary-button" onClick={onSessionEnded}>Giriş ekranına dön</button></section>
  </main>;

  return <main className="workspace settings-workspace">
    <SettingsHeader title="Güvenlik" description="Parolanızı değiştirmeniz tüm mevcut oturumları kapatır." />
    <section className="settings-panel settings-form-panel">
      {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
      <form onSubmit={submit}>
        <div className="field-group"><label htmlFor="settings-current-password">Mevcut parola</label>
          <input id="settings-current-password" name="currentPassword" type="password" autoComplete="current-password" required disabled={pending} /></div>
        <div className="field-group"><label htmlFor="settings-new-password">Yeni parola</label>
          <input id="settings-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} aria-describedby="settings-password-hint" />
          <p id="settings-password-hint" className="field-hint">{PASSWORD_LENGTH_HINT_TR}</p></div>
        <div className="field-group"><label htmlFor="settings-password-confirmation">Yeni parolayı doğrulayın</label>
          <input id="settings-password-confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} /></div>
        <button className="primary-button" type="submit" disabled={pending}>{pending ? 'Değiştiriliyor…' : 'Parolayı değiştir'}</button>
      </form>
    </section>
  </main>;
}

const capabilityLabels = {
  supported: 'Destekleniyor',
  unsupported: 'Desteklenmiyor',
} as const;

const permissionLabels = {
  granted: 'İzin verildi',
  denied: 'İzin reddedildi',
  default: 'Henüz sorulmadı',
  unsupported: 'Desteklenmiyor',
} as const;

export function NotificationSettingsPage() {
  const webPush = useWebPush();
  const canEnable = webPush.enabled === true
    && webPush.capability === 'supported'
    && webPush.permission !== 'denied';
  return <main className="workspace settings-workspace">
    <SettingsHeader title="Bildirimler" description="Yalnızca bu tarayıcı ve cihazdaki web bildirimlerini yönetin." />
    <section className="settings-panel" aria-labelledby="device-notifications-title">
      <h2 id="device-notifications-title">Bu cihaz</h2>
      <dl className="profile-details">
        <div><dt>Tarayıcı desteği</dt><dd>{capabilityLabels[webPush.capability]}</dd></div>
        <div><dt>Tarayıcı izni</dt><dd>{permissionLabels[webPush.permission]}</dd></div>
        <div><dt>Bildirim durumu</dt><dd>{webPush.status?.subscription ? 'Açık' : 'Kapalı'}</dd></div>
      </dl>
      {webPush.error && <div className="form-error" role="alert">{webPush.error}</div>}
      {webPush.permission === 'denied' && <p className="field-hint">İzin tarayıcı ayarlarında reddedilmiş. Açmak için bu siteye ait bildirim iznini tarayıcınızdan değiştirin.</p>}
      {webPush.capability === 'unsupported' && <p className="field-hint">Bu tarayıcı veya çalışma biçimi web bildirimlerini desteklemiyor.</p>}
      {webPush.status?.subscription
        ? <button className="secondary-button" type="button" disabled={webPush.pending !== null} onClick={() => void webPush.disable()}>
          {webPush.pending === 'disable' ? 'Kapatılıyor…' : 'Bu cihazda kapat'}</button>
        : <button className="primary-button" type="button" disabled={!canEnable || webPush.pending !== null} onClick={() => void webPush.enable()}>
          {webPush.pending === 'enable' ? 'Açılıyor…' : 'Bu cihazda aç'}</button>}
    </section>
  </main>;
}
