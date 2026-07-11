import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://servora:servora@localhost:5432/servora_med',
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
    });
  });

  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });

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
    expect(() => loadConfig({ ...validEnvironment, NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGIN is required in production',
    );
  });

  it.each(['*', 'https://med.example.com/path', 'not-a-url'])(
    'rejects unsafe CORS origin %s',
    (corsOrigin) => {
      expect(() => loadConfig({ ...validEnvironment, CORS_ORIGIN: corsOrigin })).toThrow(
        'CORS_ORIGIN must be one http or https origin without a path',
      );
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
