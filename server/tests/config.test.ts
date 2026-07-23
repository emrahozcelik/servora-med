import { createECDH } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://servora:servora@localhost:5432/servora_med',
};

const productionBase = {
  ...validEnvironment,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  CORS_ORIGIN: 'https://app.example.com',
  TRUSTED_PROXY: 'loopback',
  HEALTH_SCHEMA_VERSION: '007_sales_meeting',
};

const webPushPrivateKeyBytes = Buffer.alloc(32, 0);
webPushPrivateKeyBytes[31] = 1;
const webPushEcdh = createECDH('prime256v1');
webPushEcdh.setPrivateKey(webPushPrivateKeyBytes);
const validWebPushEnvironment = {
  WEB_PUSH_ENABLED: 'true',
  WEB_PUSH_VAPID_SUBJECT: 'mailto:operations@example.com',
  WEB_PUSH_VAPID_PUBLIC_KEY: webPushEcdh.getPublicKey().toString('base64url'),
  WEB_PUSH_VAPID_PRIVATE_KEY: webPushPrivateKeyBytes.toString('base64url'),
};

describe('loadConfig', () => {
  it('parses explicit values', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        NODE_ENV: 'test',
        HOST: '0.0.0.0',
        PORT: '4100',
        LOG_LEVEL: 'warn',
        CORS_ORIGIN: 'https://med.example.com',
        SESSION_TTL_SECONDS: '7200',
        LOGIN_RATE_LIMIT_MAX: '8',
        RATE_LIMIT_WINDOW_MS: '90000',
        TRUSTED_PROXY: '127.0.0.1',
        HEALTH_SCHEMA_VERSION: '007_sales_meeting',
      }),
    ).toEqual({
      nodeEnv: 'test',
      host: '0.0.0.0',
      port: 4100,
      databaseUrl: validEnvironment.DATABASE_URL,
      logLevel: 'warn',
      corsOrigin: 'https://med.example.com',
      sessionTtlSeconds: 7200,
      loginRateLimitMax: 8,
      rateLimitWindowMs: 90000,
      trustedProxy: '127.0.0.1',
      healthSchemaVersion: '007_sales_meeting',
      actionScopedGeolocationEnabled: false,
      reverseGeocoderProvider: null,
      googleGeocodingApiKey: null,
      reverseGeocoderTimeoutMs: 2000,
      geocodingUserDailyLimit: 15,
      geocodingOrganizationDailyLimit: 250,
      geocodingGlobalMonthlyLimit: 8000,
      webPush: {
        enabled: false,
        vapidSubject: null,
        vapidPublicKey: null,
        vapidPrivateKey: null,
      },
    });
  });

  it('uses safe development defaults', () => {
    expect(loadConfig(validEnvironment)).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: validEnvironment.DATABASE_URL,
      logLevel: 'info',
      corsOrigin: 'http://127.0.0.1:5173',
      sessionTtlSeconds: 28800,
      loginRateLimitMax: 5,
      rateLimitWindowMs: 60000,
      trustedProxy: 'loopback',
      healthSchemaVersion: null,
      actionScopedGeolocationEnabled: false,
      reverseGeocoderProvider: null,
      googleGeocodingApiKey: null,
      reverseGeocoderTimeoutMs: 2000,
      geocodingUserDailyLimit: 15,
      geocodingOrganizationDailyLimit: 250,
      geocodingGlobalMonthlyLimit: 8000,
      webPush: {
        enabled: false,
        vapidSubject: null,
        vapidPublicKey: null,
        vapidPrivateKey: null,
      },
    });
  });

  it.each([undefined, '', 'false'])(
    'keeps Web Push disabled for %s without requiring VAPID values',
    (value) => {
      expect(loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENABLED: value,
      }).webPush).toEqual({
        enabled: false,
        vapidSubject: null,
        vapidPublicKey: null,
        vapidPrivateKey: null,
      });
    },
  );

  it.each(['TRUE', '1', 'yes', 'enabled'])(
    'rejects invalid Web Push value %s',
    (value) => {
      expect(() => loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENABLED: value,
      })).toThrow('WEB_PUSH_ENABLED must be true or false');
    },
  );

  it('enables Web Push with a valid, compatible VAPID configuration', () => {
    expect(loadConfig({
      ...validEnvironment,
      ...validWebPushEnvironment,
    }).webPush).toEqual({
      enabled: true,
      vapidSubject: validWebPushEnvironment.WEB_PUSH_VAPID_SUBJECT,
      vapidPublicKey: validWebPushEnvironment.WEB_PUSH_VAPID_PUBLIC_KEY,
      vapidPrivateKey: validWebPushEnvironment.WEB_PUSH_VAPID_PRIVATE_KEY,
    });
  });

  it.each([
    ['WEB_PUSH_VAPID_SUBJECT', 'WEB_PUSH_VAPID_SUBJECT'],
    ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PUBLIC_KEY'],
    ['WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY'],
  ] as const)(
    'requires %s when Web Push is enabled',
    (key, label) => {
      expect(() => loadConfig({
        ...validEnvironment,
        ...validWebPushEnvironment,
        [key]: '',
      })).toThrow(`${label} is required when WEB_PUSH_ENABLED=true`);
    },
  );

  it.each([
    'mailto:not-an-address',
    'http://example.com/push',
    'https://localhost/push',
    'https://127.0.0.1/push',
    'not-a-contact',
  ])('rejects malformed Web Push VAPID subject %s', (subject) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...validWebPushEnvironment,
      WEB_PUSH_VAPID_SUBJECT: subject,
    })).toThrow('WEB_PUSH_VAPID_SUBJECT must be a public https URL or mailto address');
  });

  it.each([
    ['WEB_PUSH_VAPID_PUBLIC_KEY', 'not-base64url'],
    ['WEB_PUSH_VAPID_PUBLIC_KEY', 'YQ=='],
    ['WEB_PUSH_VAPID_PRIVATE_KEY', 'not-base64url'],
    ['WEB_PUSH_VAPID_PRIVATE_KEY', 'YQ=='],
  ] as const)('rejects malformed %s', (key, value) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...validWebPushEnvironment,
      [key]: value,
    })).toThrow(`${key} must be a URL-safe Base64 P-256 key`);
  });

  it('rejects mutually incompatible VAPID keys', () => {
    const otherPrivateKey = Buffer.alloc(32, 0);
    otherPrivateKey[31] = 2;

    expect(() => loadConfig({
      ...validEnvironment,
      ...validWebPushEnvironment,
      WEB_PUSH_VAPID_PRIVATE_KEY: otherPrivateKey.toString('base64url'),
    })).toThrow('WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY must be compatible');
  });

  it('enables action-scoped geolocation only for exact true', () => {
    expect(loadConfig({
      ...validEnvironment,
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
      REVERSE_GEOCODER_PROVIDER: 'google',
      GOOGLE_GEOCODING_API_KEY: 'test-not-a-real-key',
    }).actionScopedGeolocationEnabled).toBe(true);
  });

  it.each([undefined, '', 'false'])(
    'keeps action-scoped geolocation disabled for %s',
    (value) => {
      expect(loadConfig({
        ...validEnvironment,
        ACTION_SCOPED_GEOLOCATION_ENABLED: value,
      }).actionScopedGeolocationEnabled).toBe(false);
    },
  );

  it.each(['TRUE', '1', 'yes', 'enabled'])(
    'rejects invalid action-scoped geolocation value %s',
    (value) => {
      expect(() => loadConfig({
        ...validEnvironment,
        ACTION_SCOPED_GEOLOCATION_ENABLED: value,
      })).toThrow('ACTION_SCOPED_GEOLOCATION_ENABLED must be true or false');
    },
  );

  const completeGoogleGeolocation = {
    ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
    REVERSE_GEOCODER_PROVIDER: 'google',
    GOOGLE_GEOCODING_API_KEY: 'test-not-a-real-key',
    REVERSE_GEOCODER_TIMEOUT_MS: '2000',
    GEOCODING_USER_DAILY_LIMIT: '15',
    GEOCODING_ORG_DAILY_LIMIT: '250',
    GEOCODING_GLOBAL_MONTHLY_LIMIT: '8000',
  } as const;

  it('accepts enabled geolocation with a complete Google provider configuration', () => {
    const config = loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
    });
    expect(config.actionScopedGeolocationEnabled).toBe(true);
    expect(config.reverseGeocoderProvider).toBe('google');
    expect(config.googleGeocodingApiKey).toBe('test-not-a-real-key');
    expect(config.reverseGeocoderTimeoutMs).toBe(2000);
    expect(config.geocodingUserDailyLimit).toBe(15);
    expect(config.geocodingOrganizationDailyLimit).toBe(250);
    expect(config.geocodingGlobalMonthlyLimit).toBe(8000);
  });

  it('does not require Google config when geolocation is disabled', () => {
    const config = loadConfig({
      ...validEnvironment,
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'false',
      GOOGLE_GEOCODING_API_KEY: 'ignored-when-disabled',
    });
    expect(config.actionScopedGeolocationEnabled).toBe(false);
    expect(config.reverseGeocoderProvider).toBeNull();
    expect(config.googleGeocodingApiKey).toBeNull();
  });

  it('requires REVERSE_GEOCODER_PROVIDER when geolocation is enabled', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
      GOOGLE_GEOCODING_API_KEY: 'test-not-a-real-key',
    })).toThrow(
      'REVERSE_GEOCODER_PROVIDER is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  });

  it('rejects an unsupported reverse geocoder provider', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      REVERSE_GEOCODER_PROVIDER: 'mapbox',
    })).toThrow('REVERSE_GEOCODER_PROVIDER must be google');
  });

  it.each(['', '   '])('rejects blank Google geocoding API key %j', (key) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      GOOGLE_GEOCODING_API_KEY: key,
    })).toThrow(
      'GOOGLE_GEOCODING_API_KEY is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  });

  it('rejects missing Google geocoding API key when enabled', () => {
    const { GOOGLE_GEOCODING_API_KEY: _omit, ...without } = completeGoogleGeolocation;
    expect(() => loadConfig({
      ...validEnvironment,
      ...without,
    })).toThrow(
      'GOOGLE_GEOCODING_API_KEY is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  });

  it.each(['499', '5001', 'abc', '0'])(
    'rejects invalid reverse geocoder timeout %s',
    (value) => {
      expect(() => loadConfig({
        ...validEnvironment,
        ...completeGoogleGeolocation,
        REVERSE_GEOCODER_TIMEOUT_MS: value,
      })).toThrow('REVERSE_GEOCODER_TIMEOUT_MS must be an integer between 500 and 5000');
    },
  );

  it.each(['0', '101', 'x'])('rejects invalid user daily limit %s', (value) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      GEOCODING_USER_DAILY_LIMIT: value,
    })).toThrow('GEOCODING_USER_DAILY_LIMIT must be an integer between 1 and 100');
  });

  it.each(['0', '2001'])('rejects invalid organization daily limit %s', (value) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      GEOCODING_ORG_DAILY_LIMIT: value,
    })).toThrow('GEOCODING_ORG_DAILY_LIMIT must be an integer between 1 and 2000');
  });

  it.each(['0', '9001', '10000'])('rejects invalid global monthly limit %s', (value) => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      GEOCODING_GLOBAL_MONTHLY_LIMIT: value,
    })).toThrow('GEOCODING_GLOBAL_MONTHLY_LIMIT must be an integer between 1 and 9000');
  });

  it('rejects user daily limit greater than organization daily limit', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ...completeGoogleGeolocation,
      GEOCODING_USER_DAILY_LIMIT: '20',
      GEOCODING_ORG_DAILY_LIMIT: '10',
    })).toThrow('GEOCODING_USER_DAILY_LIMIT must not exceed GEOCODING_ORG_DAILY_LIMIT');
  });

  it('config error messages never include the API key value', () => {
    const secret = 'super-secret-key-value-never-echo';
    try {
      loadConfig({
        ...validEnvironment,
        ...completeGoogleGeolocation,
        GOOGLE_GEOCODING_API_KEY: secret,
        GEOCODING_GLOBAL_MONTHLY_LIMIT: '10000',
      });
      expect.unreachable('expected config validation to throw');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('accepts production loopback host with https CORS and trusted proxy', () => {
    expect(loadConfig(productionBase)).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      corsOrigin: 'https://app.example.com',
      trustedProxy: 'loopback',
      healthSchemaVersion: '007_sales_meeting',
    });
  });

  it('requires HEALTH_SCHEMA_VERSION in production', () => {
    const { HEALTH_SCHEMA_VERSION: _omit, ...without } = productionBase;
    expect(() => loadConfig(without)).toThrow(
      'HEALTH_SCHEMA_VERSION is required in production',
    );
  });

  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });

  it.each(['mysql://localhost/db', 'http://example.com', 'not-a-url'])(
    'rejects non-PostgreSQL database URL %s',
    (databaseUrl) => {
      expect(() => loadConfig({ DATABASE_URL: databaseUrl })).toThrow(
        'DATABASE_URL must be a postgresql:// or postgres:// URL',
      );
    },
  );

  it.each(['0', '65536', 'abc'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig({ ...validEnvironment, PORT: port })).toThrow(
      'PORT must be an integer between 1 and 65535',
    );
  });

  it('rejects an unsupported environment', () => {
    expect(() => loadConfig({ ...validEnvironment, NODE_ENV: 'preview' })).toThrow(
      'NODE_ENV must be development, test, or production',
    );
  });

  it('requires an explicit CORS origin in production', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      TRUSTED_PROXY: 'loopback',
    })).toThrow('CORS_ORIGIN is required in production');
  });

  it('rejects http CORS origin in production', () => {
    expect(() => loadConfig({
      ...productionBase,
      CORS_ORIGIN: 'http://app.example.com',
    })).toThrow('CORS_ORIGIN must use https in production');
  });

  it.each(['*', 'https://med.example.com/path', 'not-a-url'])(
    'rejects unsafe CORS origin %s',
    (corsOrigin) => {
      expect(() => loadConfig({ ...validEnvironment, CORS_ORIGIN: corsOrigin })).toThrow(
        'CORS_ORIGIN must be one http or https origin without a path',
      );
    },
  );

  it.each(['0.0.0.0', '192.168.1.10', '::'])(
    'rejects non-loopback production host %s',
    (host) => {
      expect(() => loadConfig({ ...productionBase, HOST: host })).toThrow(
        'HOST must be 127.0.0.1 or ::1 in production',
      );
    },
  );

  it.each(['verbose', 'tracee'])(
    'rejects invalid log level %s',
    (logLevel) => {
      expect(() => loadConfig({
        ...validEnvironment,
        LOG_LEVEL: logLevel,
      })).toThrow('LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent');
    },
  );

  it('requires TRUSTED_PROXY in production', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      CORS_ORIGIN: 'https://app.example.com',
      HEALTH_SCHEMA_VERSION: '007_sales_meeting',
    })).toThrow('TRUSTED_PROXY is required in production');
  });

  it.each(['true', '*', '0.0.0.0/0', '10.0.0.1'])(
    'rejects invalid TRUSTED_PROXY %s',
    (trustedProxy) => {
      expect(() => loadConfig({
        ...productionBase,
        TRUSTED_PROXY: trustedProxy,
      })).toThrow('TRUSTED_PROXY must be loopback, 127.0.0.1, or ::1');
    },
  );

  it.each([
    ['SESSION_TTL_SECONDS', '0'],
    ['LOGIN_RATE_LIMIT_MAX', '-1'],
    ['RATE_LIMIT_WINDOW_MS', 'abc'],
  ])('rejects invalid positive integer %s=%s', (name, value) => {
    expect(() => loadConfig({ ...validEnvironment, [name]: value })).toThrow(
      `${name} must be a positive integer`,
    );
  });
});
