import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { DunyaDentalBrand } from './DunyaDentalBrand';

export function MobileTopBar({
  title,
  backTo,
  menuExpanded,
  menuControlsId,
  onOpenMenu,
  menuTriggerRef,
  notifications,
}: {
  title: string;
  backTo: string | null;
  menuExpanded: boolean;
  menuControlsId: string;
  onOpenMenu: (opener: HTMLElement) => void;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  notifications?: ReactNode;
}) {
  return (
    <header className="compact-shell-header mobile-top-bar">
      <div className="mobile-top-bar-start">
        <DunyaDentalBrand compact />
        {backTo ? (
          <Link className="mobile-top-back" to={backTo}>Geri</Link>
        ) : (
          <span className="mobile-top-back mobile-top-back--spacer" aria-hidden="true" />
        )}
        <p className="mobile-shell-title">{title}</p>
      </div>
      <div className="mobile-top-bar-actions">
        {notifications}
        <button
          ref={menuTriggerRef}
          className="shell-menu-button"
          type="button"
          aria-label="Menüyü aç"
          aria-haspopup="dialog"
          aria-expanded={menuExpanded}
          aria-controls={menuControlsId}
          onClick={(event) => onOpenMenu(event.currentTarget)}
        >
          Menü
        </button>
      </div>
    </header>
  );
}
