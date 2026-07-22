import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { AppRouter } from './AppRouter';
import { AppShell } from './AppShell';
import { DunyaDentalBrand } from './shell/DunyaDentalBrand';
import { PasswordChangeScreen } from './PasswordChange';
import { RealtimeProvider } from './realtime/RealtimeProvider';
import { getCurrentUser, login, logout, type CurrentUser } from './services/api';
import { createBrowserWebPushAdapter } from './web-push/BrowserWebPushAdapter';
import { createWebPushController, type WebPushController } from './web-push/WebPushController';
import { WebPushProvider } from './web-push/WebPushProvider';

type AppProps = { initialUser?: CurrentUser | null };

export const SUCCESS_NOTICE_DISMISS_MS = 6_000;

export function useAutoDismissNotice(notice: string, onDismiss: () => void) {
  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(onDismiss, SUCCESS_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice, onDismiss]);
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
        <DunyaDentalBrand variant="login" />
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
  const [notice, setNotice] = useState('');
  const clearNotice = useCallback(() => setNotice(''), []);
  const webPushController = useRef<WebPushController | null>(null);
  if (!webPushController.current) {
    webPushController.current = createWebPushController({ browser: createBrowserWebPushAdapter() });
  }
  const resolvedWebPushController = webPushController.current;
  useAutoDismissNotice(notice, clearNotice);
  async function signOut() {
    setPending(true); setError('');
    try {
      await logout();
      await resolvedWebPushController.clearLocalSubscription();
      onSignedOut();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Oturum kapatılamadı.'); setPending(false); }
  }
  return (
    <RealtimeProvider>
      <WebPushProvider identityKey={`${user.organizationId}:${user.id}`} controller={resolvedWebPushController}>
        <AppShell user={user} pendingSignOut={pending} onSignOut={() => void signOut()}>
          <AppRouter user={user}
            notice={notice} onClearNotice={clearNotice}
            onDeliveryCreated={() => setNotice('Teslim kaydı oluşturuldu.')} />
          {error && <div className="shell-error form-error" role="alert">{error}</div>}
        </AppShell>
      </WebPushProvider>
    </RealtimeProvider>
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
