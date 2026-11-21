import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { UserAvatar } from '../ui/antd/UserAvatar';
import { NavigationIcon } from './navigation-icons';

export type ShellUserMenuProps = {
  user: CurrentUser;
  roleLabel: string;
  pendingSignOut: boolean;
  onSignOut: () => void;
};

/**
 * Compact desktop topbar account trigger & popover (Topbar Option B).
 * Owns profile/security/settings links and sign-out on desktop so the
 * sidebar footer stays calm without duplicating user controls.
 */
export function ShellUserMenu({
  user,
  roleLabel,
  pendingSignOut,
  onSignOut,
}: ShellUserMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  const { pathname, search } = useLocation();
  const routeKey = `${pathname}${search}`;
  const previousRouteKeyRef = useRef(routeKey);

  const requestClose = useCallback((restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    if (open) requestClose(false);
  }, [routeKey, open, requestClose]);

  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      requestClose(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose(true);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, requestClose]);

  return (
    <div className="shell-user-menu">
      <button
        ref={triggerRef}
        type="button"
        className="shell-user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        <UserAvatar name={user.name} size="small" />
        <span className="shell-user-menu-name">{user.name}</span>
        <NavigationIcon id="chevron-down" className="shell-user-menu-chevron" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={menuId}
          className="shell-user-menu-panel surface-raised"
          role="menu"
          aria-label="Hesap menüsü"
        >
          <div className="shell-user-menu-header">
            <strong>{user.name}</strong>
            <span>{roleLabel}</span>
            <span className="shell-user-menu-email">{user.email}</span>
          </div>

          <div className="shell-user-menu-links">
            {user.role === 'STAFF' && (
              <Link
                role="menuitem"
                className="shell-user-menu-link"
                to={paths.staff}
                onClick={() => requestClose(false)}
              >
                Profilim
              </Link>
            )}
            <Link
              role="menuitem"
              className="shell-user-menu-link"
              to={paths.settingsProfile}
              onClick={() => requestClose(false)}
            >
              Profil ayarları
            </Link>
            <Link
              role="menuitem"
              className="shell-user-menu-link"
              to={paths.settingsSecurity}
              onClick={() => requestClose(false)}
            >
              Güvenlik
            </Link>
            <Link
              role="menuitem"
              className="shell-user-menu-link"
              to={paths.settings}
              onClick={() => requestClose(false)}
            >
              Ayarlar
            </Link>
          </div>

          <div className="shell-user-menu-footer">
            <button
              role="menuitem"
              className="shell-signout shell-user-menu-signout"
              type="button"
              onClick={onSignOut}
              disabled={pendingSignOut}
            >
              <NavigationIcon id="sign-out" className="shell-user-menu-signout-icon" />
              <span>{pendingSignOut ? 'Kapatılıyor…' : 'Oturumu kapat'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
