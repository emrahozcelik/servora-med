import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { useInstallOpportunity } from '../install/InstallOpportunity';
import {
  getUnreadNotificationCount,
  listNotifications,
  markNotificationRead,
  type InAppNotification,
} from '../services/notifications-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { restoreFocus, trapTabKey } from '../ui/antd/overlay-focus';
import { useWebPush } from '../web-push/WebPushProvider';

type NotificationCenterProps = Readonly<{
  identityKey: string;
  mobile: boolean;
}>;

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function mergeById(current: readonly InAppNotification[], later: readonly InAppNotification[]) {
  const ids = new Set(current.map((notification) => notification.id));
  return [...current, ...later.filter((notification) => !ids.has(notification.id))];
}

export function NotificationCenter({ identityKey, mobile }: NotificationCenterProps) {
  const navigate = useNavigate();
  const titleId = useId();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const restoreSettingsFocus = useRef(false);
  const unreadRequest = useRef(0);
  const listRequest = useRef(0);
  const openRef = useRef(false);
  const pendingIdRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [items, setItems] = useState<readonly InAppNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [view, setView] = useState<'notifications' | 'settings'>('notifications');
  const [installPending, setInstallPending] = useState(false);
  const [installError, setInstallError] = useState('');
  const install = useInstallOpportunity();
  const webPush = useWebPush();

  async function loadUnread() {
    const request = ++unreadRequest.current;
    try {
      const count = await getUnreadNotificationCount();
      if (request === unreadRequest.current) setUnreadCount(count);
    } catch {
      // Preserve the last canonical count; an unavailable count is not zero.
    }
  }

  async function loadPage(cursor: string | null, append: boolean) {
    const request = ++listRequest.current;
    setLoading(true);
    setLoadError('');
    try {
      const page = await listNotifications({ limit: 20, cursor });
      if (request !== listRequest.current) return;
      setItems((current) => append ? mergeById(current, page.items) : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request === listRequest.current) setLoadError(message(caught, 'Bildirimler yüklenemedi.'));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    unreadRequest.current += 1;
    listRequest.current += 1;
    setOpen(false);
    setUnreadCount(null);
    setItems([]);
    setNextCursor(null);
    setLoading(false);
    setLoadError('');
    setPendingId(null);
    pendingIdRef.current = null;
    setActionError('');
    setView('notifications');
    setInstallPending(false);
    setInstallError('');
    void loadUnread();
  }, [identityKey]);

  useEffect(() => {
    if (open) void loadPage(null, false);
  }, [open]);

  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    if (!open) return;
    if (view === 'settings') {
      settingsBackRef.current?.focus();
      return;
    }
    if (restoreSettingsFocus.current) {
      restoreSettingsFocus.current = false;
      settingsTriggerRef.current?.focus();
    }
  }, [open, view]);

  useRealtimeInvalidation(['notifications'], () => {
    void loadUnread();
    if (openRef.current) void loadPage(null, false);
  });

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const panel = panelRef.current;
    const containFocus = (event: FocusEvent) => {
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        closeRef.current?.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previousOverflow;
      restoreFocus(triggerRef);
    };
  }, [open]);

  function close() {
    setView('notifications');
    setOpen(false);
  }

  async function requestInstall() {
    if (installPending) return;
    setInstallPending(true);
    setInstallError('');
    try {
      await install.prompt();
    } catch (caught) {
      setInstallError(message(caught, 'Yükleme isteği tamamlanamadı.'));
    } finally {
      setInstallPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    trapTabKey(event, panelRef.current);
  }

  async function activate(notification: InAppNotification) {
    if (pendingIdRef.current) return;
    pendingIdRef.current = notification.id;
    setPendingId(notification.id);
    setActionError('');
    try {
      await markNotificationRead(notification.id);
      await Promise.all([loadUnread(), loadPage(null, false)]);
      close();
      navigate(`/jobs/${notification.entity.id}`);
    } catch (caught) {
      setActionError(message(caught, 'Bildirim açılamadı. Lütfen tekrar deneyin.'));
    } finally {
      pendingIdRef.current = null;
      setPendingId(null);
    }
  }

  const panel = open ? (
    <div
      className={mobile ? 'notification-center-backdrop' : 'notification-center-desktop-layer'}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {mobile && <button type="button" className="notification-center-backdrop-button" aria-label="Bildirimleri kapat" onClick={close} />}
      <div
        ref={panelRef}
        id={panelId}
        className={`notification-center-panel${mobile ? ' notification-center-panel--mobile' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className="notification-center-heading">
          <h2 id={titleId}>{view === 'settings' ? 'Kurulum ve cihaz bildirimleri' : 'Bildirimler'}</h2>
          <button ref={closeRef} type="button" className="drawer-close" onClick={close}>Kapat</button>
        </div>
        {view === 'settings' ? (
          <div className="notification-settings">
            <button
              ref={settingsBackRef}
              type="button"
              className="ghost-button notification-settings-back"
              onClick={() => {
                restoreSettingsFocus.current = true;
                setView('notifications');
              }}
            >
              Bildirimlere dön
            </button>
            <section aria-labelledby={`${titleId}-install`}>
              <h3 id={`${titleId}-install`}>Uygulama kurulumu</h3>
              {install.installed ? (
                <p>Uygulama bu cihaza yüklendi.</p>
              ) : install.canPrompt ? (
                <>
                  <p>Servora-Med’i bu cihazda ayrı bir uygulama penceresinde kullanabilirsiniz.</p>
                  <button type="button" className="primary-button" disabled={installPending} onClick={() => void requestInstall()}>
                    {installPending ? 'Yükleniyor…' : 'Uygulamayı yükle'}
                  </button>
                </>
              ) : (
                <p>
                  Tarayıcı menüsünden “Siteyi yükle”, “Dock’a Ekle” veya “Ana Ekrana Ekle” seçeneğini
                  kullanabilirsiniz. iPhone veya iPad’de Safari paylaş menüsünden “Ana Ekrana Ekle”yi
                  seçin.
                </p>
              )}
              {installError && <p className="form-error" role="alert">{installError}</p>}
            </section>
            <section
              aria-labelledby={`${titleId}-push`}
              className="notification-device-push"
              aria-busy={webPush.pending !== null || webPush.enabled === null}
            >
              <h3 id={`${titleId}-push`}>Cihaz bildirimleri</h3>
              <p className="notification-device-push-copy">
                Cihaz bildirimlerini açarsanız size atanan veya onayınızı bekleyen işler için Servora-Med
                kapalıyken de genel bir bildirim gösterilebilir. Bildirimlerde müşteri, not, teslimat veya
                konum bilgisi yer almaz.
              </p>
              {webPush.enabled === null && !webPush.error ? (
                <p role="status" aria-live="polite" className="notification-device-push-loading">
                  Cihaz bildirimi durumu yükleniyor…
                </p>
              ) : null}
              {webPush.guidance === 'disabled' ? (
                <p className="notification-device-push-disabled">Cihaz bildirimleri şu anda kullanıma kapalıdır.</p>
              ) : null}
              {webPush.guidance === 'unsupported' ? (
                <p className="notification-device-push-unsupported">Bu tarayıcı cihaz bildirimlerini desteklemiyor.</p>
              ) : null}
              {webPush.guidance === 'install-required' ? (
                <p className="notification-device-push-unsupported">
                  Bu cihazda bildirimler için uygulamayı Ana Ekrana ekleyip yüklü uygulama olarak açın.
                </p>
              ) : null}
              {webPush.guidance === 'denied' ? (
                <p className="notification-device-push-denied">
                  Bildirim izni kapalı. Tarayıcı veya işletim sistemi ayarlarından izin verebilirsiniz.
                </p>
              ) : null}
              {webPush.guidance === 'renewal-required' ? (
                <p className="notification-device-push-renewal">
                  Cihaz bildirimi aboneliği yenilenmeli. Yenileme yalnız aşağıdaki açık komutla yapılır.
                </p>
              ) : null}
              {webPush.error ? (
                <p className="form-error notification-device-push-error" role="alert">{webPush.error}</p>
              ) : null}
              {webPush.enabled === true && webPush.guidance === 'none' ? (
                webPush.status?.subscription ? (
                  <button
                    type="button"
                    className="secondary-button notification-device-push-action"
                    disabled={webPush.pending !== null}
                    aria-busy={webPush.pending === 'disable'}
                    onClick={() => void webPush.disable()}
                  >
                    {webPush.pending === 'disable' ? 'Kapatılıyor…' : 'Cihaz bildirimlerini kapat'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-button notification-device-push-action"
                    disabled={webPush.pending !== null}
                    aria-busy={webPush.pending === 'enable'}
                    onClick={() => void webPush.enable()}
                  >
                    {webPush.pending === 'enable' ? 'Açılıyor…' : 'Cihaz bildirimlerini aç'}
                  </button>
                )
              ) : webPush.enabled === true && webPush.guidance === 'renewal-required' ? (
                <button
                  type="button"
                  className="primary-button notification-device-push-action"
                  disabled={webPush.pending !== null}
                  aria-busy={webPush.pending === 'enable'}
                  onClick={() => void webPush.enable()}
                >
                  {webPush.pending === 'enable' ? 'Yenileniyor…' : 'Cihaz bildirimlerini yenile'}
                </button>
              ) : null}
            </section>
          </div>
        ) : (
          <>
            <button
              ref={settingsTriggerRef}
              type="button"
              className="secondary-button notification-settings-trigger"
              onClick={() => setView('settings')}
            >
              Kurulum ve cihaz bildirimleri
            </button>
            {actionError && <p className="form-error" role="alert">{actionError}</p>}
            {loadError && (
              <div className="notification-center-message" role="alert">
                <p>{loadError}</p>
                <button type="button" className="secondary-button" onClick={() => void loadPage(null, false)} disabled={loading}>Tekrar dene</button>
              </div>
            )}
            {loading && items.length === 0 && <p className="notification-center-message" role="status">Bildirimler yükleniyor…</p>}
            {!loading && !loadError && items.length === 0 && <p className="notification-center-message">Henüz bildiriminiz yok.</p>}
            {items.length > 0 && (
              <ol className="notification-center-list">
                {items.map((notification) => {
                  const pending = pendingId === notification.id;
                  return (
                    <li key={notification.id}>
                      <button
                        type="button"
                        data-notification-id={notification.id}
                        className="notification-center-item"
                        disabled={pending}
                        aria-label={`${notification.title} bildirimini aç${notification.readAt ? '' : ' ve okundu olarak işaretle'}`}
                        onClick={() => void activate(notification)}
                      >
                        <span className="notification-center-item-title">{notification.title}</span>
                        <span>{notification.body}</span>
                        <span className="notification-center-item-meta">
                          <time dateTime={notification.createdAt}>{new Date(notification.createdAt).toLocaleString('tr-TR')}</time>
                          <span>{notification.readAt ? 'Okundu' : 'Okunmadı'}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
            {nextCursor && (
              <button type="button" className="secondary-button notification-center-more" disabled={loading}
                onClick={() => void loadPage(nextCursor, true)}>
                {loading ? 'Yükleniyor…' : 'Daha fazla yükle'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="notification-center">
      <button
        ref={triggerRef}
        type="button"
        className="shell-notification-trigger"
        aria-label="Bildirimler"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
      >
        <svg className="shell-notification-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>
        {unreadCount && unreadCount > 0 ? <span className="notification-center-badge">{unreadCount}</span> : null}
      </button>
      {panel}
    </div>
  );
}
