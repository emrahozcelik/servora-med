import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { paths } from './paths';
import {
  activateUser, changeUserRole, createUser, deactivateUser, getUser, listUsers,
  permanentlyDeleteUser, resetUserPassword, updateUser, type ManagedUser, type ManagedUserDetails,
} from './services/people-api';
import {
  NEW_PASSWORD_MAX_LENGTH,
  NEW_PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_HINT_TR,
  newPasswordPolicyMessage,
  validateNewPasswordPolicy,
} from './ui/password-policy';
import { PageHeader } from './ui/PageHeader';
import { ConfirmationAction } from './ui/antd/ConfirmationAction';
import { useSetRouteRuntimeLabel } from './shell/resolved-identity';
import { EmptyState } from './ui/antd/EmptyState';
import { ResultState } from './ui/antd/ResultState';
import { isInteractiveTarget } from './ui/clickable-card';
import type { CurrentUser } from './services/api';
import { PeopleStatusFilterTabs, type PeopleStatusFilter } from './ui/PeopleStatusFilterTabs';
import { ServoraListPagination } from './ui/antd/ServoraPagination';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from './ui/pagination';
import { StaffOffboardingWorkflow } from './people/StaffOffboardingWorkflow';

const roleLabel = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function UserListView({ users, onCreate, onOpen, notice }: {
  users: ManagedUser[]; onCreate: () => void; onOpen: (id: string) => void; notice?: string;
}) {
  const [statusFilter, setStatusFilter] = useState<PeopleStatusFilter>('active');
  const [pageOffset, setPageOffset] = useState(0);
  const visibleUsers = users.filter((item) => statusFilter === 'all' || item.isActive === (statusFilter === 'active'));
  const boundedOffset = Math.min(pageOffset, lastListPageOffset(visibleUsers.length));
  return <main className="workspace"><PageHeader fallbackTitle="Kullanıcılar"
    actions={<button className="primary-button compact-button" type="button" onClick={onCreate}>Kullanıcı oluştur</button>} />
    {notice && <div className="success-message" role="status">{notice}</div>}
    {users.length > 0 && <PeopleStatusFilterTabs value={statusFilter} onChange={(next) => { setPageOffset(0); setStatusFilter(next); }} label="Kullanıcı durumu" />}
    {users.length === 0 ? <EmptyState title="Henüz kullanıcı yok" description="İlk kullanıcıyı oluşturarak başlayın." />
      : visibleUsers.length === 0 ? <EmptyState title={statusFilter === 'active' ? 'Aktif kullanıcı yok' : 'Pasif kullanıcı yok'}
        description={statusFilter === 'active' ? 'Pasif kullanıcıları görmek için Pasif veya Tümü seçin.' : 'Pasif kullanıcı bulunmuyor.'} />
      : <ul className="people-list">{visibleUsers.slice(boundedOffset, boundedOffset + DEFAULT_LIST_PAGE_SIZE).map((user) => <li key={user.id}>
        <article className="people-row people-list-card" data-user-id={user.id}
          onClick={(event) => openCardIfEmpty(event, onOpen, user.id)}>
          <div className="people-identity">
            <h2><Link className="people-title-link" to={paths.user(user.id)}>{user.name}</Link></h2>
            <p>{user.email} · {roleLabel[user.role]}{user.isActive ? '' : ' · Pasif'}</p>
          </div>
        </article>
      </li>)}</ul>}
    <ServoraListPagination total={visibleUsers.length} offset={boundedOffset} label="Kullanıcı sayfaları" itemName="kullanıcı" onOffsetChange={setPageOffset} />
  </main>;
}

