/**
 * Shared duration formatting authority.
 *
 * One arithmetic implementation, two vocabularies:
 *
 *  - the approval queue has always rendered waiting time in hours with **no day
 *    tier** — 1500 minutes is "25 saat", never "1 gün 1 saat". That shipped
 *    contract is preserved by `formatWaitingMinutes`;
 *  - the overdue row signal needs a day tier, because an overdue job can be
 *    weeks late, and "72 saat" is technically correct but operationally poor.
 *
 * Everything is a pure function of a whole number of seconds or minutes: no
 * locale lookup, no clock, no rounding surprises.
 */

export type SecondParts = { days: number; hours: number; minutes: number; seconds: number };
export type MinuteParts = { hours: number; minutes: number };

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** Split a whole number of seconds into completed days/hours/minutes/seconds. */
export function splitSeconds(totalSeconds: number): SecondParts {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return {
    days: Math.floor(safe / SECONDS_PER_DAY),
    hours: Math.floor((safe % SECONDS_PER_DAY) / SECONDS_PER_HOUR),
    minutes: Math.floor((safe % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
    seconds: safe % SECONDS_PER_MINUTE,
  };
}

/** Split a whole number of minutes into completed hours/minutes. */
export function splitMinutes(totalMinutes: number): MinuteParts {
  const safe = Math.max(0, Math.floor(totalMinutes));
  return { hours: Math.floor(safe / SECONDS_PER_MINUTE), minutes: safe % SECONDS_PER_MINUTE };
}

/**
 * Approval-queue wording. Deliberately has NO day tier: 1500 minutes renders as
 * "25 saat". Existing report copy depends on this exact behaviour.
 */
export function formatWaitingMinutes(totalMinutes: number): string {
  const { hours, minutes } = splitMinutes(totalMinutes);
  if (hours === 0) return `${minutes} dakika`;
  if (minutes === 0) return `${hours} saat`;
  return `${hours} saat ${minutes} dakika`;
}

/**
 * Day-capable magnitude phrase, without a verb. Zero lower units are omitted:
 * "3 gün", "2 gün 1 saat", "3 saat 15 dakika", "59 dakika". Sub-minute
 * magnitudes never claim a precise value.
 */
export function formatDurationSeconds(totalSeconds: number): string {
  const { days, hours, minutes } = splitSeconds(totalSeconds);
  if (days > 0) return hours > 0 ? `${days} gün ${hours} saat` : `${days} gün`;
  if (hours > 0) return minutes > 0 ? `${hours} saat ${minutes} dakika` : `${hours} saat`;
  if (minutes > 0) return `${minutes} dakika`;
  return '1 dakikadan az';
}

/**
 * The OVR-1 row signal: "3 gün 4 saat gecikti". The suffix lives here so the
 * jobs surface and any later consumer share one vocabulary.
 */
export function formatOverdueLateness(totalSeconds: number): string {
  return `${formatDurationSeconds(totalSeconds)} gecikti`;
}
