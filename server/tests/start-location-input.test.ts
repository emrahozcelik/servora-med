import { describe, expect, it } from 'vitest';

import { parseStartLocationCapture } from '../src/modules/job-cards/start-location-input.js';

describe('parseStartLocationCapture', () => {
  it('accepts an exact captured envelope', () => {
    expect(parseStartLocationCapture({
      outcome: 'captured',
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24.5,
      capturedAt: '2026-07-21T09:15:30.123+03:00',
    })).toEqual({
      outcome: 'CAPTURED',
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24.5,
      capturedAt: new Date('2026-07-21T06:15:30.123Z'),
    });
  });

  it.each([
    'PERMISSION_DENIED',
    'POSITION_UNAVAILABLE',
    'TIMEOUT',
    'UNSUPPORTED',
    'UNKNOWN',
  ] as const)('accepts the unavailable reason %s', (reason) => {
    expect(parseStartLocationCapture({ outcome: 'unavailable', reason }))
      .toEqual({ outcome: 'UNAVAILABLE', reason });
  });

  it.each([
    undefined,
    null,
    {},
    { outcome: 'captured', latitude: 91, longitude: 0, accuracyMeters: 1, capturedAt: '2026-07-21T00:00:00Z' },
    { outcome: 'captured', latitude: 0, longitude: -181, accuracyMeters: 1, capturedAt: '2026-07-21T00:00:00Z' },
    { outcome: 'captured', latitude: Number.NaN, longitude: 0, accuracyMeters: 1, capturedAt: '2026-07-21T00:00:00Z' },
    { outcome: 'captured', latitude: 0, longitude: 0, accuracyMeters: 0, capturedAt: '2026-07-21T00:00:00Z' },
    { outcome: 'captured', latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: '2026-07-21' },
    { outcome: 'captured', latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: '2026-07-21T00:00:00Z', extra: true },
    { outcome: 'unavailable', reason: 'DENIED' },
    { outcome: 'unavailable', reason: 'TIMEOUT', extra: true },
  ])('rejects malformed or non-exact envelopes', (capture) => {
    expect(() => parseStartLocationCapture(capture)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }),
    );
  });
});
