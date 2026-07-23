import type {
  ReverseGeocoder,
  ReverseGeocodingInput,
  ReverseGeocodingResult,
} from '../job-cards/reverse-geocoder.js';

export const GOOGLE_GEOCODING_ENDPOINT =
  'https://geocode.googleapis.com/v4/geocode/location';

export const GOOGLE_GEOCODING_FIELD_MASK =
  'results.addressComponents.longText,results.addressComponents.shortText,results.addressComponents.types,results.types';

export type GoogleReverseGeocodingErrorCode =
  | 'TIMEOUT'
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'ZERO_RESULTS';

export class GoogleReverseGeocodingError extends Error {
  readonly code: GoogleReverseGeocodingErrorCode;
  readonly provider = 'GOOGLE' as const;

  constructor(code: GoogleReverseGeocodingErrorCode) {
    super(`Google reverse geocoding failed: ${code}`);
    this.name = 'GoogleReverseGeocodingError';
    this.code = code;
  }
}

export type GoogleReverseGeocoderOptions = Readonly<{
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: {
    info(fields: Record<string, unknown>, message: string): void;
  };
}>;

type AddressComponent = Readonly<{
  longText: string;
  shortText?: string;
  types: readonly string[];
}>;

const NEIGHBORHOOD_TYPES = [
  'neighborhood',
  'sublocality_level_1',
  'sublocality',
  'administrative_area_level_4',
] as const;

const DISTRICT_TYPES = [
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality_level_1',
] as const;

const CITY_TYPES = [
  'locality',
  'administrative_area_level_1',
] as const;

function durationBucket(ms: number): string {
  if (ms < 250) return 'lt_250ms';
  if (ms < 500) return 'lt_500ms';
  if (ms < 1000) return 'lt_1000ms';
  if (ms < 2000) return 'lt_2000ms';
  if (ms < 5000) return 'lt_5000ms';
  return 'gte_5000ms';
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstMatchingComponent(
  components: readonly AddressComponent[],
  types: readonly string[],
  exclude: ReadonlySet<string>,
): string | null {
  for (const type of types) {
    for (const component of components) {
      if (!component.types.includes(type)) continue;
      const text = trimOrNull(component.longText);
      if (!text) continue;
      if (exclude.has(text.toLocaleLowerCase('tr-TR'))) continue;
      return text;
    }
  }
  return null;
}

function buildApproximateLabel(
  neighborhood: string | null,
  district: string | null,
  city: string | null,
): string | null {
  const parts: string[] = [];
  if (neighborhood && district && city) {
    return `${neighborhood}, ${district} / ${city}`;
  }
  if (district && city) {
    return `${district} / ${city}`;
  }
  if (neighborhood && city) {
    return `${neighborhood}, ${city}`;
  }
  if (city) return city;
  if (district) return district;
  if (neighborhood) return neighborhood;
  for (const value of [neighborhood, district, city]) {
    if (value) parts.push(value);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function mapAddressComponents(
  components: readonly AddressComponent[],
): ReverseGeocodingResult | null {
  const neighborhood = firstMatchingComponent(components, NEIGHBORHOOD_TYPES, new Set());
  const used = new Set<string>();
  if (neighborhood) used.add(neighborhood.toLocaleLowerCase('tr-TR'));
  const district = firstMatchingComponent(components, DISTRICT_TYPES, used);
  if (district) used.add(district.toLocaleLowerCase('tr-TR'));
  const city = firstMatchingComponent(components, CITY_TYPES, used);
  const approximateLabel = buildApproximateLabel(neighborhood, district, city);
  if (!approximateLabel) return null;
  return { neighborhood, district, city, approximateLabel };
}

/**
 * Google may omit `types` on some address components (for example POI names).
 * Skip incomplete components instead of rejecting the entire response.
 * Returns null only when `addressComponents` is not an array at all.
 */
function parseAddressComponents(value: unknown): AddressComponent[] | null {
  if (!Array.isArray(value)) return null;
  const components: AddressComponent[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.longText !== 'string') continue;
    if (record.shortText !== undefined && typeof record.shortText !== 'string') continue;
    if (!Array.isArray(record.types) || !record.types.every((t) => typeof t === 'string')) {
      continue;
    }
    if (record.types.length === 0) continue;
    components.push({
      longText: record.longText,
      shortText: typeof record.shortText === 'string' ? record.shortText : undefined,
      types: record.types as string[],
    });
  }
  return components;
}

function mapResults(results: unknown[]): ReverseGeocodingResult | null {
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const components = parseAddressComponents(
      (entry as { addressComponents?: unknown }).addressComponents,
    );
    if (!components || components.length === 0) continue;
    const mapped = mapAddressComponents(components);
    if (mapped) return mapped;
  }
  return null;
}

function mapHttpStatus(status: number): GoogleReverseGeocodingErrorCode {
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 401 || status === 403) return 'AUTHENTICATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_UNAVAILABLE';
}

