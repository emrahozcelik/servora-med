import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { paths } from './paths';
import type { CurrentUser } from './services/api';
import { getOwnStaffProfile, getStaffProfile, listStaff, listUsers, updateStaffProfile, type ManagedUser, type StaffProfile } from './services/people-api';
import { StaffOperationalReportScreen } from './reports/StaffOperationalReport';
import { isInteractiveTarget } from './ui/clickable-card';

const counterLabels = { open: 'Açık işler', waitingApproval: 'Onay bekliyor', revisionRequested: 'Düzeltme istendi', completedThisMonth: 'Bu ay tamamlandı', overdue: 'Geciken' } as const;

function ProfileFacts({ profile }: { profile: StaffProfile }) { return <dl className="profile-facts"><div><dt>Unvan</dt><dd>{profile.title || 'Belirtilmedi'}</dd></div><div><dt>Telefon</dt><dd>{profile.phone || 'Belirtilmedi'}</dd></div><div><dt>Bölge</dt><dd>{profile.region || 'Belirtilmedi'}</dd></div><div><dt>Yönetici</dt><dd>{profile.managerName || 'Atanmadı'}</dd></div></dl>; }

export function OwnStaffProfileView({ profile, onBack }: { profile: StaffProfile; onBack: () => void }) {
  return <main className="workspace"><button className="back-link" onClick={onBack}>İşlere dön</button><p className="eyebrow">Profilim</p><h1>{profile.user.name}</h1>
    <ProfileFacts profile={profile} /><section aria-labelledby="counter-title"><h2 id="counter-title">Operasyon özeti</h2><dl className="counter-grid">
      {(Object.keys(counterLabels) as Array<keyof typeof counterLabels>).map((key) => <div key={key}><dt>{counterLabels[key]}</dt><dd>{profile.counters[key]}</dd></div>)}</dl></section>
    <StaffOperationalReportScreen embedded onBack={onBack} />
  </main>;
}

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function StaffDirectoryView({ profiles, onOpen, onBack }: {
  profiles: StaffProfile[];
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  return <main className="workspace"><button className="back-link" onClick={onBack}>İşlere dön</button>
    <div className="workspace-heading"><div><p className="eyebrow">Ekip</p><h1>Personel</h1></div></div>
    {profiles.length === 0 ? <div className="workspace-message"><h2>Personel bulunamadı</h2><p>Aktif personel profili yok.</p></div>
      : <ul className="people-list">{profiles.map((profile) => <li key={profile.id}>
        <article className="people-row people-list-card" data-staff-id={profile.user.id}
          onClick={(event) => openCardIfEmpty(event, onOpen, profile.user.id)}>
          <div className="people-identity">
            <h2><Link className="people-title-link" to={paths.staffProfile(profile.user.id)}>{profile.user.name}</Link></h2>
            <p>{profile.title || 'Unvan belirtilmedi'} · {profile.managerName || 'Yönetici atanmadı'}</p>
          </div>
        </article>
      </li>)}</ul>}
  </main>;
}

export function StaffProfileEditView({ profile: initial, managers, onBack, onChanged, onOpenReport }: { profile: StaffProfile; managers: ManagedUser[]; onBack: () => void; onChanged: (profile: StaffProfile) => void; onOpenReport?: () => void }) {
  const [profile, setProfile] = useState(initial); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(''); const data = new FormData(event.currentTarget);
    try { const updated = await updateStaffProfile(profile.user.id, { expectedVersion: profile.version, title: String(data.get('title') ?? '') || null,
      phone: String(data.get('phone') ?? '') || null, region: String(data.get('region') ?? '') || null, managerUserId: String(data.get('managerUserId') ?? '') || null });
      setProfile(updated); onChanged(updated); setNotice('Personel profili güncellendi.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Profil güncellenemedi.'); } finally { setPending(false); } }
  return <main className="people-form"><div className="detail-heading"><div><p className="eyebrow">Personel</p><h1>{profile.user.name}</h1></div><div className="people-actions">{onOpenReport && <button className="secondary-button" onClick={onOpenReport}>Operasyon raporunu aç</button>}<button className="secondary-button" onClick={onBack}>Listeye dön</button></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    <form onSubmit={submit}><label className="field-group">Unvan<input name="title" defaultValue={profile.title ?? ''} disabled={pending} /></label>
      <label className="field-group">Telefon<input name="phone" type="tel" defaultValue={profile.phone ?? ''} disabled={pending} /></label>
      <label className="field-group">Bölge<input name="region" defaultValue={profile.region ?? ''} disabled={pending} /></label>
      <label className="field-group">Yönetici<select name="managerUserId" defaultValue={profile.managerUserId ?? ''} disabled={pending}><option value="">Atanmadı</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <button className="primary-button" disabled={pending}>{pending ? 'Kaydediliyor…' : 'Profili kaydet'}</button></form>
  </main>;
}

