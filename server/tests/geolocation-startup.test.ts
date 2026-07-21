import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('action-scoped geolocation startup gate', () => {
  it('fails before accepting requests when enabled without a reverse geocoder', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
    });

    await expect(buildApp(config)).rejects.toThrow(
      'ACTION_SCOPED_GEOLOCATION_ENABLED requires a configured reverse geocoder',
    );
  });

  it('accepts enabled mode only with an injected reverse geocoder', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://unused',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
    });
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
