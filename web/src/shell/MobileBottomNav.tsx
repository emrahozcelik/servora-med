import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';

import type { BottomNavItem } from './navigation-model';

export function MobileBottomNav({
  items,
  onOpenMenu,
  menuExpanded,
  menuControlsId,
  menuTriggerRef,
}: {
  items: BottomNavItem[];
  onOpenMenu: (opener: HTMLElement) => void;
  menuExpanded: boolean;
  menuControlsId: string;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
      {items.map((item) => {
        if (item.kind === 'menu') {
          return (
            <button
              key={item.id}
              ref={menuTriggerRef}
              type="button"
              className="mobile-bottom-nav-item mobile-bottom-nav-menu"
              aria-haspopup="dialog"
              aria-expanded={menuExpanded}
              aria-controls={menuControlsId}
              onClick={(event) => onOpenMenu(event.currentTarget)}
            >
              {item.label}
            </button>
          );
        }
        const visible = item.shortLabel ?? item.label;
        const hasShort = item.shortLabel !== undefined && item.shortLabel !== item.label;
        return (
          <NavLink
            key={item.id}
            to={item.to}
            className={({ isActive }) =>
              `mobile-bottom-nav-item${isActive ? ' mobile-bottom-nav-item--active' : ''}`
            }
            aria-label={hasShort ? item.label : undefined}
          >
            {visible}
          </NavLink>
        );
      })}
    </nav>
  );
}