export function StaffProfileEditRoute(props: {
  profile: StaffProfile;
  managers: ManagedUser[];
  onBack: () => void;
  onChanged: (profile: StaffProfile) => void;
  onOpenReport?: () => void;
}) {
  return <StaffProfileEditView key={props.profile.user.id} {...props} />;
}

export function StaffProfilesScreen({ user, onBack, initialStaffUserId, onOpenProfile, onProfileBack, onOpenReport }: {
  user: CurrentUser;
  onBack: () => void;
  initialStaffUserId?: string;
  onOpenProfile?: (staffUserId: string) => void;
  onProfileBack?: () => void;
  onOpenReport?: (staffUserId: string) => void;
}) {
  const [profiles, setProfiles] = useState<StaffProfile[]>([]); const [own, setOwn] = useState<StaffProfile | null>(null); const [selected, setSelected] = useState<StaffProfile | null>(null);
  const [managers, setManagers] = useState<ManagedUser[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { setLoading(true); setError('');
    if (user.role === 'STAFF') getOwnStaffProfile().then(setOwn).catch((e) => setError(e instanceof Error ? e.message : 'Profil yüklenemedi.')).finally(() => setLoading(false));
    else Promise.all([listStaff('active'), user.role === 'ADMIN' ? listUsers() : Promise.resolve([{ ...user, lastLoginAt: null, createdAt: '', updatedAt: '' } as ManagedUser]),
      initialStaffUserId ? getStaffProfile(initialStaffUserId) : Promise.resolve(null)])
      .then(([items, allUsers, initialProfile]) => { setProfiles(items); setManagers(allUsers.filter((item) => item.role === 'MANAGER' && item.isActive)); setSelected(initialProfile); }).catch((e) => setError(e instanceof Error ? e.message : 'Personel yüklenemedi.')).finally(() => setLoading(false));
  }, [user, initialStaffUserId]);
  if (loading) return <main className="workspace" aria-busy="true"><h1>{initialStaffUserId ? 'Personel profili yükleniyor' : 'Personel bilgileri yükleniyor'}</h1></main>;
  if (error) return <main className="workspace"><div className="workspace-message" role="alert"><h1>Personel bilgileri yüklenemedi</h1><p>{error}</p></div></main>;
  if (user.role === 'STAFF' && own) return <OwnStaffProfileView profile={own} onBack={onBack} />;
  if (selected) return <StaffProfileEditRoute profile={selected} managers={managers} onBack={() => { setSelected(null); onProfileBack?.(); }} onChanged={(next) => setProfiles((all) => all.map((p) => p.id === next.id ? next : p))} onOpenReport={onOpenReport ? () => onOpenReport(selected.user.id) : undefined} />;
  return <StaffDirectoryView profiles={profiles} onBack={onBack}
    onOpen={(id) => { if (onOpenProfile) onOpenProfile(id); else void getStaffProfile(id).then(setSelected).catch((e) => setError(e instanceof Error ? e.message : 'Profil yüklenemedi.')); }} />;
}
