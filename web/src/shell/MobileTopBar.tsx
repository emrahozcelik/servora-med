import type { ReactNode, RefObject } from 'react';
import { DunyaDentalBrand } from './DunyaDentalBrand';

export function MobileTopBar({
  title,
  menuExpanded,
  menuControlsId,
  onOpenMenu,
  menuTriggerRef,
  notifications,
}: {
  title: string;
  menuExpanded: boolean;
  menuControlsId: string;
  onOpenMenu: (opener: HTMLElement) => void;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  notifications?: ReactNode;
}) {
  return (
    <header className="compact-shell-header mobile-top-bar">
      <div className="mobile-top-bar-start">
        <DunyaDentalBrand variant="topbar" />
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
