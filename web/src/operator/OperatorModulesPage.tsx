import { useCallback, useEffect, useRef, useState } from 'react';

import { BuildIdentity } from '../BuildIdentity';
import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import {
  isModuleVersionConflict,
  isOperatorSessionEnded,
  listInstallationModules,
  operatorErrorMessage,
  operatorLogout,
  setInstallationModuleEnabled,
  type InstallationModule,
  type OperatorProfile,
} from './operator-api';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; modules: InstallationModule[] };

type Feedback =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string; conflict: boolean };

export const OPERATOR_SESSION_ENDED_NOTICE = 'Operatör oturumunuz sona erdi. Lütfen yeniden giriş yapın.';

function formatLastChange(module: InstallationModule): string {
  const date = new Date(module.updatedAt);
  const when = date.toLocaleString('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return module.source === 'ENV_TAKEOVER'
    ? `${when} · kurulum ayarından devralındı`
    : `${when} · operatör tarafından değiştirildi`;
}

function confirmationCopy(module: InstallationModule, next: boolean) {
  return next
    ? {
      title: `${module.label} modülü açılsın mı?`,
      description: `${module.label} sayfası, yetkili müşteri kullanıcılarına görünür olacak. Açık müşteri oturumları kısa süre içinde güncellenir.`,
      confirmLabel: 'Modülü aç',
    }
    : {
      title: `${module.label} modülü kapatılsın mı?`,
      description: `Müşteri kullanıcıları ${module.label} sayfasına erişemeyecek. Açık müşteri oturumlarında sayfa kısa süre içinde kaybolur.`,
      confirmLabel: 'Modülü kapat',
    };
}

export function OperatorModulesPage({ operator, onSessionEnded, onSignedOut }: {
  operator: OperatorProfile;
  onSessionEnded: (notice: string) => void;
  onSignedOut: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirm, setConfirm] = useState<{ module: InstallationModule; next: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  /** After a version conflict the list is stale; switching stays off until it is reloaded. */
  const [stale, setStale] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const loadSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setState({ kind: 'loading' });
    try {
      const modules = await listInstallationModules();
      if (!mounted.current || seq !== loadSeq.current) return;
      setState({ kind: 'ready', modules });
      setStale(false);
    } catch (caught) {
      if (!mounted.current || seq !== loadSeq.current) return;
      if (isOperatorSessionEnded(caught)) { onSessionEnded(OPERATOR_SESSION_ENDED_NOTICE); return; }
      setState({ kind: 'error', message: operatorErrorMessage(caught, 'modules') });
    }
  }, [onSessionEnded]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (feedback?.kind === 'error') feedbackRef.current?.focus();
  }, [feedback]);

  async function applyChange() {
    if (!confirm || pending) return;
    const { module, next } = confirm;
    setPending(true); setFeedback(null);
    try {
      const updated = await setInstallationModuleEnabled(module.key, {
        enabled: next,
        expectedVersion: module.version,
      });
      if (!mounted.current) return;
      setState((current) => current.kind === 'ready'
        ? { kind: 'ready', modules: current.modules.map((entry) => entry.key === updated.key ? updated : entry) }
        : current);
      setFeedback({
        kind: 'success',
        message: `${updated.label} modülü ${updated.enabled ? 'açıldı' : 'kapatıldı'}.`,
      });
    } catch (caught) {
      if (!mounted.current) return;
      if (isOperatorSessionEnded(caught)) { onSessionEnded(OPERATOR_SESSION_ENDED_NOTICE); return; }
      const conflict = isModuleVersionConflict(caught);
      if (conflict) setStale(true);
      setFeedback({ kind: 'error', message: operatorErrorMessage(caught, 'update'), conflict });
    } finally {
      if (mounted.current) { setPending(false); setConfirm(null); }
    }
  }

  async function signOut() {
    setSignOutPending(true);
    try {
      await operatorLogout();
      if (mounted.current) onSignedOut();
    } catch (caught) {
      if (!mounted.current) return;
      setSignOutPending(false);
      setFeedback({ kind: 'error', message: operatorErrorMessage(caught, 'update'), conflict: false });
    }
  }

  function reload() {
    setFeedback(null);
    void load();
  }

  return (
    <main className="workspace operator-workspace" aria-busy={state.kind === 'loading'}>
      <header className="page-header">
        <p className="page-header-eyebrow">Servora-Med kurulum yönetimi</p>
        <div className="page-header-main">
          <h1 className="page-header-title">Modüller</h1>
          <div className="page-header-actions operator-account">
            <p className="operator-account-identity">
              <span className="operator-account-name">{operator.name}</span>
              <span className="operator-account-email">{operator.email}</span>
            </p>
            <button className="secondary-button" type="button" onClick={() => void signOut()} disabled={signOutPending}>
              {signOutPending ? 'Çıkış yapılıyor…' : 'Çıkış yap'}
            </button>
          </div>
        </div>
        <p className="page-header-description">
          Bu kurulumdaki ürün modüllerini açıp kapatın. Değişiklik müşteri kullanıcılarına, sunucuyu yeniden başlatmadan yansır.
        </p>
      </header>

      {feedback?.kind === 'success' && (
        <div className="success-message" role="status">{feedback.message}</div>
      )}
      {feedback?.kind === 'error' && (
        <div className="form-error operator-feedback" role="alert" tabIndex={-1} ref={feedbackRef}>
          <p>{feedback.message}</p>
          {feedback.conflict && (
            <button className="secondary-button" type="button" onClick={reload}>Güncel durumu yükle</button>
          )}
        </div>
      )}

      {state.kind === 'loading' && <LoadingSkeleton title="Modüller yükleniyor…" rows={3} />}
      {state.kind === 'error' && (
        <ResultState
          status="error"
          title="Modüller yüklenemedi"
          description={state.message}
          action={<button className="secondary-button" type="button" onClick={reload}>Tekrar dene</button>}
        />
      )}
      {state.kind === 'ready' && state.modules.length === 0 && (
        <EmptyState
          title="Yönetilebilir modül yok"
          description="Bu sürümde operatör tarafından açılıp kapatılabilen bir modül tanımlı değil."
        />
      )}
      {state.kind === 'ready' && state.modules.length > 0 && (
        <OperationalCard>
          <ul className="operator-module-list" aria-label="Modüller">
            {state.modules.map((module) => {
              const headingId = `operator-module-${module.key}`;
              const stateId = `${headingId}-state`;
              return (
                <li key={module.key} className="operator-module-row">
                  <div className="operator-module-body">
                    <h2 id={headingId} className="operator-module-name">{module.label}</h2>
                    <p className="operator-module-meta">Son değişiklik: {formatLastChange(module)}</p>
                  </div>
                  <button
                    className="operator-switch"
                    type="button"
                    role="switch"
                    aria-checked={module.enabled}
                    aria-labelledby={headingId}
                    aria-describedby={stateId}
                    disabled={pending || stale}
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget;
                      setFeedback(null);
                      setConfirm({ module, next: !module.enabled });
                    }}
                  >
                    <span className="operator-switch-track" aria-hidden="true"><span className="operator-switch-thumb" /></span>
                    <span id={stateId} className="operator-switch-state">{module.enabled ? 'Açık' : 'Kapalı'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </OperationalCard>
      )}

      {confirm && (() => {
        const copy = confirmationCopy(confirm.module, confirm.next);
        return (
          <ConfirmationAction
            open
            title={copy.title}
            description={copy.description}
            confirmLabel={copy.confirmLabel}
            pendingLabel="Uygulanıyor…"
            pending={pending}
            onConfirm={() => void applyChange()}
            onCancel={() => setConfirm(null)}
            returnFocusRef={triggerRef}
          />
        );
      })()}

      <footer className="operator-footer"><BuildIdentity /></footer>
    </main>
  );
}
