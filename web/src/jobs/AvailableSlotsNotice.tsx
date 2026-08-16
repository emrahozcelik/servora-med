import { useEffect, useState } from 'react';

import type { AvailableSlot } from './jobs-api';

const INITIAL_VISIBLE_SLOTS = 6;

function dateLabelForSlot(slot: AvailableSlot): string {
  return new Intl.DateTimeFormat('tr-TR', {
    weekday: 'short', day: '2-digit', month: '2-digit',
  }).format(new Date(slot.startsAt));
}

function timeLabelForSlot(slot: AvailableSlot): string {
  const time = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
  return `${time.format(new Date(slot.startsAt))}–${time.format(new Date(slot.endsAt))}`;
}

function slotKey(slot: AvailableSlot): string {
  return `${slot.startsAt}:${slot.endsAt}`;
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
  const [expanded, setExpanded] = useState(false);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(false);
    setSelectedSlotKey(null);
  }, [slots]);

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
      <>
        <div className="available-slots-list" role="group" aria-label="Ortak uygun saat seçenekleri">
          {(expanded ? slots : slots.slice(0, INITIAL_VISIBLE_SLOTS)).map((slot) => {
            const key = slotKey(slot);
            const dateLabel = dateLabelForSlot(slot);
            const timeLabel = timeLabelForSlot(slot);
            const selected = selectedSlotKey === key;
            return (
              <button
                key={key}
                data-available-slot
                className={`available-slot-option${selected ? ' available-slot-option--selected' : ''}`}
                type="button"
                aria-label={`${dateLabel}, ${timeLabel}`}
                aria-pressed={selected}
                onClick={() => {
                  setSelectedSlotKey(key);
                  onSelect(slot);
                }}
              >
                <span className="available-slots-slot-date">{dateLabel}</span>
                <span className="available-slots-slot-time">{timeLabel}</span>
              </button>
            );
          })}
        </div>
        {slots.length > INITIAL_VISIBLE_SLOTS && (
          <button
            className="available-slots-toggle secondary-button"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Daha az göster' : 'Daha fazla göster'}
          </button>
        )}
      </>
    )}
  </section>;
}
