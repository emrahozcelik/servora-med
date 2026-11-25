import { useEffect, useState } from 'react';

import { useHorizontalOverflow } from '../ui/useHorizontalOverflow';
import type { AvailableSlot } from './jobs-api';
import { isoInstantToLocalDateTime } from './scheduling';

const INITIAL_VISIBLE_SLOTS = 6;

const shortWeekday = new Intl.DateTimeFormat('tr-TR', { weekday: 'short' });
const longWeekday = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' });
const shortMonth = new Intl.DateTimeFormat('tr-TR', { month: 'short' });
const longMonth = new Intl.DateTimeFormat('tr-TR', { month: 'long' });
const dayOfMonth = new Intl.DateTimeFormat('tr-TR', { day: 'numeric' });
const clockTime = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

type SlotDay = {
  key: string;
  shortLabel: string;
  longLabel: string;
  slots: AvailableSlot[];
};

function localDateKey(slot: AvailableSlot): string {
  return isoInstantToLocalDateTime(slot.startsAt).slice(0, 10);
}

function dayLabelParts(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00`);
  return {
    short: `${shortWeekday.format(date)} ${dayOfMonth.format(date)} ${shortMonth.format(date)}`,
    long: `${dayOfMonth.format(date)} ${longMonth.format(date)} ${longWeekday.format(date)}`,
  };
}

function startTimeLabel(slot: AvailableSlot): string {
  return clockTime.format(new Date(slot.startsAt));
}

function timeLabelForSlot(slot: AvailableSlot): string {
  return `${startTimeLabel(slot)}–${clockTime.format(new Date(slot.endsAt))}`;
}

function groupSlotsByDay(slots: AvailableSlot[]): SlotDay[] {
  const groups = new Map<string, SlotDay>();
  for (const slot of slots) {
    let key: string;
    try {
      key = localDateKey(slot);
    } catch {
      continue;
    }
    const labels = dayLabelParts(key);
    const existing = groups.get(key);
    if (existing) existing.slots.push(slot);
    else {
      groups.set(key, {
        key, shortLabel: labels.short, longLabel: labels.long, slots: [slot],
      });
    }
  }
  return [...groups.values()];
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
  disabled = false,
  selectedStartLocal,
  onSelect,
}: {
  searched: boolean;
  searching: boolean;
  slots: AvailableSlot[];
  error: Error | null;
  featureDisabled: boolean;
  /** OVR-5 §5.4: the planned time is locked, so slots must not be selectable. */
  disabled?: boolean;
  selectedStartLocal?: string;
  onSelect: (slot: AvailableSlot) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  const { ref: stripRef, overflow } = useHorizontalOverflow<HTMLDivElement>(
    `${slots.length}:${expanded}`,
  );

  useEffect(() => {
    setExpanded(false);
    setSelectedSlotKey(null);
  }, [slots]);

  if (!searched && !searching && !error && !featureDisabled) return null;
  const visibleSlots = expanded ? slots : slots.slice(0, INITIAL_VISIBLE_SLOTS);
  const days = groupSlotsByDay(visibleSlots);
  return <section className="available-slots-notice" aria-live="polite" aria-labelledby="available-slots-heading">
    <h2 id="available-slots-heading">Personel için uygun saatler</h2>
    {searching && <p role="status">Atanan personel için uygun saatler aranıyor…</p>}
    {!searching && featureDisabled && <p role="status">Takvim uygun saat araması etkin değil.</p>}
    {!searching && !featureDisabled && error && (
      <p role="status">Uygun saatler yüklenemedi. Formu yine kaydedebilirsiniz.</p>
    )}
    {!searching && !featureDisabled && !error && slots.length === 0 && (
      <p role="status">Bu aralık için uygun saat bulunamadı.</p>
    )}
    {!searching && !error && !featureDisabled && slots.length > 0 && (
      <div className="available-slots-strip-shell" data-overflow={overflow ? 'true' : 'false'}>
        <div
          ref={stripRef}
          className="available-slots-strip"
          role="group"
          aria-label="Personel için uygun saat seçenekleri"
        >
          {days.map((day) => (
            <div className="available-slots-day" key={day.key}>
              <span className="available-slots-day-label">{day.shortLabel}</span>
              <div className="available-slots-day-chips">
                {day.slots.map((slot) => {
                  const key = slotKey(slot);
                  const timeLabel = timeLabelForSlot(slot);
                  let matchesControlledStart = false;
                  if (selectedStartLocal !== undefined) {
                    try {
                      matchesControlledStart = isoInstantToLocalDateTime(slot.startsAt)
                        === selectedStartLocal;
                    } catch {
                      matchesControlledStart = false;
                    }
                  }
                  const selected = selectedStartLocal !== undefined
                    ? matchesControlledStart
                    : selectedSlotKey === key;
                  return (
                    <button
                      key={key}
                      data-available-slot
                      className={`available-slot-chip${selected ? ' available-slot-option--selected' : ''}`}
                      type="button"
                      disabled={disabled}
                      aria-label={`${day.longLabel} ${timeLabel}`}
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedSlotKey(key);
                        onSelect(slot);
                      }}
                    >
                      {startTimeLabel(slot)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {slots.length > INITIAL_VISIBLE_SLOTS && (
            <button
              className="available-slots-toggle"
              type="button"
              disabled={disabled}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? 'Daha az göster' : 'Daha fazla göster'}
            </button>
          )}
        </div>
      </div>
    )}
  </section>;
}
