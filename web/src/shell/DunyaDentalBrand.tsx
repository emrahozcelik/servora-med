import { useState } from 'react';

type DunyaDentalBrandVariant = 'login' | 'sidebar' | 'topbar';

/** Explicit variant source map: sidebar uses the cropped Dünya Dental mark. */
const BRAND_SOURCES: Record<DunyaDentalBrandVariant, string> = {
  login: '/branding/dunya-dental.png',
  topbar: '/branding/dunya-dental.png',
  sidebar: '/branding/dunya-dental-sidebar.png',
};

export function DunyaDentalBrand({ variant }: Readonly<{ variant: DunyaDentalBrandVariant }>) {
  const [failed, setFailed] = useState(false);
  return <span className={`dunya-dental-brand dunya-dental-brand--${variant}`} aria-label="Dünya Dental">
    {!failed && <img src={BRAND_SOURCES[variant]} alt="" onError={() => setFailed(true)} />}
    {failed && <span className="dunya-dental-brand__fallback">Dünya Dental</span>}
  </span>;
}
