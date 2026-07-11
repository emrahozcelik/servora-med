import { useEffect, useRef, useState, type FormEvent } from 'react';

import { DeliveryCreateView } from './DeliveryCreate';
import { JobDetailScreen } from './JobDetail';
import { ApiError, getCurrentUser, listJobCards, listReferenceCustomers, listReferenceProducts, login, logout, type CurrentUser, type JobCard, type ReferenceCustomer, type ReferenceProduct } from './services/api';

type AppProps = { initialUser?: CurrentUser | null };

const roleLabels = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;
const statusLabels = { NEW: 'Yeni', PLANNED: 'Planlandı', IN_PROGRESS: 'Devam ediyor', WAITING_APPROVAL: 'Onay bekliyor', REVISION_REQUESTED: 'Düzeltme istendi', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal edildi' } as const;
const priorityLabels = { low: 'Düşük öncelik', normal: 'Normal öncelik', high: 'Yüksek öncelik', urgent: 'Acil öncelik' } as const;

export type WorkspaceState =
  | { kind: 'loading' }
  | { kind: 'ready'; jobs: JobCard[]; customerNames: Record<string, string> }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">S</span>;
}

function LoadingScreen() {
  return (
    <main className="identity-loading" aria-live="polite" aria-busy="true">
      <div className="loading-line loading-line-short" />
      <div className="loading-line" />
      <p>Oturum doğrulanıyor</p>
    </main>
  );
}

function LoginScreen({ onAuthenticated, initialError = '' }: {
  onAuthenticated: (user: CurrentUser) => void;
  initialError?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      onAuthenticated(await login({
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Giriş yapılamadı. Lütfen tekrar deneyin.');
    } finally { setPending(false); }
  }

  return (
    <main className="login-layout">
      <section className="login-introduction" aria-labelledby="product-title">
        <div className="brand-lockup"><BrandMark /><span>Servora-Med</span></div>
        <div className="login-context">
          <p className="eyebrow">Saha operasyonları</p>
          <h2 id="product-title">İşler net, süreçler izlenebilir.</h2>
          <p>Müşteri çalışmalarınızı, ürün teslimlerinizi ve yönetici onaylarını tek akışta yönetin.</p>
        </div>
        <p className="context-note">Medikal ve dental ekipler için operasyon alanı</p>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <p className="eyebrow">Güvenli erişim</p>
          <h1 id="login-title">Hesabınıza giriş yapın</h1>
          <p className="form-intro">Firmanız tarafından tanımlanan bilgilerle devam edin.</p>

          {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}

          <form onSubmit={submit} aria-describedby={error ? 'login-help' : undefined}>
            <div className="field-group">
              <label htmlFor="email">E-posta</label>
              <input id="email" name="email" type="email" autoComplete="username" inputMode="email" required disabled={pending} />
            </div>
            <div className="field-group">
              <label htmlFor="password">Parola</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
            </div>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? 'Giriş yapılıyor…' : 'Giriş yap'}
            </button>
            <p className="form-help" id="login-help">Erişim sorunu yaşıyorsanız sistem yöneticinizle iletişime geçin.</p>
          </form>
        </div>
      </section>
    </main>
  );
}

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

function ProtectedShell({ user, onSignedOut }: { user: CurrentUser; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: 'loading' });
  const [references, setReferences] = useState<{ customers: ReferenceCustomer[]; products: ReferenceProduct[] }>({ customers: [], products: [] });
  const [screen, setScreen] = useState<'list' | 'create' | 'detail'>('list');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true; setWorkspace({ kind: 'loading' });
    Promise.all([listJobCards(), listReferenceCustomers(), listReferenceProducts()]).then(([jobs, customers, products]) => {
      if (active) { setReferences({ customers, products }); setWorkspace({ kind: 'ready', jobs, customerNames: Object.fromEntries(customers.map((customer) => [customer.id, customer.name])) }); }
    }).catch((caught) => {
      if (!active) return;
      const apiError = caught instanceof ApiError ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'İşler yüklenemedi.', true);
      setWorkspace({ kind: 'error', code: apiError.code, message: apiError.message, retryable: apiError.retryable });
    });
    return () => { active = false; };
  }, [reloadKey]);
  async function signOut() {
    setPending(true); setError('');
    try { await logout(); onSignedOut(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Oturum kapatılamadı.'); setPending(false); }
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup"><BrandMark /><span>Servora-Med</span></div>
        <div className="account-area">
          <div><strong>{user.name}</strong><span>{roleLabels[user.role]}</span></div>
          <button className="secondary-button" type="button" onClick={signOut} disabled={pending}>
            {pending ? 'Kapatılıyor…' : 'Oturumu kapat'}
          </button>
        </div>
      </header>
      {screen === 'create' ? <DeliveryCreateView user={user} customers={references.customers} products={references.products}
        onCancel={() => setScreen('list')} onCreated={() => { setNotice('Teslim kaydı oluşturuldu.'); setScreen('list'); setReloadKey((value) => value + 1); }} />
        : screen === 'detail' && selectedJobId ? <JobDetailScreen jobId={selectedJobId} onBack={() => setScreen('list')} onChanged={() => setReloadKey((value) => value + 1)} />
          : <WorkspaceView user={user} state={workspace} notice={notice} onCreate={user.role === 'STAFF' && workspace.kind === 'ready' ? () => { setNotice(''); setScreen('create'); } : undefined}
            onOpen={(jobId) => { setSelectedJobId(jobId); setScreen('detail'); }} onRetry={() => setReloadKey((value) => value + 1)} />}
      {error && <div className="shell-error form-error" role="alert">{error}</div>}
    </div>
  );
}

export function App({ initialUser }: AppProps) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(initialUser);
  const [identityError, setIdentityError] = useState('');

  useEffect(() => {
    if (initialUser !== undefined) return;
    let active = true;
    getCurrentUser()
      .then((current) => { if (active) setUser(current); })
      .catch(() => { if (active) { setIdentityError('Oturum doğrulanamadı. Giriş yaparak tekrar deneyin.'); setUser(null); } });
    return () => { active = false; };
  }, [initialUser]);

  if (user === undefined) return <LoadingScreen />;
  if (user === null) return <LoginScreen onAuthenticated={setUser} initialError={identityError} />;
  return <ProtectedShell user={user} onSignedOut={() => setUser(null)} />;
}
