import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/services/api';
import { isAmbiguousMutationError, isDefinitiveMutationError } from '../src/jobs/mutation-attempt-error';

describe('mutation attempt error classifier', () => {
  it('treats status-0 INVALID_RESPONSE (non-retryable) as ambiguous', () => {
    const error = new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.', false);
    expect(isAmbiguousMutationError(error)).toBe(true);
    expect(isDefinitiveMutationError(error)).toBe(false);
  });

  it('treats status-0 NETWORK_ERROR (retryable) as ambiguous', () => {
    const error = new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true);
    expect(isAmbiguousMutationError(error)).toBe(true);
    expect(isDefinitiveMutationError(error)).toBe(false);
  });

  it('treats ACTION_IN_PROGRESS as ambiguous regardless of retryable flag', () => {
    for (const retryable of [true, false]) {
      const error = new ApiError(409, 'ACTION_IN_PROGRESS', 'busy', retryable);
      expect(isAmbiguousMutationError(error)).toBe(true);
      expect(isDefinitiveMutationError(error)).toBe(false);
    }
  });

  it('treats authoritative non-retryable non-zero responses as definitive', () => {
    const validation = new ApiError(400, 'VALIDATION_ERROR', 'geçersiz', false);
    const reused = new ApiError(409, 'CLIENT_ACTION_REUSED', 'yeniden kullanılamaz', false);
    const forbidden = new ApiError(403, 'FORBIDDEN', 'yetkiniz yok', false);
    for (const error of [validation, reused, forbidden]) {
      expect(isDefinitiveMutationError(error)).toBe(true);
      expect(isAmbiguousMutationError(error)).toBe(false);
    }
  });

  it('treats authoritative 5xx retryable responses as ambiguous', () => {
    const error = new ApiError(500, 'REQUEST_FAILED', 'sunucu hatası', true);
    expect(isAmbiguousMutationError(error)).toBe(true);
    expect(isDefinitiveMutationError(error)).toBe(false);
  });

  it('treats plain and unknown errors as ambiguous (fail-safe)', () => {
    expect(isAmbiguousMutationError(new Error('bomba'))).toBe(true);
    expect(isAmbiguousMutationError(undefined)).toBe(true);
    expect(isAmbiguousMutationError({ status: 400 } as never)).toBe(true);
    expect(isDefinitiveMutationError(new TypeError('x'))).toBe(false);
  });

  it('does not classify a 4xx retryable response as definitive', () => {
    // A real HTTP 4xx with retryable=true stays ambiguous: the server spoke,
    // but the error contract explicitly says the request may be retried.
    const error = new ApiError(429, 'RATE_LIMITED', 'çok fazla istek', true);
    expect(isAmbiguousMutationError(error)).toBe(true);
    expect(isDefinitiveMutationError(error)).toBe(false);
  });
});
