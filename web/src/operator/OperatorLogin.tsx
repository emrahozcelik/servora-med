import { useEffect, useRef, useState, type FormEvent } from 'react';

import { BuildIdentity } from '../BuildIdentity';
import { operatorErrorMessage, operatorLogin, type OperatorProfile } from './operator-api';

/** Desktop-only initial focus: on phones it would open the keyboard before the user acts. */
const INITIAL_FOCUS_QUERY = '(min-width: 721px)';

export function OperatorLogin({ onAuthenticated, initialNotice = '' }: {
  onAuthenticated: (operator: OperatorProfile) => void;
  initialNotice?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  useEffect(() => {
    if (initialNotice) return;
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia(INITIAL_FOCUS_QUERY).matches) emailRef.current?.focus();
  }, [initialNotice]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      onAuthenticated(await operatorLogin({
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
      }));
    } catch (caught) {
      setError(operatorErrorMessage(caught, 'login'));
      setPending(false);
    }
  }

  return (
    <main className="login-panel operator-login" aria-labelledby="operator-login-title">
      <section className="login-form-wrap">
        <p className="eyebrow">Servora-Med kurulum yönetimi</p>
        <h1 id="operator-login-title">Operatör girişi</h1>
        <p className="form-intro">
          Bu alan yalnızca kurulumu yöneten operatör hesabı içindir. Müşteri kullanıcıları buradan giriş yapamaz.
        </p>

        {initialNotice && !error && (
          <div className="operator-notice" role="status">{initialNotice}</div>
        )}
        {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}

        <form onSubmit={(event) => void submit(event)} aria-describedby="operator-login-help">
          <div className="field-group">
            <label htmlFor="operator-email">E-posta</label>
            <input
              id="operator-email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              disabled={pending}
              ref={emailRef}
            />
          </div>
          <div className="field-group">
            <label htmlFor="operator-password">Parola</label>
            <div className="password-field">
              <input
                id="operator-password"
                name="password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
                disabled={pending}
              />
              <button
                className="password-toggle"
                type="button"
                aria-pressed={passwordVisible}
                aria-controls="operator-password"
                aria-label={passwordVisible ? 'Parolayı gizle' : 'Parolayı göster'}
                onClick={() => setPasswordVisible((visible) => !visible)}
                disabled={pending}
              >
                {passwordVisible ? 'Gizle' : 'Göster'}
              </button>
            </div>
          </div>
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
          <p className="form-help" id="operator-login-help">
            Hesap erişimi sunucu yöneticisi tarafından verilir ve sıfırlanır.
          </p>
        </form>
        <BuildIdentity />
      </section>
    </main>
  );
}
