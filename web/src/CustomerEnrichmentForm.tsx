import { useEffect, useRef, type FormEvent } from 'react';
import type { CustomerDetail } from './services/crm-api';
import { PhoneInput } from './ui/PhoneInput';

export function CustomerEnrichmentForm({ customer, pending, blocked, unavailable = false, onSave, onCancel }: {
  customer: CustomerDetail; pending: boolean; blocked: boolean; unavailable?: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { (formRef.current?.elements.namedItem('phone') as HTMLInputElement | null)?.focus(); }, []);
  return <form ref={formRef} className="record-form" aria-labelledby="customer-enrichment-title" onSubmit={onSave}>
    <div className="customer-form-pair">
      <label className="field-group" htmlFor="enrichment-phone">Telefon<PhoneInput id="enrichment-phone" name="phone" defaultValue={customer.phone} disabled={pending || unavailable} /></label>
      <label className="field-group" htmlFor="enrichment-email">E-posta<input id="enrichment-email" name="email" type="email" autoComplete="email" defaultValue={customer.email ?? ''} disabled={pending || unavailable} /></label>
    </div>
    <div className="customer-form-pair">
      <label className="field-group" htmlFor="enrichment-city">Şehir<input id="enrichment-city" name="city" autoComplete="address-level1" defaultValue={customer.city ?? ''} disabled={pending || unavailable} /></label>
      <label className="field-group" htmlFor="enrichment-district">İlçe<input id="enrichment-district" name="district" autoComplete="address-level2" defaultValue={customer.district ?? ''} disabled={pending || unavailable} /></label>
    </div>
    <label className="field-group" htmlFor="enrichment-address">Adres<textarea id="enrichment-address" name="address" autoComplete="street-address" rows={3} defaultValue={customer.address ?? ''} disabled={pending || unavailable} /></label>
    <div className="form-actions">
      <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
      <button className="primary-button" type="submit" disabled={pending || blocked}>{pending ? 'Kaydediliyor…' : 'İletişim bilgilerini kaydet'}</button>
    </div>
  </form>;
}
