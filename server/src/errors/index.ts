export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type ErrorResponse = {
  statusCode: number;
  body: {
    error: string;
    code: string;
  };
};

export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
      },
    };
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    error.statusCode === 429
  ) {
    return {
      statusCode: 429,
      body: {
        error: 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.',
        code: 'RATE_LIMIT_EXCEEDED',
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: 'Beklenmeyen bir hata oluştu.',
      code: 'INTERNAL_ERROR',
    },
  };
}
