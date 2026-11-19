import type { ReactNode } from 'react';

/**
 * Mobile route identity bar: resolved title + notifications only.
 * The single Menü control belongs to the bottom navigation (DECISIONS.md UI-004).
 */
export function MobileTopBar({
  title,
  notifications,
}: {
  title: string;
  notifications?: ReactNode;
}) {
  return (
    <header className="compact-shell-header mobile-top-bar">
      <div className="mobile-top-bar-start">
        <p className="mobile-shell-title">{title}</p>
      </div>
      <div className="mobile-top-bar-actions">
        {notifications}
      </div>
    </header>
  );
}
