import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { paths } from './paths';
import {
  changeUserRole, createUser, getUser, listUsers,
  resetUserPassword, updateUser, type ManagedUser,
} from './services/people-api';
import { PASSWORD_LENGTH_HINT_TR } from './ui/password-policy';
import { isInteractiveTarget } from './ui/clickable-card';

const roleLabel = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function UserListView({ users, onCreate, onOpen }: { users: ManagedUser[]; onCreate: () => void; onOpen: (id: string) => void }) {
  return <main className="workspace"><div className="workspace-heading"><div><p className="eyebrow">Yönetim</p><h1>Kullanıcılar</h1></div>
    <button className="primary-button compact-button" type="button" onClick={onCreate}>Kullanıcı oluştur</button></div>
    {users.length === 0 ? <div className="workspace-message"><h2>Henüz kullanıcı yok</h2><p>İlk kullanıcıyı oluşturarak başlayın.</p></div>
      : <ul className="people-list">{users.map((user) => <li key={user.id}>
        <article className="people-row people-list-card" data-user-id={user.id}
          onClick={(event) => openCardIfEmpty(event, onOpen, user.id)}>
          <div className="people-identity">
            <h2><Link className="people-title-link" to={paths.user(user.id)}>{user.name}</Link></h2>
            <p>{user.email} · {roleLabel[user.role]}</p>
          </div>
        </article>
      </li>)}</ul>}
  </main>;
}

export function UserCreateForm({ managers, onCancel, onCreated }: { managers: ManagedUser[]; onCancel: () => void; onCreated: (user: ManagedUser) => void }) {
  const [role, setRole] = useState<ManagedUser['role']>('STAFF'); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null); useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(''); const data = new FormData(event.currentTarget);
    try { onCreated(await createUser({ name: String(data.get('name') ?? ''), email: String(data.get('email') ?? ''), role,
      temporaryPassword: String(data.get('temporaryPassword') ?? ''), ...(role === 'STAFF' ? { staffProfile: {
        title: String(data.get('title') ?? '') || null, phone: String(data.get('phone') ?? '') || null,
        region: String(data.get('region') ?? '') || null, managerUserId: String(data.get('managerUserId') ?? '') || null,
      } } : {}) })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Kullanıcı oluşturulamadı.'); setPending(false); }
  }
  return <main className="people-form"><div className="detail-heading"><div><p className="eyebrow">Yönetim</p><h1>Kullanıcı oluştur</h1></div><button className="secondary-button" onClick={onCancel}>Vazgeç</button></div>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    <form onSubmit={submit}><Field id="user-name" label="Ad soyad"><input id="user-name" name="name" required disabled={pending} /></Field>
      <Field id="user-email" label="E-posta"><input id="user-email" name="email" type="email" required disabled={pending} /></Field>
      <Field id="user-role" label="Rol"><select id="user-role" value={role} onChange={(e) => setRole(e.target.value as ManagedUser['role'])} disabled={pending}>
        <option value="STAFF">Personel</option><option value="MANAGER">Yönetici</option><option value="ADMIN">Sistem yöneticisi</option></select></Field>
      <Field id="temporary-password" label="Geçici parola" hintId="temporary-password-hint" hint={PASSWORD_LENGTH_HINT_TR}>
        <input id="temporary-password" name="temporaryPassword" type="password" minLength={12} maxLength={128} required disabled={pending} aria-describedby="temporary-password-hint" /></Field>
      {role === 'STAFF' && <><Field id="staff-title" label="Unvan"><input id="staff-title" name="title" /></Field>
        <Field id="staff-phone" label="Telefon"><input id="staff-phone" name="phone" type="tel" /></Field>
        <Field id="staff-region" label="Bölge"><input id="staff-region" name="region" /></Field>
        <Field id="staff-manager" label="Yönetici"><select id="staff-manager" name="managerUserId"><option value="">Atanmadı</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field></>}
      <button className="primary-button" disabled={pending}>{pending ? 'Oluşturuluyor…' : 'Kullanıcıyı oluştur'}</button></form>
  </main>;
}

function Field({ id, label, children, hint, hintId }: {
  id: string; label: string; children: React.ReactNode; hint?: string; hintId?: string;
}) {
  return <div className="field-group"><label htmlFor={id}>{label}</label>{children}
    {hint && hintId ? <p id={hintId} className="field-hint">{hint}</p> : null}</div>;
}

