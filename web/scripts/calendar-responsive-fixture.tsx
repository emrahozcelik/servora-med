import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { localDayKey } from '../src/calendar/calendar-date';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import {
  ServoraCalendar,
  type ServoraCalendarEventSummary,
} from '../src/ui/antd/ServoraCalendar';
import { useCompact } from '../src/ui/useResponsive';

import { resolveSmokeTargetDate } from './calendar-responsive-smoke-dates';

function atLocalTime(date: Date, hour: number, minute: number): string {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next.toISOString();
}

function createFixture() {
  const today = new Date();
  const month = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const targetDate = resolveSmokeTargetDate(today);
  const events: ServoraCalendarEventSummary[] = Array.from(
    { length: 12 },
    (_, index) => ({
      id: `calendar-smoke-today-${index + 1}`,
      source: index % 2 === 0 ? 'JOB' : 'MANUAL',
      title: `Bugün planı ${index + 1}`,
      startsAt: atLocalTime(today, 9 + Math.floor(index / 2), (index % 2) * 15),
      endsAt: null,
    }),
  );

  events.push({
    id: 'calendar-smoke-target',
    source: 'JOB',
    title: 'Alternatif gün planı',
    startsAt: atLocalTime(targetDate, 14, 0),
    endsAt: null,
  });

  return { today, month, targetDate, events };
}

function CalendarResponsiveFixture() {
  const fixture = useMemo(createFixture, []);
  const compact = useCompact();
  const [month, setMonth] = useState(fixture.month);
  const [selectedDate, setSelectedDate] = useState(fixture.today);

  return (
    <main className="workspace calendar-workspace" data-calendar-smoke-ready="true">
      <div
        data-calendar-state
        data-calendar-selected={localDayKey(selectedDate)}
        data-calendar-target={localDayKey(fixture.targetDate)}
        data-calendar-month={`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`}
      />
      <div className="calendar-toolbar surface" aria-label="Takvim filtreleri">
        <label htmlFor="calendar-personnel-filter">
          Personel
          <select id="calendar-personnel-filter" name="personnel" defaultValue="all">
            <option value="all">Tüm yetkili personel</option>
            <option value="staff-1">Ayşe Personel</option>
          </select>
        </label>
      </div>
      <section className="calendar-layout" aria-label="Takvim responsive fixture">
        <div className="calendar-grid-section surface">
          <ServoraCalendar
            month={month}
            selectedDate={selectedDate}
            events={fixture.events}
            compact={compact}
            maxVisibleEventsPerDay={3}
            onMonthChange={setMonth}
            onDateSelect={setSelectedDate}
          />
        </div>
        <aside className="calendar-agenda-section surface" aria-label="Seçili gün ajandası">
          <h2 className="calendar-agenda-heading">Seçili gün</h2>
          <p data-calendar-agenda>{localDayKey(selectedDate)}</p>
        </aside>
      </section>
    </main>
  );
}

const mount = document.getElementById('calendar-responsive-root');
if (!mount) {
  throw new Error('Calendar responsive fixture mount is missing');
}

createRoot(mount).render(
  <ServoraAntProvider>
    <CalendarResponsiveFixture />
  </ServoraAntProvider>,
);
