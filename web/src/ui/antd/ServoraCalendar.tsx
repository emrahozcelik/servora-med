import { Button } from 'antd';
import { Calendar } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useMemo, type ReactNode } from 'react';

import { intersectedLocalDates } from '../../calendar/calendar-date';

export type ServoraCalendarEventSummary = {
  id: string;
  source: 'JOB' | 'MANUAL';
  title: string;
  startsAt: string;
  endsAt: string | null;
};

export type ServoraCalendarProps = {
  month: Date;
  selectedDate: Date;
  events: ServoraCalendarEventSummary[];
  compact: boolean;
  maxVisibleEventsPerDay: number;
  onMonthChange: (month: Date) => void;
  onDateSelect: (date: Date) => void;
};

function toDayjs(date: Date): Dayjs {
  return dayjs(date);
}

function fromDayjs(d: Dayjs): Date {
  return d.toDate();
}

/** Servora-owned Turkish month label for displayed calendar month. */
function monthLabel(d: Dayjs): string {
  return d.format('MMMM YYYY');
}

/**
 * Servora-owned Ant Calendar adapter.
 * Only this module may import Calendar and Dayjs directly.
 * CalendarPage uses only Date and ISO-string values.
 */
export function ServoraCalendar({
  month,
  selectedDate,
  events,
  compact,
  maxVisibleEventsPerDay,
  onMonthChange,
  onDateSelect,
}: ServoraCalendarProps): ReactNode {
  const monthDayjs = useMemo(() => toDayjs(month), [month]);
  const selectedDayjs = useMemo(() => toDayjs(selectedDate), [selectedDate]);
  const today = useMemo(() => dayjs(), []);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, ServoraCalendarEventSummary[]>();
    for (const event of events) {
      for (const dateKey of intersectedLocalDates(event.startsAt, event.endsAt)) {
        const list = map.get(dateKey) ?? [];
        list.push(event);
        map.set(dateKey, list);
      }
    }
    return map;
  }, [events]);

  const handlePanelChange = useCallback(
    (value: Dayjs) => {
      onMonthChange(fromDayjs(value));
    },
    [onMonthChange],
  );

  const handleSelect = useCallback(
    (value: Dayjs) => {
      onDateSelect(fromDayjs(value));
    },
    [onDateSelect],
  );

  const fullCellRender = useCallback(
    (current: Dayjs) => {
      const dateKey = current.format('YYYY-MM-DD');
      const dayEvents = eventsByDate.get(dateKey) ?? [];
      const isToday = current.isSame(today, 'day');
      const isSelected = current.isSame(selectedDayjs, 'day');
      const isCurrentMonth = current.month() === monthDayjs.month();

      return (
        <div
          className={`servora-calendar-cell${isSelected ? ' servora-calendar-cell--selected' : ''}${isToday ? ' servora-calendar-cell--today' : ''}${!isCurrentMonth ? ' servora-calendar-cell--outside' : ''}`}
          data-date={dateKey}
        >
          <span className="servora-calendar-date">{current.date()}</span>
          {!compact && dayEvents.length > 0 && (
            <div className="servora-calendar-events">
              {dayEvents.slice(0, maxVisibleEventsPerDay).map((event) => (
                <span
                  key={event.id}
                  className={`servora-calendar-event-summary servora-calendar-event-summary--${event.source.toLowerCase()}`}
                >
                  <span className="servora-calendar-event-time">
                    {new Date(event.startsAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="servora-calendar-event-label">{event.title}</span>
                  <span className="sr-only">
                    {event.source === 'JOB' ? 'İş' : 'Kişisel plan'}
                  </span>
                </span>
              ))}
              {dayEvents.length > maxVisibleEventsPerDay && (
                <span className="servora-calendar-overflow" aria-label={`${dayEvents.length - maxVisibleEventsPerDay} plan daha`}>
                  +{dayEvents.length - maxVisibleEventsPerDay} plan
                </span>
              )}
            </div>
          )}
          {compact && dayEvents.length > 0 && (
            <span className="servora-calendar-count" aria-label={`${dayEvents.length} plan`}>
              {dayEvents.length}
            </span>
          )}
        </div>
      );
    },
    [eventsByDate, monthDayjs, selectedDayjs, today, compact, maxVisibleEventsPerDay],
  );

  // Custom header: prev / today / next with accessible labels
  const headerRender = useCallback(
    ({ value, onChange }: { value: Dayjs; onChange: (d: Dayjs) => void }) => {
      const goPrev = () => onChange(value.subtract(1, 'month'));
      const goNext = () => onChange(value.add(1, 'month'));
      const goToday = () => {
        onChange(today);
        onDateSelect(fromDayjs(today));
      };

      return (
        <div className="servora-calendar-header">
          <Button
            onClick={goPrev}
            aria-label="Önceki ay"
            size={compact ? 'small' : 'middle'}
          >
            ‹ Önceki
          </Button>
          <Button
            onClick={goToday}
            aria-label="Bugüne dön"
            size={compact ? 'small' : 'middle'}
          >
            Bugün
          </Button>
          <span className="servora-calendar-header-label">
            {monthLabel(value)}
          </span>
          <Button
            onClick={goNext}
            aria-label="Sonraki ay"
            size={compact ? 'small' : 'middle'}
          >
            Sonraki ›
          </Button>
        </div>
      );
    },
    [today, compact, onDateSelect],
  );

  return (
    <div className={`servora-calendar${compact ? ' servora-calendar--compact' : ''}`}>
      <Calendar
        value={selectedDayjs}
        onSelect={handleSelect}
        onPanelChange={handlePanelChange}
        fullCellRender={fullCellRender}
        fullscreen={!compact}
        headerRender={headerRender}
      />
    </div>
  );
}
