import type { LocationFailureReason } from './location-types.js';
import { isoInstant, validation } from './validation.js';

const FAILURE_REASONS: readonly LocationFailureReason[] = [
  'PERMISSION_DENIED',
  'POSITION_UNAVAILABLE',
  'TIMEOUT',
  'UNSUPPORTED',
  'UNKNOWN',
];

export type StartLocationCapture =
  | Readonly<{
      outcome: 'CAPTURED';
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      capturedAt: Date;
    }>
  | Readonly<{
      outcome: 'UNAVAILABLE';
      reason: LocationFailureReason;
    }>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw validation('locationCapture');
  }
}

export function parseStartLocationCapture(value: unknown): StartLocationCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validation('locationCapture');
  }
  const capture = value as Record<string, unknown>;
  if (capture.outcome === 'captured') {
    exactKeys(capture, ['outcome', 'latitude', 'longitude', 'accuracyMeters', 'capturedAt']);
    const { latitude, longitude, accuracyMeters } = capture;
    if (
      typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0
    ) {
      throw validation('locationCapture');
    }
    return {
      outcome: 'CAPTURED',
      latitude,
      longitude,
      accuracyMeters,
      capturedAt: new Date(isoInstant(capture.capturedAt, 'locationCapture.capturedAt')),
    };
  }
  if (capture.outcome === 'unavailable') {
    exactKeys(capture, ['outcome', 'reason']);
    if (!FAILURE_REASONS.includes(capture.reason as LocationFailureReason)) {
      throw validation('locationCapture');
    }
    return { outcome: 'UNAVAILABLE', reason: capture.reason as LocationFailureReason };
  }
  throw validation('locationCapture');
}
