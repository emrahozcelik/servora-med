import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const enabledGeolocationEnv = {
  DATABASE_URL: 'postgresql://unused',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
  REVERSE_GEOCODER_PROVIDER: 'google',
  GOOGLE_GEOCODING_API_KEY: 'startup-test-key-not-real',
} as const;

describe('action-scoped geolocation startup gate', () => {
  it('fails config load when enabled without Google reverse geocoder settings', () => {
    expect(() => loadConfig({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
    })).toThrow(
      'REVERSE_GEOCODER_PROVIDER is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  });

  it('fails before accepting requests when enabled without an injected reverse geocoder', async () => {
    const config = loadConfig(enabledGeolocationEnv);

    await expect(buildApp(config)).rejects.toThrow(
      'ACTION_SCOPED_GEOLOCATION_ENABLED requires a configured reverse geocoder',
    );
  });

  it('accepts enabled mode only with an injected reverse geocoder', async () => {
    const config = loadConfig(enabledGeolocationEnv);
    const app = await buildApp(config, {
      reverseGeocoder: {
        reverse: async () => ({
          neighborhood: 'Kızılay',
          district: 'Çankaya',
          city: 'Ankara',
          approximateLabel: 'Kızılay Mahallesi, Çankaya / Ankara',
        }),
      },
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
