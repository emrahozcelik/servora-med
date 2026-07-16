import { NavLink } from 'react-router-dom';

import type { BottomNavItem } from './navigation-model';

export function MobileBottomNav({
  items,
  onOpenMenu,
}: {
  items: BottomNavItem[];
  onOpenMenu: () => void;
}) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
      {items.map((item) => {
        if (item.kind === 'menu') {
          return (
            <button
              key={item.id}
              type="button"
              className="mobile-bottom-nav-item mobile-bottom-nav-menu"
              onClick={onOpenMenu}
            >
              {item.label}
            </button>
          );
        }
        return (
          <NavLink
            key={item.id}
            to={item.to}
            className={({ isActive }) =>
              `mobile-bottom-nav-item${isActive ? ' mobile-bottom-nav-item--active' : ''}`
            }
          >
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
