import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import type { AppDependencies } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createProductionAppDependencies } from '../src/app-dependencies.js';
import { createGeolocationDependencies } from '../src/geolocation-dependencies.js';
import { GoogleReverseGeocoder } from '../src/modules/geocoding/google-reverse-geocoder.js';
import { PostgresReverseGeocodingQuotaGuard } from '../src/modules/geocoding/postgres-reverse-geocoding-quota.js';

// TG-001: prove the production composition factory injects the geolocation
// quota guard built from parsed env limits into the runtime JobCardService
// path. The service is replaced with a recording constructor mock so the
// assertion is on the wiring, not on service behavior.
const jobCardServiceCtor = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/job-cards/service.js', () => ({
  JobCardService: jobCardServiceCtor,
}));

// PD-004 isolation: the test passes an explicit synthetic env to loadConfig
// and never depends on a developer .env or ambient process.env.
const SYNTHETIC_ENV = Object.freeze({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://servora:servora@localhost:5432/servora_med_test',
  ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
  REVERSE_GEOCODER_PROVIDER: 'google',
  GOOGLE_GEOCODING_API_KEY: 'synthetic-composition-root-key',
  REVERSE_GEOCODER_TIMEOUT_MS: '2000',
  GEOCODING_USER_DAILY_LIMIT: '15',
  GEOCODING_ORG_DAILY_LIMIT: '250',
  GEOCODING_GLOBAL_MONTHLY_LIMIT: '8000',
  OVERVIEW_DASHBOARD_ENABLED: 'false',
  CALENDAR_ENABLED: 'false',
  MESSAGING_ENABLED: 'false',
  WEB_PUSH_ENABLED: 'false',
  BACKUP_ENABLED: 'false',
  DEMO_DATA_CREATION_ENABLED: 'false',
});

type RecordedInsert = {
  scopeType: string;
  scopeKey: string;
  limit: number;
};

function recordingQuotaPool() {
  const inserts: RecordedInsert[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (Array.isArray(values) && sql.includes('INSERT INTO reverse_geocoding_quota_buckets')) {
        inserts.push({
          scopeType: String(values[1]),
          scopeKey: String(values[2]),
          limit: Number(values[5]),
        });
        return { rows: [{ used_count: 1 }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  return { inserts, pool };
}

describe('geolocation composition root wiring (TG-001)', () => {
  afterEach(() => {
    jobCardServiceCtor.mockClear();
  });

  it('parses the geolocation env contract into explicit limits', () => {
    const config = loadConfig({ ...SYNTHETIC_ENV });

    expect(config.actionScopedGeolocationEnabled).toBe(true);
    expect(config.reverseGeocoderProvider).toBe('google');
    expect(config.googleGeocodingApiKey).toBe('synthetic-composition-root-key');
    expect(config.geocodingUserDailyLimit).toBe(15);
    expect(config.geocodingOrganizationDailyLimit).toBe(250);
    expect(config.geocodingGlobalMonthlyLimit).toBe(8000);
  });

  it('constructs geolocation dependencies through the shared production factory', () => {
    const config = loadConfig({ ...SYNTHETIC_ENV });
    const { pool } = recordingQuotaPool();

    const dependencies = createGeolocationDependencies(config, pool);

    expect(dependencies.reverseGeocoder).toBeInstanceOf(GoogleReverseGeocoder);
    expect(dependencies.reverseGeocodingQuotaGuard).toBeInstanceOf(
      PostgresReverseGeocodingQuotaGuard,
    );
  });

  it('production bootstrap seam calls the geolocation factory and forwards its result', () => {
    const config = loadConfig({ ...SYNTHETIC_ENV });
    const { pool } = recordingQuotaPool();
    const geolocationDependencies = {
      reverseGeocoder: { reverse: vi.fn() },
      reverseGeocodingQuotaGuard: { reserve: vi.fn() },
    };
    const createGeolocation = vi.fn(() => geolocationDependencies);

    const dependencies = createProductionAppDependencies(
      config,
      pool,
      {
        authRepository: {} as AppDependencies['authRepository'],
        jobCardRepository: {} as AppDependencies['jobCardRepository'],
      },
      { createGeolocationDependencies: createGeolocation },
    );

    expect(createGeolocation).toHaveBeenCalledOnce();
    expect(createGeolocation).toHaveBeenCalledWith(config, pool);
    expect(dependencies.reverseGeocoder).toBe(geolocationDependencies.reverseGeocoder);
    expect(dependencies.reverseGeocodingQuotaGuard).toBe(
      geolocationDependencies.reverseGeocodingQuotaGuard,
    );
  });

  it('injects the config-built quota guard and geocoder into JobCardService', async () => {
    const config = loadConfig({ ...SYNTHETIC_ENV });
    const { pool } = recordingQuotaPool();
    const dependencies = createProductionAppDependencies(config, pool, {
      authRepository: {} as AppDependencies['authRepository'],
      jobCardRepository: {} as AppDependencies['jobCardRepository'],
    });
    const app = await buildApp(config, dependencies);
    try {
      expect(jobCardServiceCtor).toHaveBeenCalledTimes(1);
      const [, , , geolocation] = jobCardServiceCtor.mock.calls[0]! as unknown as [
        unknown, unknown, unknown,
        { enabled: boolean; reverseGeocoder?: unknown; quotaGuard?: unknown },
      ];
      expect(geolocation.enabled).toBe(true);
      expect(geolocation.reverseGeocoder).toBe(dependencies.reverseGeocoder);
      // Exact identity: the same guard instance built from config limits is
      // what the runtime JobCardService path will call on every START.
      expect(geolocation.quotaGuard).toBe(
        dependencies.reverseGeocodingQuotaGuard,
      );
    } finally {
      await app.close();
    }
  });

  it('propagates the configured limits into the quota upsert scope keys', async () => {
    const config = loadConfig({ ...SYNTHETIC_ENV });
    const { inserts, pool } = recordingQuotaPool();
    const { reverseGeocodingQuotaGuard: quotaGuard } = createGeolocationDependencies(
      config,
      pool,
    );
    if (!quotaGuard) throw new Error('Expected the production factory to create a quota guard');

    const decision = await quotaGuard.reserve({
      provider: 'GOOGLE',
      organizationId: 'org-1',
      actorUserId: 'staff-1',
      now: new Date('2026-09-01T09:00:00.000Z'),
    });

    expect(decision).toMatchObject({ allowed: true, userUsed: 1, organizationUsed: 1, globalUsed: 1 });
    expect(inserts).toEqual([
      { scopeType: 'GLOBAL_MONTH', scopeKey: 'global', limit: 8000 },
      { scopeType: 'ORGANIZATION_DAY', scopeKey: 'org-1', limit: 250 },
      { scopeType: 'USER_DAY', scopeKey: 'org-1:staff-1', limit: 15 },
    ]);
  });

  it('fails fast when geolocation is enabled without a reverse geocoder', () => {
    const config = {
      ...loadConfig({ ...SYNTHETIC_ENV }),
      reverseGeocoderProvider: null,
      googleGeocodingApiKey: null,
    };
    const { pool } = recordingQuotaPool();

    expect(() => createGeolocationDependencies(config, pool)).toThrow(
      'ACTION_SCOPED_GEOLOCATION_ENABLED requires a configured reverse geocoder',
    );
  });
});
