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

/**
 * BR5 positive health is NOT authorized by the current two-clock candidate
 * calculation. OT3-C lacks a qualified target clock/anchor/tail error profile,
 * and OT3-D lacks DB-enforced generation producer provenance and writer fencing.
 *
 * This is a source-owned fail-closed release gate, not an environment flag.
 * Replacing BLOCKED with QUALIFIED requires the actual independently reviewed
 * profile, step-aware collection, persisted producer binding and deployment
 * acceptance; do not grant admission based on a SHA string or a test fixture.
 *
 * Does not affect host-observation, TT-A/TT-B, backup execution, or failure
 * classification. Keep all earlier backup history inspectable.
 */
export type Br5PositiveHealthAdmission = 'BLOCKED' | 'QUALIFIED';

export function evaluateBr5PositiveHealthAdmission(): Br5PositiveHealthAdmission {
  return 'BLOCKED';
}
