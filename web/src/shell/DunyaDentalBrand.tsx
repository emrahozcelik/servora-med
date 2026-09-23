import { useState } from 'react';
import { Link } from 'react-router-dom';

export type DunyaDentalBrandVariant = 'full' | 'login-hero';

/** Both approved variants intentionally use the canonical full Dünya Dental artwork. */
const BRAND_SOURCES: Record<DunyaDentalBrandVariant, string> = {
  full: '/branding/dunya-dental-sidebar.png',
  'login-hero': '/branding/dunya-dental-sidebar.png',
};

export type DunyaDentalBrandProps = {
  variant: DunyaDentalBrandVariant;
  to?: string;
  onNavigate?: () => void;
};

export function DunyaDentalBrand({ variant, to, onNavigate }: Readonly<DunyaDentalBrandProps>) {
  const [failed, setFailed] = useState(false);
  const content = (
    <>
      {!failed && <img src={BRAND_SOURCES[variant]} alt="" onError={() => setFailed(true)} />}
      {failed && <span className="dunya-dental-brand__fallback">Dünya Dental</span>}
    </>
  );
  const className = `dunya-dental-brand dunya-dental-brand--${variant}`;

  if (to) {
    return (
      <Link className={className} to={to} aria-label="Dünya Dental ana sayfa" onClick={onNavigate}>
        {content}
      </Link>
    );
  }

  return <span className={className} aria-label="Dünya Dental">{content}</span>;
}
