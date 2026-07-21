import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStartLocation } from '../src/jobs/start-location-capture.js';

const options = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
};

function installGeolocation(
  run: (
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ) => void,
) {
  const getCurrentPosition = vi.fn(run);
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
  return getCurrentPosition;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('captureStartLocation', () => {
  it('returns the exact captured envelope and browser options', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T06:15:30.123Z'));
    const getCurrentPosition = installGeolocation((success) => success({
      coords: {
        latitude: 39.92077,
        longitude: 32.85411,
        accuracy: 24.5,
      },
    } as GeolocationPosition));

    await expect(captureStartLocation()).resolves.toEqual({
      outcome: 'captured',
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24.5,
      capturedAt: '2026-07-21T06:15:30.123Z',
    });
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      options,
    );
  });

  it.each([
    [1, 'PERMISSION_DENIED'],
    [2, 'POSITION_UNAVAILABLE'],
    [3, 'TIMEOUT'],
    [99, 'UNKNOWN'],
  ] as const)('normalizes browser error %s as %s', async (code, reason) => {
    installGeolocation((_success, error) => error?.({ code } as GeolocationPositionError));

    await expect(captureStartLocation()).resolves.toEqual({
      outcome: 'unavailable',
      reason,
    });
  });

  it('returns unsupported without accessing a missing browser API', async () => {
    vi.stubGlobal('navigator', {});

    await expect(captureStartLocation()).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'UNSUPPORTED',
    });
  });

  it('starts at most one browser request per invocation', async () => {
    const getCurrentPosition = installGeolocation((success) => success({
      coords: { latitude: 1, longitude: 2, accuracy: 3 },
    } as GeolocationPosition));

    await captureStartLocation();

    expect(getCurrentPosition).toHaveBeenCalledOnce();
  });
});
