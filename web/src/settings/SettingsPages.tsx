import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { validatePasswordChange } from '../PasswordChange';
import { paths } from '../paths';
import { changePassword, type CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { RecordDescriptions } from '../ui/antd/RecordDescriptions';
import { SettingsTabs } from '../ui/antd/SettingsTabs';
import { UserAvatar } from '../ui/antd/UserAvatar';
import { PASSWORD_LENGTH_HINT_TR } from '../ui/password-policy';
import { useWebPush } from '../web-push/WebPushProvider';

const roleLabels = {
  ADMIN: 'Yönetici',
  MANAGER: 'Müdür',
  STAFF: 'Personel',
} as const;

const SETTINGS_TABS = [
  { key: 'profile', label: 'Profil', to: '/settings/profile' },
  { key: 'security', label: 'Güvenlik', to: '/settings/security' },
  { key: 'notifications', label: 'Bildirimler', to: '/settings/notifications' },
];

const settingsLandingItems = [
  { key: 'profile', title: 'Profil', description: 'Hesap ve rol bilgilerinizi görüntüleyin.', to: paths.settingsProfile },
  { key: 'security', title: 'Güvenlik', description: 'Parolanızı güvenli biçimde değiştirin.', to: paths.settingsSecurity },
  { key: 'notifications', title: 'Bildirimler', description: 'Bu cihazdaki web bildirimlerini yönetin.', to: paths.settingsNotifications },
];

export function SettingsLandingPage() {
  return <main className="workspace settings-workspace">
    <header className="workspace-heading"><div>
      <p className="eyebrow">Hesap</p><h1>Ayarlar</h1>
    </div></header>
    <nav className="settings-card-grid" aria-label="Ayar bölümleri">
      {settingsLandingItems.map((item) => (
        <Link key={item.key} to={item.to} className="settings-card-link">
          <OperationalCard title={item.title}>
            <small>{item.description}</small>
          </OperationalCard>
        </Link>
      ))}
    </nav>
  </main>;
}

export function ProfileSettingsPage({ user }: { user: CurrentUser }) {
  return <main className="workspace settings-workspace">
    <SettingsTabs items={SETTINGS_TABS} activeKey="profile" />
    <header className="workspace-heading"><div>
      <p className="eyebrow">Hesap</p><h1>Profil</h1>
    </div></header>
    <OperationalCard title="Profil bilgileri">
      <div className="profile-header">
        <UserAvatar name={user.name} size="large" />
        <div>
          <strong>{user.name}</strong>
          <small className="text-muted">{roleLabels[user.role]}</small>
        </div>
      </div>
      <RecordDescriptions
        ariaLabel="Profil bilgileri"
        items={[
          { key: 'email', label: 'E-posta', content: user.email },
          { key: 'role', label: 'Rol', content: roleLabels[user.role] },
        ]}
      />
      <small className="settings-hint">
        Profil bilgileriniz kuruluş yöneticiniz tarafından yönetilmektedir.
      </small>
    </OperationalCard>
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
    <SettingsTabs items={SETTINGS_TABS} activeKey="security" />
    <header className="workspace-heading"><div>
      <p className="eyebrow">Hesap</p><h1>Parolanız değiştirildi</h1>
    </div></header>
    <OperationalCard title="Parola değiştir">
      <p role="status">Yeni parolanızla yeniden giriş yapabilirsiniz.</p>
      <button type="button" className="primary-button" onClick={onSessionEnded}>Giriş ekranına dön</button>
    </OperationalCard>
  </main>;

  return <main className="workspace settings-workspace">
    <SettingsTabs items={SETTINGS_TABS} activeKey="security" />
    <header className="workspace-heading"><div>
      <p className="eyebrow">Hesap</p><h1>Güvenlik</h1>
    </div></header>
    <OperationalCard title="Parola değiştir">
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
    </OperationalCard>
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
    <SettingsTabs items={SETTINGS_TABS} activeKey="notifications" />
    <header className="workspace-heading"><div>
      <p className="eyebrow">Hesap</p><h1>Bildirimler</h1>
    </div></header>
    <OperationalCard title="Cihaz bildirimleri">
      <h2 id="device-notifications-title" className="sr-only">Bu cihaz</h2>
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
    </OperationalCard>
  </main>;
}
