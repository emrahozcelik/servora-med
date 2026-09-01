import type { Pool } from 'pg';

import type { AppConfig } from './config.js';
import { GoogleReverseGeocoder } from './modules/geocoding/google-reverse-geocoder.js';
import { PostgresReverseGeocodingQuotaGuard } from './modules/geocoding/postgres-reverse-geocoding-quota.js';
import type { ReverseGeocodingQuotaGuard } from './modules/geocoding/reverse-geocoding-quota.js';
import type { ReverseGeocoder } from './modules/job-cards/reverse-geocoder.js';

export type GeolocationDependencies = Readonly<{
  reverseGeocoder?: ReverseGeocoder;
  reverseGeocodingQuotaGuard?: ReverseGeocodingQuotaGuard;
}>;

/** Build the geolocation dependencies used by the production composition root. */
export function createGeolocationDependencies(
  config: AppConfig,
  pool: Pool,
): GeolocationDependencies {
  if (!config.actionScopedGeolocationEnabled) return {};
  if (config.reverseGeocoderProvider !== 'google' || !config.googleGeocodingApiKey) {
    throw new Error(
      'ACTION_SCOPED_GEOLOCATION_ENABLED requires a configured reverse geocoder',
    );
  }

  return {
    reverseGeocodingQuotaGuard: new PostgresReverseGeocodingQuotaGuard(pool, {
      userDailyLimit: config.geocodingUserDailyLimit,
      organizationDailyLimit: config.geocodingOrganizationDailyLimit,
      globalMonthlyLimit: config.geocodingGlobalMonthlyLimit,
    }),
    reverseGeocoder: new GoogleReverseGeocoder({
      apiKey: config.googleGeocodingApiKey,
      timeoutMs: config.reverseGeocoderTimeoutMs,
    }),
  };
}
