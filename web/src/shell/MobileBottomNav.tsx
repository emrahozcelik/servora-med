import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';

import { NewJobMenu } from '../jobs/NewJobMenu';
import { NavigationIcon } from './navigation-icons';
import type { BottomNavItem } from './navigation-model';

export function MobileBottomNav({
  items,
  onOpenMenu,
  menuExpanded,
  menuControlsId,
  menuTriggerRef,
  onCreateMeeting,
  onCreateTask,
  onCreateSale,
  onCreateDelivery,
  onCreateWeeklyReport,
}: {
  items: BottomNavItem[];
  onOpenMenu: (opener: HTMLElement) => void;
  menuExpanded: boolean;
  menuControlsId: string;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  onCreateMeeting?: () => void;
  onCreateTask?: () => void;
  onCreateSale?: () => void;
  onCreateDelivery?: () => void;
  onCreateWeeklyReport?: () => void;
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
              <NavigationIcon id={item.id} />
              <span className="mobile-bottom-nav-label">{item.label}</span>
            </button>
          );
        }
        if (item.kind === 'create') {
          return (
            <div key={item.id} className="mobile-bottom-nav-create">
              <NewJobMenu
                presentation="sheet"
                triggerIcon={<NavigationIcon id={item.id} />}
                onCreateMeeting={onCreateMeeting}
                onCreateTask={onCreateTask}
                onCreateSale={onCreateSale}
                onCreateDelivery={onCreateDelivery}
                onCreateWeeklyReport={onCreateWeeklyReport}
              />
            </div>
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
            <NavigationIcon id={item.id} />
            <span className="mobile-bottom-nav-label">{visible}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
