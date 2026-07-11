import { useEffect, useRef, useState, type FormEvent } from 'react';

import { getCurrentUser, login, logout, type CurrentUser } from './services/api';

type AppProps = { initialUser?: CurrentUser | null };

const roleLabels = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;

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
      <main className="workspace-empty">
        <p className="eyebrow">Çalışma alanı</p>
        <h1>Operasyon alanı hazırlanıyor.</h1>
        <p>Kullanıma açılan iş akışları burada yer alacak.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
      </main>
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
