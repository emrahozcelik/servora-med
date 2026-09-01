/**
 * Deterministic in-month target date for the calendar responsive smoke.
 *
 * The smoke exercises native AntD mini-calendar cell selection against an
 * adjacent day of the rendered month. The target must stay inside the
 * currently rendered month so the `picker-cell-in-view` selector can always
 * find the cell, and it must differ from the initially selected `today` so
 * the selection actually changes `data-calendar-selected`.
 *
 * Previous wall-clock rule (yesterday, or tomorrow on the 1st) combined with
 * an unpadded day-text lookup in the smoke broke the exercise whenever the
 * resolved target fell on day 1..9, because AntD renders the day value
 * zero-padded ("01".."31"). Deriving the target from the month grid (the 2nd
 * of the rendered month, or the 3rd when today is the 1st or 2nd) keeps the
 * target inside the view for every month length, including February and year
 * rollover.
 */
export function resolveSmokeTargetDate(today: Date): Date {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  if (today.getDate() <= 2) {
    return new Date(today.getFullYear(), today.getMonth(), Math.min(3, daysInMonth), 12);
  }
  return new Date(today.getFullYear(), today.getMonth(), 2, 12);
}
