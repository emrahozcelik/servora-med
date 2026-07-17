/**
 * Shared device-local scheduling helpers for JobCard create forms.
 * Uses local getters/setters — never derive datetime-local values from toISOString().
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format a Date as device-local `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Convert a UTC ISO instant to device-local `YYYY-MM-DDTHH:mm` for datetime-local inputs. */
export function isoInstantToLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO instant: ${value}`);
  }
  return formatLocalDateTime(date);
}

/**
 * Default planned time: now + 1 hour, rounded up to the next 30-minute boundary.
 * Exact 30-minute boundaries (with zero seconds/ms after +1h) are kept.
 */
export function defaultScheduledLocalValue(now: Date): string {
  const target = new Date(now.getTime() + 60 * 60 * 1000);
  let year = target.getFullYear();
  let month = target.getMonth();
  let day = target.getDate();
  let hours = target.getHours();
  let minutes = target.getMinutes();
  const seconds = target.getSeconds();
  const milliseconds = target.getMilliseconds();

  if (seconds > 0 || milliseconds > 0) {
    minutes += 1;
  }

  if (minutes % 30 !== 0) {
    minutes = Math.ceil(minutes / 30) * 30;
  }

  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes %= 60;
  }

  // Let the Date constructor handle hour/day/month/year rollover in local time.
  const rounded = new Date(year, month, day, hours, minutes, 0, 0);
  return formatLocalDateTime(rounded);
}

/**
 * Convert a device-local `YYYY-MM-DDTHH:mm` (or with seconds) value to a UTC ISO instant.
 */
export function localDateTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid local datetime value: ${value}`);
  }
  const local = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
    0,
  );
  if (Number.isNaN(local.getTime())) {
    throw new Error(`Invalid local datetime value: ${value}`);
  }
  return local.toISOString();
}
