/** One canonical scheduled-backup freshness window (26 hours inclusive). */
export const BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/**
 * Chrony's default maximum slew rate (1/12). The accepted `nts-quorum-v1`
 * config does not override `maxslewrate`, and its exact bytes/hash are pinned,
 * so this constant is part of the fixed evidence contract. It bounds how far
 * the system clock can move during the collector's sampling window.
 */
export const TWO_CLOCK_MAX_SLEW_RATE_PPM = 83_333.333;

/**
 * A 26-hour UTC interval can cross at most one leap-second boundary (leap
 * seconds occur only at the end of June or December). `leapsecmode system`,
 * chrony's default, steps the system clock by one second at that boundary, so
 * the UTC delta can under-count real elapsed time by one second.
 */
export const TWO_CLOCK_LEAP_ALLOWANCE_MS = 1_000;
