import { forwardRef } from 'react';

/**
 * The single icon-only dismiss control for modal panel headers (menu panel,
 * notification center, form drawer). The visible glyph is decorative; the
 * accessible name always comes from `label`. Geometry lives on `.drawer-close`.
 */
export const DrawerCloseButton = forwardRef<HTMLButtonElement, {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}>(function DrawerCloseButton({ label, onClick, disabled }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="drawer-close"
      aria-label={label}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
});
