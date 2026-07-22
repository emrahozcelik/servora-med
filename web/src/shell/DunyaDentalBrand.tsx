import { useState } from 'react';

type DunyaDentalBrandVariant = 'login' | 'sidebar' | 'topbar';

export function DunyaDentalBrand({ variant }: Readonly<{ variant: DunyaDentalBrandVariant }>) {
  const [failed, setFailed] = useState(false);
  return <span className={`dunya-dental-brand dunya-dental-brand--${variant}`} aria-label="Dünya Dental">
    {!failed && <img src="/branding/dunya-dental.png" alt="" onError={() => setFailed(true)} />}
    {failed && <span className="dunya-dental-brand__fallback">Dünya Dental</span>}
  </span>;
}
