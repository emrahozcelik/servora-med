import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { DeliveryCreateView } from './DeliveryCreate';
import { JobDetailScreen } from './JobDetail';
import { StaffProfilesScreen } from './StaffProfiles';
import { UserManagementScreen } from './UserManagement';
import type { CurrentUser, JobCard, ReferenceCustomer, ReferenceProduct } from './services/api';

const statusLabels = { NEW: 'Yeni', PLANNED: 'Planlandı', IN_PROGRESS: 'Devam ediyor', WAITING_APPROVAL: 'Onay bekliyor', REVISION_REQUESTED: 'Düzeltme istendi', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal edildi' } as const;
const priorityLabels = { low: 'Düşük öncelik', normal: 'Normal öncelik', high: 'Yüksek öncelik', urgent: 'Acil öncelik' } as const;

export type WorkspaceState =
  | { kind: 'loading' }
  | { kind: 'ready'; jobs: JobCard[]; customerNames: Record<string, string> }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

function formatDueDate(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

export function WorkspaceView({ user, state, onRetry, onCreate, onOpen, notice = '' }: { user: CurrentUser; state: WorkspaceState; onRetry: () => void; onCreate?: () => void; onOpen?: (jobId: string) => void; notice?: string }) {
  const reviewMode = user.role !== 'STAFF';
  const heading = reviewMode ? 'Onay kuyruğu' : 'İşlerim';
  if (state.kind === 'loading') return (
    <main className="workspace" aria-busy="true" aria-live="polite">
      <p className="eyebrow">{heading}</p><h1>{reviewMode ? 'Onay bekleyen işler yükleniyor' : 'İşleriniz yükleniyor'}</h1>
      <div className="job-list-loading" aria-hidden="true"><span /><span /><span /></div>
    </main>
  );
  if (state.kind === 'error') {
    const forbidden = state.code === 'FORBIDDEN';
    return <main className="workspace"><p className="eyebrow">{heading}</p><div className="workspace-message" role="alert">
      <h1>{forbidden ? 'Bu alana erişim yetkiniz yok' : 'İşler yüklenemedi'}</h1><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}
    </div></main>;
  }
  const visibleJobs = reviewMode ? state.jobs.filter((job) => job.status === 'WAITING_APPROVAL') : state.jobs;
  return <main className="workspace">
    {notice && <div className="success-message" role="status">{notice}</div>}
    <div className="workspace-heading"><div><p className="eyebrow">Çalışma alanı</p><h1>{heading}</h1></div>
      {user.role === 'STAFF' && <div className="workspace-actions"><span className="scope-note">Yalnız size atanan işler</span>
        {onCreate && <button className="primary-button compact-button" type="button" onClick={onCreate}>Yeni teslim</button>}</div>}</div>
    {visibleJobs.length === 0 ? <div className="workspace-message"><h2>{reviewMode ? 'Onay bekleyen iş yok' : 'Henüz atanmış işiniz yok'}</h2>
      <p>{reviewMode ? 'Personel tarafından gönderilen işler burada görünecek.' : 'Yeni bir iş atandığında burada görünecek.'}</p></div>
      : <ul className="job-list">{visibleJobs.map((job) => <li key={job.id}>
        <article className="job-row" data-job-id={job.id}>
          <div className="job-main"><div className="job-signals"><span className={`status status-${job.status.toLowerCase()}`}>{statusLabels[job.status]}</span>
            <span className={`priority priority-${job.priority}`}>{priorityLabels[job.priority]}</span></div>
            <h2>{job.title}</h2><p>{job.customerId ? state.customerNames[job.customerId] ?? 'Müşteri kaydı' : 'Müşteri belirtilmedi'}</p></div>
          <div className="job-row-actions"><dl className="job-meta"><div><dt>Sürüm</dt><dd>{job.version}</dd></div>{job.dueDate && <div><dt>Termin</dt><dd>{formatDueDate(job.dueDate)}</dd></div>}</dl>
            {onOpen && <button className="secondary-button" type="button" onClick={() => onOpen(job.id)} aria-label={`${job.title} işini aç`}>İşi aç</button>}</div>
        </article></li>)}</ul>}
  </main>;
}

const encoded = (value: string) => encodeURIComponent(value);

export const paths = {
  jobs: '/jobs',
  newDelivery: '/jobs/new-delivery',
  users: '/users',
  staff: '/staff',
  customers: '/customers',
  newCustomer: '/customers/new',
  job: (id: string) => `/jobs/${encoded(id)}`,
  staffProfile: (id: string) => `/staff/${encoded(id)}`,
  customer: (id: string) => `/customers/${encoded(id)}`,
  contact: (customerId: string, contactId: string) =>
    `/customers/${encoded(customerId)}/contacts/${encoded(contactId)}`,
} as const;

type AppRouterProps = {
  user: CurrentUser;
  workspace: WorkspaceState;
  customers: ReferenceCustomer[];
  products: ReferenceProduct[];
  notice: string;
  onReload: () => void;
  onClearNotice: () => void;
  onDeliveryCreated: () => void;
};

function ForbiddenView() {
  return <main className="workspace"><div className="workspace-message" role="alert">
    <h1>Bu alana erişim yetkiniz yok</h1>
    <p>Bu sayfayı görüntülemek için gerekli role sahip değilsiniz.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function NotFoundView() {
  return <main className="workspace"><div className="workspace-message">
    <h1>Sayfa bulunamadı</h1>
    <p>Bağlantı değişmiş veya sayfa kaldırılmış olabilir.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function CustomerPlaceholder({ kind }: { kind: 'list' | 'create' | 'detail' | 'contact' }) {
  const content = {
    list: ['Müşteriler', 'Müşteri kayıtları bir sonraki adımda burada yönetilecek.'],
    create: ['Yeni müşteri', 'Müşteri oluşturma formu bir sonraki adımda eklenecek.'],
    detail: ['Müşteri detayı', 'Müşteri bilgileri bir sonraki adımda burada gösterilecek.'],
    contact: ['İlgili kişi', 'İlgili kişi bilgileri bir sonraki adımda burada gösterilecek.'],
  } as const;
  return <main className="workspace"><p className="eyebrow">CRM</p><h1>{content[kind][0]}</h1><p>{content[kind][1]}</p></main>;
}

function JobDetailRoute({ user, onReload }: Pick<AppRouterProps, 'user' | 'onReload'>) {
  const { jobCardId } = useParams();
  const navigate = useNavigate();
  if (!jobCardId) return <NotFoundView />;
  return <JobDetailScreen jobId={jobCardId} user={user} onBack={() => navigate(paths.jobs)} onChanged={onReload} />;
}

function StaffRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const navigate = useNavigate();
  if (user.role === 'STAFF' && staffUserId && staffUserId !== user.id) return <ForbiddenView />;
  return <StaffProfilesScreen user={user} initialStaffUserId={staffUserId} onBack={() => navigate(paths.jobs)}
    onOpenProfile={(id) => navigate(paths.staffProfile(id))} onProfileBack={() => navigate(paths.staff)} />;
}

export function AppRouter({ user, workspace, customers, products, notice, onReload, onClearNotice, onDeliveryCreated }: AppRouterProps) {
  const navigate = useNavigate();
  return <>
    <nav className="section-nav" aria-label="Çalışma alanları">
      <Link className="secondary-button" to={paths.jobs}>İşler</Link>
      <Link className="secondary-button" to={paths.customers}>Müşteriler</Link>
      {user.role === 'ADMIN' && <Link className="secondary-button" to={paths.users}>Kullanıcılar</Link>}
      <Link className="secondary-button" to={user.role === 'STAFF' ? paths.staffProfile(user.id) : paths.staff}>
        {user.role === 'STAFF' ? 'Profilim' : 'Personel'}
      </Link>
    </nav>
    <Routes>
      <Route path="/" element={<Navigate to={paths.jobs} replace />} />
      <Route path={paths.jobs} element={<WorkspaceView user={user} state={workspace} notice={notice}
        onCreate={user.role === 'STAFF' && workspace.kind === 'ready' ? () => { onClearNotice(); navigate(paths.newDelivery); } : undefined}
        onOpen={(jobId) => navigate(paths.job(jobId))} onRetry={onReload} />} />
      <Route path={paths.newDelivery} element={user.role === 'STAFF'
        ? <DeliveryCreateView user={user} customers={customers} products={products} onCancel={() => navigate(paths.jobs)}
          onCreated={() => { onDeliveryCreated(); navigate(paths.jobs); }} />
        : <ForbiddenView />} />
      <Route path="/jobs/:jobCardId" element={<JobDetailRoute user={user} onReload={onReload} />} />
      <Route path={paths.users} element={user.role === 'ADMIN'
        ? <UserManagementScreen onBack={() => navigate(paths.jobs)} /> : <ForbiddenView />} />
      <Route path={paths.staff} element={<StaffRoute user={user} />} />
      <Route path="/staff/:staffUserId" element={<StaffRoute user={user} />} />
      <Route path={paths.customers} element={<CustomerPlaceholder kind="list" />} />
      <Route path={paths.newCustomer} element={user.role === 'STAFF' ? <ForbiddenView /> : <CustomerPlaceholder kind="create" />} />
      <Route path="/customers/:customerId" element={<CustomerPlaceholder kind="detail" />} />
      <Route path="/customers/:customerId/contacts/:contactId" element={<CustomerPlaceholder kind="contact" />} />
      <Route path="*" element={<NotFoundView />} />
    </Routes>
  </>;
}
