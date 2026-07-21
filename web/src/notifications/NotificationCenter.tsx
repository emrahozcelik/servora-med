import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import {
  getUnreadNotificationCount,
  listNotifications,
  markNotificationRead,
  type InAppNotification,
} from '../services/notifications-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { restoreFocus, trapTabKey } from '../ui/antd/overlay-focus';

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
    void loadUnread();
  }, [identityKey]);

  useEffect(() => {
    if (open) void loadPage(null, false);
  }, [open]);

  useEffect(() => { openRef.current = open; }, [open]);

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
    setOpen(false);
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
    <div className={mobile ? 'notification-center-backdrop' : 'notification-center-desktop-layer'}>
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
          <h2 id={titleId}>Bildirimler</h2>
          <button ref={closeRef} type="button" className="drawer-close" onClick={close}>Kapat</button>
        </div>
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
        <span aria-hidden="true">Bildirimler</span>
        {unreadCount && unreadCount > 0 ? <span className="notification-center-badge">{unreadCount}</span> : null}
      </button>
      {panel}
    </div>
  );
}
