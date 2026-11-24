import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { BuildIdentity } from './BuildIdentity';
import { setDocumentTitle } from './document-title';
import { NewJobMenu } from './jobs/NewJobMenu';
import { paths } from './paths';
import type { CurrentUser } from './services/api';
import { MobileBottomNav } from './shell/MobileBottomNav';
import { PageCreateActionProvider, usePageCreateAction } from './shell/page-create-action';
import { MobileTopBar } from './shell/MobileTopBar';
import { NavigationIcon } from './shell/navigation-icons';
import { ShellUserMenu } from './shell/ShellUserMenu';
import { DunyaDentalBrand } from './shell/DunyaDentalBrand';
import { NotificationCenter } from './notifications/NotificationCenter';
import { DrawerCloseButton } from './ui/DrawerCloseButton';
import { UserAvatar } from './ui/antd/UserAvatar';
import { AppleInstallGuidance } from './install/AppleInstallGuidance';
import { useInstallOpportunity } from './install/InstallOpportunity';

const CommandPalette = lazy(() =>
  import('./shell/CommandPalette').then((module) => ({ default: module.CommandPalette })),
);
import {
  buildNavigationModel,
  groupNavigationBySection,
  groupNavigationForMenu,
  resolveHomePath,
  type NavGroup,
} from './shell/navigation-model';
import { matchRouteIdentity } from './shell/route-identity';
import { ResolvedIdentityProvider, useResolvedIdentity } from './shell/resolved-identity';
import { RouteNavigationProvider } from './shell/route-navigation-provider';

export type AppShellProps = {
  user: CurrentUser;
  pendingSignOut: boolean;
  onSignOut: () => void;
  children: ReactNode;
};

const desktopQuery = '(min-width: 64rem)';
const drawerId = 'app-navigation-drawer';
const roleLabels = { ADMIN: 'Sistem yöneticisi', MANAGER: 'Yönetici', STAFF: 'Personel' } as const;

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