export function UserCreateForm({ managers, onCancel, onCreated }: { managers: ManagedUser[]; onCancel: () => void; onCreated: (user: ManagedUser) => void }) {
  const [role, setRole] = useState<ManagedUser['role']>('STAFF'); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null); useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const data = new FormData(event.currentTarget);
    const temporaryPassword = String(data.get('temporaryPassword') ?? '');
    const policyIssue = validateNewPasswordPolicy(temporaryPassword);
    if (policyIssue) { setError(newPasswordPolicyMessage(policyIssue)); return; }
    setPending(true);
    try { onCreated(await createUser({ name: String(data.get('name') ?? ''), email: String(data.get('email') ?? ''), role,
      temporaryPassword, ...(role === 'STAFF' ? { staffProfile: {
        title: String(data.get('title') ?? '') || null, phone: String(data.get('phone') ?? '') || null,
        region: String(data.get('region') ?? '') || null, managerUserId: String(data.get('managerUserId') ?? '') || null,
      } } : {}) })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Kullanıcı oluşturulamadı.'); setPending(false); }
  }
  return <main className="people-form"><PageHeader fallbackTitle="Yeni kullanıcı" />
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    <form onSubmit={submit}><Field id="user-name" label="Ad soyad"><input id="user-name" name="name" required disabled={pending} /></Field>
      <Field id="user-email" label="E-posta"><input id="user-email" name="email" type="email" required disabled={pending} /></Field>
      <Field id="user-role" label="Rol"><select id="user-role" value={role} onChange={(e) => setRole(e.target.value as ManagedUser['role'])} disabled={pending}>
        <option value="STAFF">Personel</option><option value="MANAGER">Yönetici</option><option value="ADMIN">Sistem yöneticisi</option></select></Field>
      <Field id="temporary-password" label="Geçici parola" hintId="temporary-password-hint" hint={PASSWORD_POLICY_HINT_TR}>
        <input id="temporary-password" name="temporaryPassword" type="password" minLength={NEW_PASSWORD_MIN_LENGTH} maxLength={NEW_PASSWORD_MAX_LENGTH} required disabled={pending} aria-describedby="temporary-password-hint" /></Field>
      {role === 'STAFF' && <><Field id="staff-title" label="Unvan"><input id="staff-title" name="title" /></Field>
        <Field id="staff-phone" label="Telefon"><input id="staff-phone" name="phone" type="tel" /></Field>
        <Field id="staff-region" label="Bölge"><input id="staff-region" name="region" /></Field>
        <Field id="staff-manager" label="Yönetici"><select id="staff-manager" name="managerUserId"><option value="">Atanmadı</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field></>}
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
      <button className="primary-button compact-button" type="submit" disabled={pending}>{pending ? 'Oluşturuluyor…' : 'Kullanıcıyı oluştur'}</button></div></form>
  </main>;
}

function Field({ id, label, children, hint, hintId }: {
  id: string; label: string; children: React.ReactNode; hint?: string; hintId?: string;
}) {
  return <div className="field-group"><label htmlFor={id}>{label}</label>{children}
    {hint && hintId ? <p id={hintId} className="field-hint">{hint}</p> : null}</div>;
}

type UserDetailRecord = ManagedUser & Partial<Pick<ManagedUserDetails, 'canPermanentlyDelete' | 'permanentDeleteBlockers'>>;

const deleteBlockerLabels: Record<string, string> = {
  SELF: 'Kendi hesabınız',
  LAST_ADMIN: 'son aktif sistem yöneticisi olması',
  HAS_BUSINESS_HISTORY: 'operasyon geçmişi bulunması',
  HAS_ACTIVE_RESPONSIBILITIES: 'aktif sorumlulukları bulunması',
  DEMO_USER: 'Demo veri kümesine ait olması',
};

function permanentDeleteUnavailableMessage(user: UserDetailRecord) {
  const blockers = user.permanentDeleteBlockers ?? [];
  if (blockers.includes('DEMO_USER')) return 'Demo kullanıcıları Demo veri kümesi akışıyla kaldırılır; bu ekrandan kalıcı silinemez.';
  if (blockers.includes('HAS_BUSINESS_HISTORY') || blockers.includes('HAS_ACTIVE_RESPONSIBILITIES')) {
    return 'Operasyon geçmişi ve atıfları korunur. Bu kullanıcı kalıcı olarak silinemez; gerekiyorsa mevcut offboarding akışını kullanın.';
  }
  if (blockers.length > 0) {
    const reason = blockers.map((blocker) => deleteBlockerLabels[blocker] ?? blocker).join(', ');
    return `Kalıcı silme kullanılamıyor: ${reason}.`;
  }
  return null;
}