export class GoogleReverseGeocoder implements ReverseGeocoder {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: GoogleReverseGeocoderOptions['logger'];

  constructor(options: GoogleReverseGeocoderOptions) {
    const key = options.apiKey.trim();
    if (!key) {
      throw new Error('Google reverse geocoder requires a non-empty API key');
    }
    this.apiKey = key;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async reverse(input: ReverseGeocodingInput): Promise<ReverseGeocodingResult> {
    const url = new URL(GOOGLE_GEOCODING_ENDPOINT);
    url.searchParams.set('location.latitude', String(input.latitude));
    url.searchParams.set('location.longitude', String(input.longitude));
    url.searchParams.set('languageCode', 'tr');
    url.searchParams.set('regionCode', 'TR');

    // Defense: never allow the API key into the URL query string.
    if (url.searchParams.has('key') || url.href.includes(this.apiKey)) {
      throw new GoogleReverseGeocodingError('INVALID_REQUEST');
    }

    const controller = new AbortController();
    const started = Date.now();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let resultCode: GoogleReverseGeocodingErrorCode | 'SUCCESS' = 'PROVIDER_UNAVAILABLE';

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'X-Goog-Api-Key': this.apiKey,
            'X-Goog-FieldMask': GOOGLE_GEOCODING_FIELD_MASK,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          resultCode = 'TIMEOUT';
          throw new GoogleReverseGeocodingError('TIMEOUT');
        }
        resultCode = 'PROVIDER_UNAVAILABLE';
        throw new GoogleReverseGeocodingError('PROVIDER_UNAVAILABLE');
      }

      if (!response.ok) {
        resultCode = mapHttpStatus(response.status);
        throw new GoogleReverseGeocodingError(resultCode);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        resultCode = 'INVALID_RESPONSE';
        throw new GoogleReverseGeocodingError('INVALID_RESPONSE');
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        resultCode = 'INVALID_RESPONSE';
        throw new GoogleReverseGeocodingError('INVALID_RESPONSE');
      }

      const results = (body as { results?: unknown }).results;
      if (!Array.isArray(results)) {
        resultCode = 'INVALID_RESPONSE';
        throw new GoogleReverseGeocodingError('INVALID_RESPONSE');
      }
      if (results.length === 0) {
        resultCode = 'ZERO_RESULTS';
        throw new GoogleReverseGeocodingError('ZERO_RESULTS');
      }

      const mapped = mapResults(results);
      if (!mapped) {
        resultCode = 'ZERO_RESULTS';
        throw new GoogleReverseGeocodingError('ZERO_RESULTS');
      }

      resultCode = 'SUCCESS';
      return mapped;
    } finally {
      clearTimeout(timeoutId);
      this.logger?.info({
        provider: 'GOOGLE',
        operation: 'reverse_geocode',
        result: resultCode,
        durationBucket: durationBucket(Date.now() - started),
      }, 'reverse_geocode');
    }
  }
}

/** Pure mapping helper exported for focused unit tests. */
export function mapGoogleAddressComponentsForTests(
  components: readonly AddressComponent[],
): ReverseGeocodingResult | null {
  return mapAddressComponents(components);
}
