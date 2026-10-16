import { useEffect, useId, useState } from 'react';
import { listContacts, type Contact, type Paginated } from '../services/crm-api';
import type { SaleContact } from './sale-api';

/** Only reads the current customer's active contacts; historical selection stays explicit. */
export function SaleContactSelect({ customerId, selected, onChange, disabled }: {
  customerId: string; selected: SaleContact | null; onChange: (value: SaleContact | null) => void; disabled: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<Paginated<Contact> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; setPage(null); setError(false);
    void listContacts(customerId, { status: 'active', q: query, limit: 20, offset }).then((value) => {
      if (active) setPage(value);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [customerId, query, offset, reload]);
  return <div className="field-group">
    <label htmlFor={id}>Satışta görüşülen kişi (isteğe bağlı)</label>
    <select id={id} disabled={disabled || !page} value={selected?.id ?? ''} onChange={(event) => {
      const contact = page?.items.find((item) => item.id === event.target.value);
      onChange(contact ? { id: contact.id, name: contact.name, title: contact.title } : null);
    }}>
      <option value="">Belirtilmedi</option>
      {selected && !page?.items.some((item) => item.id === selected.id)
        && <option value={selected.id}>{selected.name} (kayıtlı seçim)</option>}
      {page?.items.map((contact) => <option key={contact.id} value={contact.id}>{[contact.name, contact.title].filter(Boolean).join(' · ')}</option>)}
    </select>
    <details className="sale-contact-search"><summary>İlgili kişilerde ara</summary>
    <label className="sr-only" htmlFor={id + '-search'}>İlgili kişilerde ara</label>
    <input id={id + '-search'} type="search" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setQuery(draft.trim()); setOffset(0); setReload((v) => v + 1); } }} />
    <button type="button" className="secondary-button" disabled={disabled} onClick={() => {
      setQuery(draft.trim()); setOffset(0); setReload((v) => v + 1);
    }}>Kişi ara</button></details>
    {!page && !error && <p role="status">İlgili kişiler yükleniyor…</p>}
    {error && <><p role="alert">İlgili kişiler yüklenemedi.</p><button type="button" className="secondary-button" disabled={disabled}
      onClick={() => setReload((v) => v + 1)}>Kişileri tekrar yükle</button></>}
    {page && (offset > 0 || offset + page.limit < page.total) && <nav aria-label="Satış kişileri sayfaları">
      <button type="button" className="secondary-button" disabled={disabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>Önceki kişiler</button>
      <button type="button" className="secondary-button" disabled={disabled || offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>Sonraki kişiler</button>
    </nav>}
  </div>;
}