export function UserDetailView({ user: initial, viewer, onChanged, onDeleted, startWithFreshPreview = false }: {
  user: UserDetailRecord; viewer: Pick<CurrentUser, 'id' | 'organizationId' | 'role'>;
  onChanged: (user: ManagedUser) => void; onDeleted?: () => void; startWithFreshPreview?: boolean;
}) {
  const [user, setUser] = useState<UserDetailRecord>(initial); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDraft, setResetDraft] = useState('');
  const [resetPending, setResetPending] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const lifecycleBusy = useRef(false);
  const deactivateTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  async function run(action: () => Promise<ManagedUser>, message: string) {
    setError('');
    try {
      const next = await action();
      const merged = { ...user, ...next };
      setUser(merged); onChanged(merged); setNotice(message);
    } catch (e) { setError(e instanceof Error ? e.message : 'İşlem tamamlanamadı.'); }
  }
  async function runLifecycle(action: () => Promise<ManagedUser>, message: string) {
    if (lifecycleBusy.current) return;
    lifecycleBusy.current = true;
    setLifecyclePending(true);
    try { await run(action, message); }
    finally { lifecycleBusy.current = false; setLifecyclePending(false); }
  }
  async function confirmDeactivate() {
    if (lifecycleBusy.current || !deactivateOpen || !canDeactivate) return;
    await runLifecycle(() => deactivateUser(user.id, user.version), 'Kullanıcı devre dışı bırakıldı.');
    setDeactivateOpen(false);
  }
  async function permanentlyDelete() {
    if (user.canPermanentlyDelete !== true || deletePending || !deleteConfirmOpen) return;
    setError(''); setNotice(''); setDeletePending(true);
    try { await permanentlyDeleteUser(user.id, user.version); setDeleteConfirmOpen(false); onDeleted?.(); if (!onDeleted) setNotice('Kullanıcı kalıcı olarak silindi.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Kullanıcı silinemedi.'); setDeleteConfirmOpen(false); }
    finally { setDeletePending(false); }
  }

  function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const temporaryPassword = String(new FormData(event.currentTarget).get('temporaryPassword') ?? '');
    const policyIssue = validateNewPasswordPolicy(temporaryPassword);
    if (policyIssue) { setError(newPasswordPolicyMessage(policyIssue)); return; }
    setError(''); setResetDraft(temporaryPassword); setResetOpen(true);
  }

  async function confirmPasswordReset() {
    if (!resetOpen || resetPending) return;
    setResetPending(true);
    try {
      await run(() => resetUserPassword(user.id, { expectedVersion: user.version, temporaryPassword: resetDraft }), 'Geçici parola kaydedildi.');
      setResetOpen(false); setResetDraft('');
    } finally { setResetPending(false); }
  }
  const deleteUnavailable = permanentDeleteUnavailableMessage(user);
  const canDeactivate = viewer.role === 'ADMIN' && user.role !== 'STAFF' && user.isActive && viewer.id !== user.id;
  const canReactivate = viewer.role === 'ADMIN' && user.role !== 'STAFF' && !user.isActive;
  return <main className="people-form"><PageHeader eyebrow="Kullanıcı" fallbackTitle={user.name} />
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    <section><h2>Temel bilgiler</h2><form onSubmit={(e) => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name') ?? ''); void run(() => updateUser(user.id, { expectedVersion: user.version, name }), 'Ad güncellendi.'); }}>
      <Field id="detail-name" label="Ad soyad"><input ref={nameInputRef} id="detail-name" name="name" defaultValue={user.name} required /></Field><button className="primary-button">Bilgileri kaydet</button></form></section>
    <section className="security-section"><h2>Rol ve erişim</h2>{user.role !== 'STAFF' && <form onSubmit={(e) => { e.preventDefault(); const role = String(new FormData(e.currentTarget).get('role')) as 'ADMIN' | 'MANAGER'; void run(() => changeUserRole(user.id, { expectedVersion: user.version, role }), 'Rol güncellendi.'); }}>
      <Field id="detail-role" label="Rol"><select id="detail-role" name="role" defaultValue={user.role}><option value="ADMIN">Sistem yöneticisi</option><option value="MANAGER">Yönetici</option></select></Field><button className="primary-button">Rolü değiştir</button></form>}
      <form onSubmit={requestPasswordReset}>
        <Field id="reset-password" label="Geçici parola belirle" hintId="reset-password-hint" hint={PASSWORD_POLICY_HINT_TR}>
          <input id="reset-password" name="temporaryPassword" type="password" minLength={NEW_PASSWORD_MIN_LENGTH} maxLength={NEW_PASSWORD_MAX_LENGTH} required aria-describedby="reset-password-hint" /></Field>
        <button ref={resetTriggerRef} className="secondary-button command-button">Parolayı sıfırla</button></form>
      {viewer.role === 'ADMIN' && user.role === 'STAFF' && <StaffOffboardingWorkflow viewer={viewer} target={user}
        startWithFreshPreview={startWithFreshPreview}
        onCompleted={() => {
          setNotice('Personel erişimi sonlandırıldı.');
          getUser(user.id).then((next) => { setUser(next); onChanged(next); }).catch(() => {
            const inactive = { ...user, isActive: false };
            setUser(inactive); onChanged(inactive);
          });
        }} />}
      {canDeactivate && <button ref={deactivateTriggerRef} className="secondary-button command-button" type="button"
        disabled={lifecyclePending} aria-busy={lifecyclePending}
        onClick={() => { if (!lifecycleBusy.current) setDeactivateOpen(true); }}>Devre dışı bırak</button>}
      <ConfirmationAction open={deactivateOpen && canDeactivate}
        title="Kullanıcı devre dışı bırakılsın mı?"
        description="Bu kullanıcının tüm aktif oturumları kapatılacak. Gerektiğinde yeniden etkinleştirilebilir."
        confirmLabel="Devre dışı bırak" pending={lifecyclePending} destructive
        pendingLabel="Devre dışı bırakılıyor…"
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setDeactivateOpen(false)}
        returnFocusRef={deactivateTriggerRef} fallbackFocusRef={nameInputRef} />
      {canReactivate && <button className="secondary-button command-button" type="button" disabled={lifecyclePending} aria-busy={lifecyclePending}
        onClick={() => void runLifecycle(() => activateUser(user.id, user.version), 'Kullanıcı yeniden etkinleştirildi.')}>Yeniden etkinleştir</button>}
      {user.role === 'STAFF' && !user.isActive && <div className="lifecycle-notice" role="status">
        Bu personel ayrıldı ve yeniden etkinleştirilemez.
      </div>}
      {viewer.role === 'ADMIN' && user.canPermanentlyDelete === true && <div className="danger-command-section">
        <h3>Kalıcı kullanıcı silme</h3>
        <p>Bu işlem yalnızca operasyon geçmişi olmayan gerçek kullanıcılar için kullanılabilir. Bu işlem geri alınamaz.</p>
        <button ref={deleteTriggerRef} className="destructive-button command-button" type="button" onClick={() => setDeleteConfirmOpen(true)} disabled={deletePending}
          aria-busy={deletePending}>{deletePending ? 'Siliniyor…' : 'Kalıcı olarak sil'}</button>
      </div>}
      {viewer.role === 'ADMIN' && user.canPermanentlyDelete === false && deleteUnavailable && <div className="lifecycle-notice" role="status">
        {deleteUnavailable}
      </div>}
      <ConfirmationAction open={resetOpen}
        title="Geçici parola belirlensin mi?"
        description="Parola sıfırlanacak ve bu kullanıcının tüm açık oturumları kapatılacak."
        details={[`Kullanıcı: ${user.name}`, `E-posta: ${user.email}`]}
        confirmLabel="Parolayı sıfırla" pending={resetPending} pendingLabel="Parola sıfırlanıyor…"
        onConfirm={() => void confirmPasswordReset()}
        onCancel={() => { if (!resetPending) { setResetOpen(false); setResetDraft(''); } }}
        returnFocusRef={resetTriggerRef} fallbackFocusRef={nameInputRef} />
      <ConfirmationAction open={deleteConfirmOpen}
        title="Kullanıcı kalıcı olarak silinsin mi?"
        description="Bu kullanıcıda operasyon geçmişi bulunmuyor. Bu işlem geri alınamaz."
        details={[`Kullanıcı: ${user.name}`, `E-posta: ${user.email}`]}
        confirmLabel="Kalıcı olarak sil" pending={deletePending} pendingLabel="Siliniyor…" destructive
        onConfirm={() => void permanentlyDelete()}
        onCancel={() => { if (!deletePending) setDeleteConfirmOpen(false); }}
        returnFocusRef={deleteTriggerRef} fallbackFocusRef={nameInputRef} />
    </section></main>;
}