function DestinationNav({
  groups,
  onNavigate,
  label,
}: {
  groups: NavGroup[];
  onNavigate?: () => void;
  label: string;
}) {
  return (
    <nav className="shell-nav" aria-label={label}>
      {groups.map((group) => (
        <section className="shell-nav-section" data-nav-section={group.label} key={group.label}>
          <h2>{group.label}</h2>
          <div className="shell-nav-links">
            {group.items.map((destination) => (
              <NavLink key={destination.id} to={destination.to} onClick={onNavigate}>
                <NavigationIcon id={destination.id} className="shell-nav-icon" />
                <span>{destination.label}</span>
              </NavLink>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}

function Account({ user, pendingSignOut, onSignOut }: Omit<AppShellProps, 'children'>) {
  return (
    <div className="shell-account">
      <div className="shell-identity">
        <UserAvatar name={user.name} size="default" />
        <div>
          <strong>{user.name}</strong>
          <span>{roleLabels[user.role]}</span>
        </div>
      </div>
      <button className="shell-signout" type="button" onClick={onSignOut} disabled={pendingSignOut}>
        {pendingSignOut ? 'Kapatılıyor…' : 'Oturumu kapat'}
      </button>
    </div>
  );
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
}

/** Stable remount key so navigation resets any page-supplied runtime label (stale-label safety). */
function identityScopeKey(pathname: string): string {
  const match = matchRouteIdentity(pathname);
  if (!match) return 'unknown';
  const paramsKey = Object.entries(match.params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return paramsKey ? `${match.identity.id}?${paramsKey}` : match.identity.id;
}

export function AppShell({ user, pendingSignOut, onSignOut, children }: AppShellProps) {
  const location = useLocation();
  const match = matchRouteIdentity(location.pathname);
  return (
    <ResolvedIdentityProvider scopeKey={identityScopeKey(location.pathname)} match={match} role={user.role}>
      <RouteNavigationProvider user={user}>
        <PageCreateActionProvider>
          <ShellBody user={user} pendingSignOut={pendingSignOut} onSignOut={onSignOut}>
            {children}
          </ShellBody>
        </PageCreateActionProvider>
      </RouteNavigationProvider>
    </ResolvedIdentityProvider>
  );
}

function getSearchShortcutLabel() {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

function ShellBody({ user, pendingSignOut, onSignOut, children }: AppShellProps) {
  const desktop = useDesktopLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const model = buildNavigationModel(user);
  const homePath = resolveHomePath(user);
  const install = useInstallOpportunity();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const paletteOpenerRef = useRef<HTMLElement | null>(null);
  const restorePaletteFocusRef = useRef(false);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const resolved = useResolvedIdentity();
  const pageCreate = usePageCreateAction();
  // Single resolved identity feeds MobileTopBar and document.title. Desktop
  // route identity is owned by PageHeader; the desktop topbar carries global
  // quick search, create action, notifications, and compact user menu.
  const title = resolved?.effectiveTitle ?? 'Dünya Dental';
  const applicationSettingsActive = location.pathname === paths.settingsApplication;
  const showGlobalAppleGuidance = install.shouldOfferAppleGuidance && !applicationSettingsActive;
  const menuGroups = groupNavigationForMenu(model.destinations);
  const shortcutLabel = getSearchShortcutLabel();

  useEffect(() => {
    setDocumentTitle(resolved?.effectiveTitle ?? null);
  }, [resolved?.effectiveTitle]);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    setDrawerOpen(false);
  }, []);

  function openDrawer(opener: HTMLElement) {
    drawerOpenerRef.current = opener;
    setDrawerOpen(true);
  }

  const closePalette = useCallback((restoreFocus = true) => {
    restorePaletteFocusRef.current = restoreFocus;
    setPaletteOpen(false);
  }, []);

  const openPalette = useCallback((opener: HTMLElement | null) => {
    paletteOpenerRef.current = opener ?? searchTriggerRef.current;
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    if (desktop && drawerOpen) closeDrawer(false);
    if (!desktop && paletteOpen) closePalette(false);
  }, [desktop, drawerOpen, paletteOpen, closeDrawer, closePalette]);

  // Back/Forward or programmatic navigation while the panel is open must close
  // it and release the scroll lock. Focus is not pushed back to the stale
  // trigger: the new route owns the page.
  const routeKey = `${location.pathname}${location.search}`;
  const previousRouteKeyRef = useRef(routeKey);
  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    if (drawerOpen) closeDrawer(false);
    if (paletteOpen) closePalette(false);
  }, [routeKey, drawerOpen, paletteOpen, closeDrawer, closePalette]);

  useEffect(() => {
    if (paletteOpen || !restorePaletteFocusRef.current) return;
    restorePaletteFocusRef.current = false;
    paletteOpenerRef.current?.focus();
  }, [paletteOpen]);

  useEffect(() => {
    if (!desktop) return;

    function handleGlobalShortcut(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      if (!paletteOpen && document.querySelector('[role="dialog"][aria-modal="true"]:not(.command-palette-dialog)')) {
        return;
      }
      event.preventDefault();
      if (paletteOpen) {
        closePalette(true);
      } else {
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        openPalette(active);
      }
    }

    document.addEventListener('keydown', handleGlobalShortcut);
    return () => document.removeEventListener('keydown', handleGlobalShortcut);
  }, [desktop, paletteOpen, openPalette, closePalette]);

  useEffect(() => {
    if (!drawerOpen) {
      if (restoreFocusRef.current) drawerOpenerRef.current?.focus();
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
    <div className={`authenticated-shell${desktop ? ' authenticated-shell--desktop' : ' authenticated-shell--mobile'}`}>
      {desktop ? (
        <>
          <aside className="shell-sidebar">
            <div className="shell-sidebar-brand brand-lockup">
              <DunyaDentalBrand variant="full" to={homePath} />
            </div>
            <DestinationNav groups={groupNavigationBySection(model.destinations)} label="Ana navigasyon" />
            <div className="shell-sidebar-footer">
              <small className="shell-copyright">© {new Date().getFullYear()} Dünya Dental</small>
              <BuildIdentity />
            </div>
          </aside>
          <header className="desktop-shell-topbar">
            <button
              ref={searchTriggerRef}
              type="button"
              className="desktop-shell-search-trigger"
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              onClick={() => openPalette(searchTriggerRef.current)}
            >
              <NavigationIcon id="search" className="desktop-shell-search-icon" />
              <span className="desktop-shell-search-placeholder">Ara… (müşteri, iş, sayfa)</span>
              <kbd className="shell-kbd" aria-hidden="true">{shortcutLabel}</kbd>
            </button>
            <div className="desktop-shell-new-job">
              {pageCreate ? (
                <button
                  type="button"
                  className="primary-button compact-button new-job-menu-trigger desktop-shell-page-create"
                  disabled={pageCreate.disabled}
                  onClick={(event) => pageCreate.run(event.currentTarget)}
                >
                  <span className="new-job-menu-trigger-icon" aria-hidden="true">
                    <NavigationIcon id="new-job" className="desktop-shell-create-icon" />
                  </span>
                  <span className="new-job-menu-trigger-label">{pageCreate.label}</span>
                </button>
              ) : (
                <NewJobMenu
                  presentation="popover"
                  triggerIcon={<NavigationIcon id="new-job" className="desktop-shell-create-icon" />}
                  onCreateMeeting={() => navigate(paths.newMeeting)}
                  onCreateTask={() => navigate(paths.newTask)}
                  onCreateSale={() => navigate(paths.newStandaloneSale)}
                  onCreateDelivery={() => navigate(paths.newDelivery)}
                  onCreateWeeklyReport={() => navigate(paths.newWeeklyReport)}
                />
              )}
            </div>
            <NotificationCenter identityKey={`${user.organizationId}:${user.id}`} mobile={false} />
            <ShellUserMenu
              user={user}
              roleLabel={roleLabels[user.role]}
              pendingSignOut={pendingSignOut}
              onSignOut={onSignOut}
            />
          </header>
        </>
      ) : (
        <MobileTopBar
          title={title}
          notifications={<NotificationCenter identityKey={`${user.organizationId}:${user.id}`} mobile />}
        />
      )}

      <div className="shell-content">
        {showGlobalAppleGuidance && (
          <AppleInstallGuidance onDismiss={install.dismissGuidance} />
        )}
        {children}
      </div>

      {!desktop && (
        <MobileBottomNav
          items={model.bottom}
          menuExpanded={drawerOpen}
          menuControlsId={drawerId}
          menuTriggerRef={menuTriggerRef}
          onOpenMenu={openDrawer}
          onCreateMeeting={() => navigate(paths.newMeeting)}
          onCreateTask={() => navigate(paths.newTask)}
          onCreateSale={() => navigate(paths.newStandaloneSale)}
          onCreateDelivery={() => navigate(paths.newDelivery)}
          onCreateWeeklyReport={() => navigate(paths.newWeeklyReport)}
        />
      )}

      {!desktop && drawerOpen && (
        <div className="shell-drawer-backdrop" onClick={(event) => {
            if (event.target === event.currentTarget) closeDrawer(true);
          }}>
          <div id={drawerId} ref={drawerRef} className="shell-drawer" role="dialog" aria-modal="true"
            aria-labelledby="app-navigation-title" onKeyDown={handleDrawerKeyDown}>
            <div className="drawer-heading">
              <h2 id="app-navigation-title">Menü</h2>
              <DrawerCloseButton label="Menüyü kapat" onClick={() => closeDrawer(true)} />
            </div>
            <Account user={user} pendingSignOut={pendingSignOut} onSignOut={onSignOut} />
            <DestinationNav
              groups={menuGroups}
              onNavigate={() => closeDrawer(true)}
              label="Tüm destinasyonlar"
            />
            <BuildIdentity />
          </div>
        </div>
      )}
      {desktop && paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            user={user}
            destinations={model.destinations}
            onClose={closePalette}
          />
        </Suspense>
      )}
    </div>
  );
}
