import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_GEOCODING_ENDPOINT,
  GOOGLE_GEOCODING_FIELD_MASK,
  GoogleReverseGeocoder,
  GoogleReverseGeocodingError,
  mapGoogleAddressComponentsForTests,
} from '../src/modules/geocoding/google-reverse-geocoder.js';

const TEST_KEY = 'unit-test-google-key-not-real';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const kizilayComponents = [
  {
    longText: 'Kızılay Mahallesi',
    shortText: 'Kızılay',
    types: ['neighborhood', 'political'],
  },
  {
    longText: 'Çankaya',
    shortText: 'Çankaya',
    types: ['administrative_area_level_2', 'political'],
  },
  {
    longText: 'Ankara',
    shortText: 'Ankara',
    types: ['locality', 'political'],
  },
  {
    longText: 'Türkiye',
    shortText: 'TR',
    types: ['country', 'political'],
  },
];

describe('GoogleReverseGeocoder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls the fixed Google host with header auth, field mask, and TR language', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      results: [{ addressComponents: kizilayComponents }],
    }));
    const geocoder = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      timeoutMs: 2000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await geocoder.reverse({
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24,
      correlationId: 'corr-1',
    });

    expect(result).toEqual({
      neighborhood: 'Kızılay Mahallesi',
      district: 'Çankaya',
      city: 'Ankara',
      approximateLabel: 'Kızılay Mahallesi, Çankaya / Ankara',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(GOOGLE_GEOCODING_ENDPOINT);
    expect(requestUrl.searchParams.get('languageCode')).toBe('tr');
    expect(requestUrl.searchParams.get('regionCode')).toBe('TR');
    expect(requestUrl.searchParams.get('location.latitude')).toBe('39.92077');
    expect(requestUrl.searchParams.get('location.longitude')).toBe('32.85411');
    expect(requestUrl.search).not.toContain(TEST_KEY);
    expect(requestUrl.searchParams.has('key')).toBe(false);
    expect(String(url)).not.toContain('organization');
    expect(String(url)).not.toContain('corr-1');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({
      'X-Goog-Api-Key': TEST_KEY,
      'X-Goog-FieldMask': GOOGLE_GEOCODING_FIELD_MASK,
      Accept: 'application/json',
    });
    expect(JSON.stringify(init)).not.toMatch(/organizationId|actorUserId|jobCard|clientActionId/);
  });

  it('does not retry failed provider calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const geocoder = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(geocoder.reverse({
      latitude: 1, longitude: 2, accuracyMeters: 10, correlationId: 'c',
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'AUTHENTICATION_ERROR'],
    [403, 'AUTHENTICATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ] as const)('maps HTTP %s to %s without leaking body', async (status, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'raw-secret-body', key: TEST_KEY } }),
      { status, headers: { 'content-type': 'application/json' } },
    ));
    const geocoder = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await geocoder.reverse({
        latitude: 1, longitude: 2, accuracyMeters: 10, correlationId: 'c',
      });
      expect.unreachable('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleReverseGeocodingError);
      expect((error as GoogleReverseGeocodingError).code).toBe(code);
      expect(String(error)).not.toContain('raw-secret-body');
      expect(String(error)).not.toContain(TEST_KEY);
      expect(String(error)).not.toContain('39.92077');
    }
  });

  it('treats invalid JSON and empty results as safe failures', async () => {
    const invalidJson = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      fetchImpl: vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(invalidJson.reverse({
      latitude: 1, longitude: 2, accuracyMeters: 10, correlationId: 'c',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const empty = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ results: [] })) as unknown as typeof fetch,
    });
    await expect(empty.reverse({
      latitude: 1, longitude: 2, accuracyMeters: 10, correlationId: 'c',
    })).rejects.toMatchObject({ code: 'ZERO_RESULTS' });
  });

  it('aborts after the configured timeout and ignores late responses', async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve;
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const geocoder = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      timeoutMs: 2000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const pending = geocoder.reverse({
      latitude: 1, longitude: 2, accuracyMeters: 10, correlationId: 'c',
    });
    const expectation = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
    // Late response must not be treated as success even if deliverable.
    resolveFetch?.(jsonResponse({ results: [{ addressComponents: kizilayComponents }] }));
  });

  it('maps incomplete address components without inventing values', () => {
    expect(mapGoogleAddressComponentsForTests([
      { longText: 'Çankaya', types: ['administrative_area_level_2'] },
      { longText: 'Ankara', types: ['locality'] },
    ])).toEqual({
      neighborhood: null,
      district: 'Çankaya',
      city: 'Ankara',
      approximateLabel: 'Çankaya / Ankara',
    });

    expect(mapGoogleAddressComponentsForTests([
      { longText: 'Ankara', types: ['locality', 'administrative_area_level_1'] },
    ])).toEqual({
      neighborhood: null,
      district: null,
      city: 'Ankara',
      approximateLabel: 'Ankara',
    });

    // Duplicate-ish labels are not repeated via case-insensitive exclude set.
    expect(mapGoogleAddressComponentsForTests([
      { longText: 'Çankaya', types: ['neighborhood', 'sublocality_level_1'] },
      { longText: 'çankaya', types: ['administrative_area_level_2'] },
      { longText: 'Ankara', types: ['locality'] },
    ])).toEqual({
      neighborhood: 'Çankaya',
      district: null,
      city: 'Ankara',
      approximateLabel: 'Çankaya, Ankara',
    });
  });

  it('never puts the API key into error messages or logs payload', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const geocoder = new GoogleReverseGeocoder({
      apiKey: TEST_KEY,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 403)) as unknown as typeof fetch,
      logger: {
        info(fields) {
          logs.push(fields);
        },
      },
    });
    await expect(geocoder.reverse({
      latitude: 39.9, longitude: 32.8, accuracyMeters: 5, correlationId: 'c',
    })).rejects.toBeDefined();
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain('39.9');
    expect(serialized).not.toContain('32.8');
    expect(logs[0]).toMatchObject({
      provider: 'GOOGLE',
      operation: 'reverse_geocode',
      result: 'AUTHENTICATION_ERROR',
    });
    expect(logs[0]?.durationBucket).toEqual(expect.any(String));
  });
});