export function UserListScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const load = () => { setState('loading'); listUsers().then((value) => { setUsers(value); setState('ready'); }).catch(() => setState('error')); };
  useEffect(load, []);
  if (state === 'loading') return <main className="workspace" aria-busy="true"><h1>Kullanıcılar yükleniyor</h1></main>;
  if (state === 'error') return <main className="workspace"><ResultState status="error" title="Kullanıcılar yüklenemedi" headingLevel={1} action={<button className="secondary-button" onClick={load}>Tekrar dene</button>} /></main>;
  const notice = typeof (location.state as { notice?: unknown } | null)?.notice === 'string'
    ? (location.state as { notice: string }).notice : undefined;
  return <UserListView users={users} onCreate={() => navigate(paths.newUser)}
      onOpen={(id) => navigate(paths.user(id))} notice={notice} />;
}

export function UserCreateScreen() {
  const navigate = useNavigate();
  const [managers, setManagers] = useState<ManagedUser[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setState('loading');
    listUsers().then((value) => {
      if (!active) return;
      setManagers(value.filter((u) => u.role === 'MANAGER' && u.isActive)); setState('ready');
    })
      .catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [reload]);
  if (state === 'loading') return <main className="workspace" aria-busy="true"><h1>Kullanıcı formu yükleniyor</h1></main>;
  // The hierarchy return is PageHeader's ReturnLink (`‹ Kullanıcılar`); the
  // former `Listeye dön` button duplicated it (UI audit F-13).
  if (state === 'error') return <main className="workspace"><PageHeader fallbackTitle="Yeni kullanıcı" /><ResultState status="error" title="Kullanıcı formu yüklenemedi" headingLevel={2}
    action={<button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>Tekrar dene</button>} /></main>;
  return <UserCreateForm managers={managers} onCancel={() => navigate(paths.users)}
    onCreated={(created) => navigate(paths.user(created.id))} />;
}

