import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { paths } from './paths';
import type { CurrentUser } from './services/api';

export type AppShellProps = {
  user: CurrentUser;
  pendingSignOut: boolean;
  onSignOut: () => void;
  children: ReactNode;
};

const desktopQuery = '(min-width: 64rem)';
const roleLabels = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">S</span>;
}

function useDesktopLayout() {
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || window.matchMedia(desktopQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(desktopQuery);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return desktop;
}

function Navigation({ user, onNavigate }: Pick<AppShellProps, 'user'> & { onNavigate?: () => void }) {
  const destinations = [
    { label: 'İşler', to: paths.jobs },
    { label: 'Müşteriler', to: paths.customers },
    { label: 'Ürünler', to: paths.products },
    ...(user.role === 'ADMIN' ? [{ label: 'Kullanıcılar', to: paths.users }] : []),
    { label: user.role === 'STAFF' ? 'Profilim' : 'Personel', to: paths.staff },
  ];

  return (
    <nav className="shell-nav" aria-label="Ana navigasyon">
      {destinations.map((destination) => (
        <NavLink key={destination.to} to={destination.to} onClick={onNavigate}>
          {destination.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Account({ user, pendingSignOut, onSignOut }: Omit<AppShellProps, 'children'>) {
  return (
    <div className="shell-account">
      <div className="shell-identity">
        <strong>{user.name}</strong>
        <span>{roleLabels[user.role]}</span>
      </div>
      <button className="shell-signout" type="button" onClick={onSignOut} disabled={pendingSignOut}>
        {pendingSignOut ? 'Kapatılıyor…' : 'Oturumu kapat'}
      </button>
    </div>
  );
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
}

export function AppShell({ user, pendingSignOut, onSignOut, children }: AppShellProps) {
  const desktop = useDesktopLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);

  function closeDrawer(restoreFocus: boolean) {
    restoreFocusRef.current = restoreFocus;
    setDrawerOpen(false);
  }

  useEffect(() => {
    if (desktop && drawerOpen) closeDrawer(false);
  }, [desktop, drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) {
      if (restoreFocusRef.current) triggerRef.current?.focus();
      restoreFocusRef.current = false;
      return;
    }

    const drawer = drawerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    focusableElements(drawer!)[0]?.focus();

    const containFocus = (event: FocusEvent) => {
      if (drawer && event.target instanceof Node && !drawer.contains(event.target)) {
        focusableElements(drawer)[0]?.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(event.currentTarget);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  return (
    <div className="authenticated-shell">
      {desktop ? (
        <aside className="shell-sidebar">
          <div className="brand-lockup"><BrandMark /><span>Servora-Med</span></div>
          <Navigation user={user} />
          <Account user={user} pendingSignOut={pendingSignOut} onSignOut={onSignOut} />
        </aside>
      ) : (
        <header className="compact-shell-header">
          <div className="brand-lockup"><BrandMark /><span>Servora-Med</span></div>
          <button ref={triggerRef} className="shell-menu-button" type="button" aria-label="Menüyü aç"
            aria-expanded={drawerOpen} aria-controls="app-navigation-drawer" onClick={() => setDrawerOpen(true)}>
            Menü
          </button>
        </header>
      )}

      <div className="shell-content">{children}</div>

      {!desktop && drawerOpen && (
        <div className="shell-drawer-backdrop">
          <div id="app-navigation-drawer" ref={drawerRef} className="shell-drawer" role="dialog" aria-modal="true"
            aria-labelledby="app-navigation-title" onKeyDown={handleDrawerKeyDown}>
            <div className="drawer-heading">
              <h2 id="app-navigation-title">Menü</h2>
              <button className="drawer-close" type="button" aria-label="Menüyü kapat" onClick={() => closeDrawer(true)}>Kapat</button>
            </div>
            <Navigation user={user} onNavigate={() => closeDrawer(true)} />
            <Account user={user} pendingSignOut={pendingSignOut} onSignOut={onSignOut} />
          </div>
        </div>
      )}
    </div>
  );
}
