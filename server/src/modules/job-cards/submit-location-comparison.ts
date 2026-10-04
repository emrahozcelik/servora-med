/**
 * Slice 2: advisory SUBMIT-vs-START location comparison.
 *
 * The comparison is purely server-side evidence. It never blocks
 * SUBMIT_FOR_APPROVAL: an otherwise valid submission always succeeds, with
 * or without comparison evidence.
 *
 * Two separately testable pieces:
 * - `haversineMeters`: the mathematical distance primitive (metres).
 * - `classifySubmitLocationComparison`: the product policy applied to an
 *   already-computed distance plus the two accuracy snapshots.
 *
 * Boundary semantics: `distanceMeters < warningDistanceMeters` is MATCH;
 * the exact boundary (`===`) is DIFFERENT. Callers pass exact decimals so
 * no floating-point rounding happens inside the policy itself.
 */

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_METERS = 6_371_000;

export const DEFAULT_SUBMIT_LOCATION_WARNING_DISTANCE_METERS = 300;
export const DEFAULT_SUBMIT_LOCATION_MAX_RELIABLE_ACCURACY_METERS = 100;

export type LocationComparisonOutcome = 'MATCH' | 'DIFFERENT' | 'UNRELIABLE';

export type SubmitLocationComparisonPolicy = {
  warningDistanceMeters: number;
  maxReliableAccuracyMeters: number;
};

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in metres between two WGS-84 points.
 *
 * Preconditions (validated at the capture input boundary, not here):
 * finite latitudes in [-90, 90], finite longitudes in [-180, 180].
 * No PostGIS, no network, deterministic for identical inputs.
 */
export function haversineMeters(
  startLatitude: number,
  startLongitude: number,
  submitLatitude: number,
  submitLongitude: number,
): number {
  const lat1 = toRadians(startLatitude);
  const lat2 = toRadians(submitLatitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(submitLongitude - startLongitude);
  const halfChordSquared = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const angularDistance = 2 * Math.asin(Math.min(1, Math.sqrt(halfChordSquared)));
  return EARTH_RADIUS_METERS * angularDistance;
}

/**
 * Product policy for an already-computed distance.
 *
 * UNRELIABLE when either accuracy snapshot exceeds the reliability ceiling —
 * a poor fix must never produce a false DIFFERENT. Otherwise MATCH below
 * the warning distance, DIFFERENT at or above it.
 */
export function classifySubmitLocationComparison(input: {
  distanceMeters: number;
  startAccuracyMeters: number;
  submitAccuracyMeters: number;
  policy: SubmitLocationComparisonPolicy;
}): LocationComparisonOutcome {
  if (
    input.startAccuracyMeters > input.policy.maxReliableAccuracyMeters
    || input.submitAccuracyMeters > input.policy.maxReliableAccuracyMeters
  ) {
    return 'UNRELIABLE';
  }
  return input.distanceMeters < input.policy.warningDistanceMeters ? 'MATCH' : 'DIFFERENT';
}
