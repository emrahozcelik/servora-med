import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { paths } from './paths';
import { jobCardStatusLabel, jobTypeLabels } from './jobs/job-labels';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import type { CurrentUser } from './services/api';
import { createRequestGate } from './services/request-gate';
import {
  getOwnStaffProfile, getStaffProfile, listOwnStaffJobs, listOwnWeeklyReports, listStaff,
  listStaffJobs, listStaffWeeklyReports, listUsers, updateStaffProfile,
  type JobHistoryItem, type ManagedUser, type StaffProfile, type WeeklyReportHistoryItem,
} from './services/people-api';
import { downloadWeeklyReportSubmissionPdf } from './jobs/weekly-report-api';
import { saveBlobAs } from './services/file-download';
import type { Paginated } from './services/crm-api';
import { StaffOperationalReportScreen } from './reports/StaffOperationalReport';
import { StaffConfidentialNotesSection } from './StaffConfidentialNotes';
import { PageHeader } from './ui/PageHeader';
import { useSetRouteRuntimeLabel } from './shell/resolved-identity';
import { EmptyState } from './ui/antd/EmptyState';
import { ResultState } from './ui/antd/ResultState';
import { isInteractiveTarget } from './ui/clickable-card';

const counterLabels = { open: 'Açık işler', waitingApproval: 'Onay bekliyor', revisionRequested: 'Düzeltme istendi', completedThisMonth: 'Bu ay tamamlandı', overdue: 'Geciken' } as const;

function ProfileFacts({ profile }: { profile: StaffProfile }) { return <dl className="profile-facts"><div><dt>Unvan</dt><dd>{profile.title || 'Belirtilmedi'}</dd></div><div><dt>Telefon</dt><dd>{profile.phone || 'Belirtilmedi'}</dd></div><div><dt>Bölge</dt><dd>{profile.region || 'Belirtilmedi'}</dd></div><div><dt>Yönetici</dt><dd>{profile.managerName || 'Atanmadı'}</dd></div></dl>; }

type StaffHistoryStatus = 'open' | 'completed' | 'all';

