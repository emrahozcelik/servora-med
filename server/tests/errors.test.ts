import { describe, expect, it } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';

describe('toErrorResponse', () => {
  it('maps an application error to its public response', () => {
    expect(toErrorResponse(new AppError('VALIDATION_ERROR', 400, 'Geçersiz istek'))).toEqual({
      statusCode: 400,
      body: {
        error: 'Geçersiz istek',
        code: 'VALIDATION_ERROR',
      },
    });
  });

  it('does not expose an unexpected internal error', () => {
    const response = toErrorResponse(new Error('database host is db.internal'));

    expect(response).toEqual({
      statusCode: 500,
      body: {
        error: 'Beklenmeyen bir hata oluştu.',
        code: 'INTERNAL_ERROR',
      },
    });
    expect(JSON.stringify(response)).not.toContain('db.internal');
  });

  it('serializes only explicit AppError details', () => {
    expect(toErrorResponse(new AppError(
      'VERSION_CONFLICT', 409, 'Güncel veriyi yükleyin.', { currentVersion: 3 },
    ))).toEqual({
      statusCode: 409,
      body: { error: 'Güncel veriyi yükleyin.', code: 'VERSION_CONFLICT', details: { currentVersion: 3 } },
    });

    const response = toErrorResponse(Object.assign(new Error('internal'), { details: { secret: true } }));
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
