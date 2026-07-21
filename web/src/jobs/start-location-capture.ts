export type StartLocationCapture =
  | Readonly<{
      outcome: 'captured';
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      capturedAt: string;
    }>
  | Readonly<{
      outcome: 'unavailable';
      reason:
        | 'PERMISSION_DENIED'
        | 'POSITION_UNAVAILABLE'
        | 'TIMEOUT'
        | 'UNSUPPORTED'
        | 'UNKNOWN';
    }>;

const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
};

function unavailableReason(code: number): Extract<StartLocationCapture, {
  outcome: 'unavailable';
}>['reason'] {
  if (code === 1) return 'PERMISSION_DENIED';
  if (code === 2) return 'POSITION_UNAVAILABLE';
  if (code === 3) return 'TIMEOUT';
  return 'UNKNOWN';
}

export function captureStartLocation(): Promise<StartLocationCapture> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ outcome: 'unavailable', reason: 'UNSUPPORTED' });
  }

  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          outcome: 'captured',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          capturedAt: new Date().toISOString(),
        }),
        (error) => resolve({
          outcome: 'unavailable',
          reason: unavailableReason(error.code),
        }),
        POSITION_OPTIONS,
      );
    } catch {
      resolve({ outcome: 'unavailable', reason: 'UNKNOWN' });
    }
  });
}
