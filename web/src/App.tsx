import { useEffect, useRef, useState, type FormEvent } from 'react';

import { AppRouter, type WorkspaceState } from './AppRouter';
import { PasswordChangeScreen } from './PasswordChange';
import { ApiError, getCurrentUser, listLegacyWorkspaceJobs, listReferenceCustomers, login, logout, type CurrentUser, type ReferenceCustomer } from './services/api';

type AppProps = { initialUser?: CurrentUser | null };

const roleLabels = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;
export { WorkspaceView, type WorkspaceState } from './AppRouter';

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

function ProtectedShell({ user, onSignedOut }: { user: CurrentUser; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: 'loading' });
  const [customers, setCustomers] = useState<ReferenceCustomer[]>([]);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true; setWorkspace({ kind: 'loading' });
    Promise.all([listLegacyWorkspaceJobs(), listReferenceCustomers()]).then(([jobs, nextCustomers]) => {
      if (active) { setCustomers(nextCustomers); setWorkspace({ kind: 'ready', jobs, customerNames: Object.fromEntries(nextCustomers.map((customer) => [customer.id, customer.name])) }); }
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
      <AppRouter user={user} workspace={workspace} customers={customers}
        notice={notice} onClearNotice={() => setNotice('')}
        onReload={() => setReloadKey((value) => value + 1)}
        onDeliveryCreated={() => { setNotice('Teslim kaydı oluşturuldu.'); setReloadKey((value) => value + 1); }} />
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
  if (user.mustChangePassword) return <PasswordChangeScreen user={user} onChanged={() => setUser(null)} onSignedOut={() => setUser(null)} />;
  return <ProtectedShell user={user} onSignedOut={() => setUser(null)} />;
}