export function UserDetailView({ user: initial, onBack, onChanged }: { user: ManagedUser; onBack: () => void; onChanged: (user: ManagedUser) => void }) {
  const [user, setUser] = useState(initial); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  async function run(action: () => Promise<ManagedUser>, message: string) { setError(''); try { const next = await action(); setUser(next); onChanged(next); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : 'İşlem tamamlanamadı.'); } }
  return <main className="people-form"><div className="detail-heading"><div><p className="eyebrow">Kullanıcı</p><h1>{user.name}</h1></div><button className="secondary-button" onClick={onBack}>Listeye dön</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    <section><h2>Temel bilgiler</h2><form onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name') ?? ''); void run(() => updateUser(user.id, { expectedVersion: user.version, name }), 'Ad güncellendi.'); }}>
      <Field id="detail-name" label="Ad soyad"><input id="detail-name" name="name" defaultValue={user.name} required /></Field><button className="primary-button">Bilgileri kaydet</button></form></section>
    <section className="security-section"><h2>Rol ve erişim</h2>{user.role !== 'STAFF' && <form onSubmit={(e) => { e.preventDefault(); const role = String(new FormData(e.currentTarget).get('role')) as 'ADMIN' | 'MANAGER'; void run(() => changeUserRole(user.id, { expectedVersion: user.version, role }), 'Rol güncellendi.'); }}>
      <Field id="detail-role" label="Rol"><select id="detail-role" name="role" defaultValue={user.role}><option value="ADMIN">Sistem yöneticisi</option><option value="MANAGER">Yönetici</option></select></Field><button className="primary-button">Rolü değiştir</button></form>}
      <form onSubmit={(e) => { e.preventDefault(); const temporaryPassword = String(new FormData(e.currentTarget).get('temporaryPassword') ?? ''); if (window.confirm('Parola sıfırlansın ve tüm oturumlar kapatılsın mı?')) void run(() => resetUserPassword(user.id, { expectedVersion: user.version, temporaryPassword }), 'Geçici parola kaydedildi.'); }}>
        <Field id="reset-password" label="Geçici parola belirle" hintId="reset-password-hint" hint={PASSWORD_LENGTH_HINT_TR}>
          <input id="reset-password" name="temporaryPassword" type="password" minLength={12} maxLength={128} required aria-describedby="reset-password-hint" /></Field>
        <button className="secondary-button command-button">Parolayı sıfırla</button></form>
    </section></main>;
}

export function UserListScreen() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const load = () => { setState('loading'); listUsers().then((value) => { setUsers(value); setState('ready'); }).catch(() => setState('error')); };
  useEffect(load, []);
  if (state === 'loading') return <main className="workspace" aria-busy="true"><h1>Kullanıcılar yükleniyor</h1></main>;
  if (state === 'error') return <main className="workspace"><div role="alert" className="workspace-message"><h1>Kullanıcılar yüklenemedi</h1><button className="secondary-button" onClick={load}>Tekrar dene</button></div></main>;
  return <>
    <button className="back-link" type="button" onClick={() => navigate(paths.jobs)}>İşlere dön</button>
    <UserListView users={users} onCreate={() => navigate(paths.newUser)}
      onOpen={(id) => navigate(paths.user(id))} />
  </>;
}

export function UserCreateScreen() {
  const navigate = useNavigate();
  const [managers, setManagers] = useState<ManagedUser[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    listUsers().then((value) => { setManagers(value.filter((u) => u.role === 'MANAGER' && u.isActive)); setState('ready'); })
      .catch(() => setState('error'));
  }, []);
  if (state === 'loading') return <main className="workspace" aria-busy="true"><h1>Kullanıcı formu yükleniyor</h1></main>;
  if (state === 'error') return <main className="workspace"><div role="alert" className="workspace-message"><h1>Kullanıcı formu yüklenemedi</h1>
    <button className="secondary-button" type="button" onClick={() => navigate(paths.users)}>Listeye dön</button></div></main>;
  return <UserCreateForm managers={managers} onCancel={() => navigate(paths.users)}
    onCreated={(created) => navigate(paths.user(created.id))} />;
}

export function UserDetailScreen() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState<ManagedUser | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    setUser(null);
    setLoading(true);
    setError('');
    getUser(userId)
      .then((next) => { if (active) setUser(next); })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Kullanıcı yüklenemedi.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);
  if (!userId) return <main className="workspace"><div className="workspace-message" role="alert"><h1>Kullanıcı bulunamadı</h1></div></main>;
  if (loading) return <main className="workspace" aria-busy="true"><h1>Kullanıcı yükleniyor</h1></main>;
  if (!user) return <main className="workspace"><div className="workspace-message" role="alert"><h1>Kullanıcı yüklenemedi</h1><p>{error}</p>
    <button className="secondary-button" type="button" onClick={() => navigate(paths.users)}>Listeye dön</button></div></main>;
  return <UserDetailView user={user} onBack={() => navigate(paths.users)} onChanged={setUser} />;
}

/** @deprecated Prefer routed screens; kept for existing imports. */
export function UserManagementScreen({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(paths.users, { replace: true }); }, [navigate]);
  return <main className="workspace"><button className="back-link" type="button" onClick={onBack}>İşlere dön</button>
    <p>Kullanıcı listesine yönlendiriliyorsunuz…</p></main>;
}