export function StaffJobHistory({ actor, staffUserId }: { actor: CurrentUser; staffUserId: string }) {
  const [status, setStatus] = useState<StaffHistoryStatus>('all');
  const [page, setPage] = useState<Paginated<JobHistoryItem> | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const requestGate = useRef(createRequestGate());
  const load = async (nextStatus = status, offset = 0) => {
    const generation = requestGate.current.next();
    setLoading(true); setError('');
    try {
      const result = actor.role === 'STAFF'
        ? await listOwnStaffJobs({ status: nextStatus, limit: 20, offset })
        : await listStaffJobs(staffUserId, { status: nextStatus, limit: 20, offset });
      if (!requestGate.current.isCurrent(generation)) return;
      setPage(result);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) {
        setError(caught instanceof Error ? caught.message : 'İş geçmişi yüklenemedi.');
      }
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  };
  useEffect(() => {
    void load(status, 0);
    return () => { requestGate.current.next(); };
  }, [actor.role, staffUserId, status]);
  useRealtimeInvalidation([`staff-profile:${staffUserId}`], () => { void load(status, page?.offset ?? 0); });
  const items = page?.items ?? [];
  const hasNext = page ? page.offset + page.items.length < page.total : false;
  const hasPrevious = (page?.offset ?? 0) > 0;
  return <section className="record-section staff-job-history" aria-labelledby="staff-job-history-title">
    <div className="section-heading"><h2 id="staff-job-history-title">İş geçmişi</h2><span>{page?.total ?? '…'} kayıt</span></div>
    <div className="history-tabs" role="tablist" aria-label="Personel iş geçmişi kapsamı">
      {(['all', 'open', 'completed'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={status === value}
        className={status === value ? 'secondary-button is-active' : 'secondary-button'} onClick={() => { setStatus(value); setPage(null); }}>
        {value === 'all' ? 'Tümü' : value === 'open' ? 'Açık' : 'Tamamlanan'}
      </button>)}
    </div>
    {loading && <p className="muted-copy" aria-busy="true">İş geçmişi yükleniyor…</p>}
    {!loading && error && <p className="form-error" role="alert">{error}</p>}
    {!loading && !error && items.length === 0 && <p className="muted-copy">Görüntüleyebileceğiniz iş kaydı bulunmuyor.</p>}
    {!loading && !error && items.length > 0 && <ul className="job-history-list">{items.map((job) => <li key={job.id} className="job-history-row">
      <div><Link to={paths.job(job.id)}>{job.title}</Link>{job.followUp && <span className="follow-up-badge">Takip</span>}
        <p>{jobTypeLabels[job.type]} · {job.customer?.name ?? 'Müşterisiz iş'} · {jobCardStatusLabel(job.status)}</p></div>
      <time dateTime={job.completedAt ?? job.scheduledAt ?? job.createdAt}>{new Date(job.completedAt ?? job.scheduledAt ?? job.createdAt).toLocaleDateString('tr-TR')}</time>
    </li>)}</ul>}
    {(hasPrevious || hasNext) && <div className="pagination-actions"><button type="button" className="secondary-button" disabled={!hasPrevious || loading} onClick={() => void load(status, Math.max(0, (page?.offset ?? 0) - (page?.limit ?? 20)))}>Önceki</button>
      <button type="button" className="secondary-button" disabled={!hasNext || loading} onClick={() => void load(status, (page?.offset ?? 0) + (page?.limit ?? 20))}>Daha fazla göster</button></div>}
  </section>;
}

export function OwnStaffProfileView({ profile, actor }: { profile: StaffProfile; actor?: CurrentUser }) {
  return <main className="workspace">
    <PageHeader eyebrow="Profilim" fallbackTitle={profile.user.name} />
    <ProfileFacts profile={profile} /><section aria-labelledby="counter-title"><h2 id="counter-title">Operasyon özeti</h2><dl className="counter-grid">
      {(Object.keys(counterLabels) as Array<keyof typeof counterLabels>).map((key) => <div key={key}><dt>{counterLabels[key]}</dt><dd>{profile.counters[key]}</dd></div>)}</dl></section>
    <StaffOperationalReportScreen embedded />{actor && <StaffJobHistory actor={actor} staffUserId={profile.user.id} />}
    {actor && <StaffWeeklyReportHistory actor={actor} staffUserId={profile.user.id} />}
  </main>;
}

/**
 * Formats a server-provided calendar date (`YYYY-MM-DD`) as `DD.MM.YYYY`.
 * Deliberately textual: the value is never re-parsed into a `Date`, so no
 * timezone can shift the day the server reported.
 */
function formatCalendarDay(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * Personnel-profile Weekly Report history. A read model over canonical
 * WeeklyReports: every canonical lifecycle status is shown, a report with zero
 * submissions is a valid row (no PDF action), and the PDF action always targets
 * the latest immutable submission seq.
 *
 * `dueDate` is the server's calendar date and is formatted textually. A null
 * `dueDate` means no deadline was ever set on the report's JobCard, so the row
 * simply omits the label rather than inventing a placeholder. `completedAt` is
 * a real instant (the report JobCard's approval time) and is rendered as
 * `Tamamlandı <date>` only when the report actually reached that state.
 */
export function StaffWeeklyReportHistory({ actor, staffUserId }: { actor: CurrentUser; staffUserId: string }) {
  const [page, setPage] = useState<Paginated<WeeklyReportHistoryItem> | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const requestGate = useRef(createRequestGate());
  const load = async (offset = 0) => {
    const generation = requestGate.current.next();
    setLoading(true); setError('');
    try {
      const result = actor.role === 'STAFF'
        ? await listOwnWeeklyReports({ limit: 20, offset })
        : await listStaffWeeklyReports(staffUserId, { limit: 20, offset });
      if (!requestGate.current.isCurrent(generation)) return;
      setPage(result);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) {
        setError(caught instanceof Error ? caught.message : 'Haftalık rapor geçmişi yüklenemedi.');
      }
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
    return () => { requestGate.current.next(); };
  }, [actor.role, staffUserId]);
  useRealtimeInvalidation([`staff-profile:${staffUserId}`], () => { void load(page?.offset ?? 0); });
  async function download(item: WeeklyReportHistoryItem) {
    const seqNo = item.latestSubmissionSeqNo;
    if (seqNo === null || downloadingId !== null) return;
    setDownloadingId(item.reportId); setDownloadError('');
    try {
      const { blob, fileName } = await downloadWeeklyReportSubmissionPdf(item.jobCardId, seqNo);
      saveBlobAs(blob, fileName);
    } catch (caught) {
      setDownloadError(caught instanceof Error ? caught.message : 'PDF indirilemedi.');
    } finally { setDownloadingId(null); }
  }
  const items = page?.items ?? [];
  const hasNext = page ? page.offset + page.items.length < page.total : false;
  const hasPrevious = (page?.offset ?? 0) > 0;
  return <section className="record-section staff-weekly-reports" aria-labelledby="staff-weekly-reports-title">
    <div className="section-heading"><h2 id="staff-weekly-reports-title">Haftalık Raporlar</h2><span>{page?.total ?? '…'} kayıt</span></div>
    {loading && <p className="muted-copy" aria-busy="true">Haftalık raporlar yükleniyor…</p>}
    {!loading && error && <p className="form-error" role="alert">{error}</p>}
    {downloadError && <p className="form-error" role="alert">{downloadError}</p>}
    {!loading && !error && items.length === 0 && <p className="muted-copy">Görüntüleyebileceğiniz haftalık rapor bulunmuyor.</p>}
    {!loading && !error && items.length > 0 && <ul className="job-history-list">{items.map((item) => <li key={item.reportId} className="job-history-row">
      <div>
        <Link to={paths.job(item.jobCardId)}>{`${item.periodStart} – ${item.periodEnd}`}</Link>
        <p>{jobCardStatusLabel(item.status)} · {item.submissionCount === 0 ? 'Gönderim yok' : `${item.submissionCount} gönderim`}
          {item.latestSubmittedAt ? ` · Son gönderim ${new Date(item.latestSubmittedAt).toLocaleDateString('tr-TR')}` : ''}
          {item.dueDate ? ` · Teslim son tarihi ${formatCalendarDay(item.dueDate)}` : ''}
          {item.completedAt ? ` · Tamamlandı ${new Date(item.completedAt).toLocaleDateString('tr-TR')}` : ''}</p>
      </div>
      {item.latestSubmissionSeqNo === null
        ? <span className="muted-copy">PDF yok</span>
        : <button type="button" className="secondary-button" disabled={downloadingId !== null}
            onClick={() => void download(item)}>{downloadingId === item.reportId ? 'PDF hazırlanıyor…' : 'PDF indir'}</button>}
    </li>)}</ul>}
    {(hasPrevious || hasNext) && <div className="pagination-actions">
      <button type="button" className="secondary-button" disabled={!hasPrevious || loading} onClick={() => void load(Math.max(0, (page?.offset ?? 0) - (page?.limit ?? 20)))}>Önceki</button>
      <button type="button" className="secondary-button" disabled={!hasNext || loading} onClick={() => void load((page?.offset ?? 0) + (page?.limit ?? 20))}>Daha fazla göster</button>
    </div>}
  </section>;
}

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function StaffDirectoryView({ profiles, onOpen }: {
  profiles: StaffProfile[];
  onOpen: (id: string) => void;
}) {
  return <main className="workspace">
    <PageHeader eyebrow="Ekip" fallbackTitle="Personel" />
    {profiles.length === 0 ? <EmptyState title="Personel bulunamadı" description="Aktif personel profili yok." />
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

export function StaffProfileEditView({ profile: initial, actor, managers, onBack, onChanged, onOpenReport }: { profile: StaffProfile; actor?: CurrentUser; managers: ManagedUser[]; onBack: () => void; onChanged: (profile: StaffProfile) => void; onOpenReport?: () => void }) {
  const [profile, setProfile] = useState(initial); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(''); const data = new FormData(event.currentTarget);
    try { const updated = await updateStaffProfile(profile.user.id, { expectedVersion: profile.version, title: String(data.get('title') ?? '') || null,
      phone: String(data.get('phone') ?? '') || null, region: String(data.get('region') ?? '') || null, managerUserId: String(data.get('managerUserId') ?? '') || null });
      setProfile(updated); onChanged(updated); setNotice('Personel profili güncellendi.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Profil güncellenemedi.'); } finally { setPending(false); } }
  return <main className="people-form"><PageHeader eyebrow="Personel" fallbackTitle={profile.user.name} actions={onOpenReport ? <button className="secondary-button" onClick={onOpenReport}>Operasyon raporunu aç</button> : undefined} />
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    <form onSubmit={submit}><label className="field-group">Unvan<input name="title" defaultValue={profile.title ?? ''} disabled={pending} /></label>
      <label className="field-group">Telefon<input name="phone" type="tel" defaultValue={profile.phone ?? ''} disabled={pending} /></label>
      <label className="field-group">Bölge<input name="region" defaultValue={profile.region ?? ''} disabled={pending} /></label>
      <label className="field-group">Yönetici<select name="managerUserId" defaultValue={profile.managerUserId ?? ''} disabled={pending}><option value="">Atanmadı</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onBack} disabled={pending}>Listeye dön</button>
      <button className="primary-button compact-button" type="submit" disabled={pending}>{pending ? 'Kaydediliyor…' : 'Profili kaydet'}</button></div></form>
    {actor && actor.role !== 'STAFF' && <StaffConfidentialNotesSection staffUserId={profile.user.id} actor={actor} />}
    {actor && <StaffJobHistory actor={actor} staffUserId={profile.user.id} />}
    {actor && <StaffWeeklyReportHistory actor={actor} staffUserId={profile.user.id} />}</main>;
}

export function StaffProfileEditRoute(props: {
  profile: StaffProfile;
  actor?: CurrentUser;
  managers: ManagedUser[];
  onBack: () => void;
  onChanged: (profile: StaffProfile) => void;
  onOpenReport?: () => void;
}) {
  return <StaffProfileEditView key={props.profile.user.id} {...props} />;
}

export function StaffProfilesScreen({ user, initialStaffUserId, onOpenProfile, onProfileBack, onOpenReport }: {
  user: CurrentUser;
  initialStaffUserId?: string;
  onOpenProfile?: (staffUserId: string) => void;
  onProfileBack?: () => void;
  onOpenReport?: (staffUserId: string) => void;
}) {
  const setRouteRuntimeLabel = useSetRouteRuntimeLabel();
  const [profiles, setProfiles] = useState<StaffProfile[]>([]); const [own, setOwn] = useState<StaffProfile | null>(null); const [selected, setSelected] = useState<StaffProfile | null>(null);
  useEffect(() => {
    setRouteRuntimeLabel(own?.user.name ?? selected?.user.name);
  }, [setRouteRuntimeLabel, own?.user.name, selected?.user.name]);
  const [managers, setManagers] = useState<ManagedUser[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const realtimeResourceKeys = user.role === 'STAFF'
    ? [`staff-profile:${user.id}`]
    : initialStaffUserId
      ? [`staff-profile:${initialStaffUserId}`]
      : profiles.map((profile) => `staff-profile:${profile.user.id}`);
  useEffect(() => { setLoading(true); setError('');
    if (user.role === 'STAFF') getOwnStaffProfile().then(setOwn).catch((e) => setError(e instanceof Error ? e.message : 'Profil yüklenemedi.')).finally(() => setLoading(false));
    else Promise.all([listStaff('active'), user.role === 'ADMIN' ? listUsers() : Promise.resolve([{ ...user, lastLoginAt: null, createdAt: '', updatedAt: '' } as ManagedUser]),
      initialStaffUserId ? getStaffProfile(initialStaffUserId) : Promise.resolve(null)])
      .then(([items, allUsers, initialProfile]) => { setProfiles(items); setManagers(allUsers.filter((item) => item.role === 'MANAGER' && item.isActive)); setSelected(initialProfile); }).catch((e) => setError(e instanceof Error ? e.message : 'Personel yüklenemedi.')).finally(() => setLoading(false));
  }, [user, initialStaffUserId, reload]);
  useRealtimeInvalidation(realtimeResourceKeys, () => { setReload((value) => value + 1); });
  if (loading) return <main className="workspace" aria-busy="true"><h1>{initialStaffUserId ? 'Personel profili yükleniyor' : 'Personel bilgileri yükleniyor'}</h1></main>;
  if (error) return <main className="workspace"><ResultState status="error" title="Personel bilgileri yüklenemedi" description={error} headingLevel={1} /></main>;
  if (user.role === 'STAFF' && own) return <OwnStaffProfileView profile={own} actor={user} />;
  if (selected) return <StaffProfileEditRoute profile={selected} actor={user} managers={managers} onBack={() => { setSelected(null); onProfileBack?.(); }} onChanged={(next) => setProfiles((all) => all.map((p) => p.id === next.id ? next : p))} onOpenReport={onOpenReport ? () => onOpenReport(selected.user.id) : undefined} />;
  return <StaffDirectoryView profiles={profiles}
    onOpen={(id) => { if (onOpenProfile) onOpenProfile(id); else void getStaffProfile(id).then(setSelected).catch((e) => setError(e instanceof Error ? e.message : 'Profil yüklenemedi.')); }} />;
}
