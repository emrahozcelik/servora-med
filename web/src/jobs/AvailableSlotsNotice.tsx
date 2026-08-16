import type { AvailableSlot } from './jobs-api';

function labelForSlot(slot: AvailableSlot): string {
  const start = new Date(slot.startsAt).toLocaleString('tr-TR', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const end = new Date(slot.endsAt).toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit',
  });
  return `${start}–${end}`;
}

export function AvailableSlotsNotice({
  searched,
  searching,
  slots,
  error,
  featureDisabled,
  onSelect,
}: {
  searched: boolean;
  searching: boolean;
  slots: AvailableSlot[];
  error: Error | null;
  featureDisabled: boolean;
  onSelect: (slot: AvailableSlot) => void;
}) {
  if (!searched && !searching && !error && !featureDisabled) return null;
  return <section className="available-slots-notice" aria-live="polite" aria-labelledby="available-slots-heading">
    <h2 id="available-slots-heading">Ortak uygun saatler</h2>
    {searching && <p role="status">Müşteri ve personel için uygun saatler aranıyor…</p>}
    {!searching && featureDisabled && <p role="status">Takvim uygun saat araması etkin değil.</p>}
    {!searching && !featureDisabled && error && (
      <p role="status">Uygun saatler yüklenemedi. Formu yine kaydedebilirsiniz.</p>
    )}
    {!searching && !featureDisabled && !error && slots.length === 0 && (
      <p role="status">Bu aralık için ortak uygun saat bulunamadı.</p>
    )}
    {!searching && !error && !featureDisabled && slots.length > 0 && (
      <div className="available-slots-list">
        {slots.map((slot) => (
          <button
            key={`${slot.startsAt}:${slot.endsAt}`}
            data-available-slot
            className="secondary-button"
            type="button"
            onClick={() => onSelect(slot)}
          >
            {labelForSlot(slot)}
          </button>
        ))}
      </div>
    )}
  </section>;
}
