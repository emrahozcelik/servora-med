import { useState } from 'react';

export function DunyaDentalBrand({ compact = false }: Readonly<{ compact?: boolean }>) {
  const [failed, setFailed] = useState(false);
  return <span className={`dunya-dental-brand${compact ? ' dunya-dental-brand--compact' : ''}`} aria-label="Dünya Dental">
    {!failed && <img src="/branding/dunya-dental.png" alt="" onError={() => setFailed(true)} />}
    {failed && <span>Dünya Dental</span>}
  </span>;
}