export function UserDetailScreen({ viewer }: { viewer: Pick<CurrentUser, 'id' | 'organizationId' | 'role'> }) {
  const { userId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const setRouteRuntimeLabel = useSetRouteRuntimeLabel();
  const [user, setUser] = useState<UserDetailRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setRouteRuntimeLabel(user?.name);
  }, [setRouteRuntimeLabel, user?.name]);
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
  }, [userId, reload]);
  if (!userId) return <main className="workspace"><PageHeader fallbackTitle="Kullanıcı" /><ResultState status="404" title="Kullanıcı bulunamadı" headingLevel={2} /></main>;
  if (loading) return <main className="workspace" aria-busy="true"><h1>Kullanıcı yükleniyor</h1></main>;
  // Removal reason as above: PageHeader owns the hierarchy return (F-13).
  if (!user) return <main className="workspace"><PageHeader fallbackTitle="Kullanıcı" /><ResultState status="error" title="Kullanıcı yüklenemedi" description={error} headingLevel={2}
    action={<button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>Tekrar dene</button>} /></main>;
  return <UserDetailView viewer={viewer} user={user}
    startWithFreshPreview={new URLSearchParams(location.search).get('offboarding') === 'refresh'}
    onChanged={(next) => setUser((current) => current ? { ...current, ...next } : next)}
    onDeleted={() => navigate(paths.users, { replace: true, state: { notice: 'Kullanıcı kalıcı olarak silindi.' } })} />;
}

/** @deprecated Prefer routed screens; kept for existing imports. */
export function UserManagementScreen() {
  const navigate = useNavigate();
  useEffect(() => { navigate(paths.users, { replace: true }); }, [navigate]);
  return <main className="workspace">
    <p>Kullanıcı listesine yönlendiriliyorsunuz…</p></main>;
}
