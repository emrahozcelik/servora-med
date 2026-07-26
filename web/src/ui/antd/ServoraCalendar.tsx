import dayjs, { type Dayjs } from 'dayjs';
import { Calendar } from 'antd';
import { useCallback, useMemo, type ReactNode } from 'react';

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

const DAY_MS = 24 * 60 * 60 * 1_000;

function toDayjs(date: Date): Dayjs {
  return dayjs(date);
}

function fromDayjs(d: Dayjs): Date {
  return d.toDate();
}

/**
 * Collect all local dates intersected by a half-open interval [start, end).
 * A point event (no end) renders only on startsAt's date.
 * An event ending exactly at midnight does not render on the ending date.
 */
export function intersectedDates(
  startsAt: string,
  endsAt: string | null,
): string[] {
  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : start;

  // Normalize to local date boundaries
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  const dates: string[] = [];
  // Half-open: cursor < endDate, not <=
  while (cursor < endDate) {
    dates.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  // Ensure point event (no end) appears at least on startsAt's date
  if (dates.length === 0) {
    dates.push(
      `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    );
  }
  return dates;
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

  const eventsByDate = useMemo(() => {
    const map = new Map<string, ServoraCalendarEventSummary[]>();
    for (const event of events) {
      for (const dateKey of intersectedDates(event.startsAt, event.endsAt)) {
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
      const isToday = current.isSame(dayjs(), 'day');
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
            <span className="servora-calendar-count">{dayEvents.length}</span>
          )}
        </div>
      );
    },
    [eventsByDate, monthDayjs, selectedDayjs, compact, maxVisibleEventsPerDay],
  );

  return (
    <div className={`servora-calendar${compact ? ' servora-calendar--compact' : ''}`}>
      <Calendar
        value={selectedDayjs}
        onSelect={handleSelect}
        onPanelChange={handlePanelChange}
        fullCellRender={fullCellRender}
        fullscreen={!compact}
      />
    </div>
  );
}
