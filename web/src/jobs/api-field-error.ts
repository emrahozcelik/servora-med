import type { ApiError } from '../services/api';

/**
 * Reads one server `fieldErrors` entry from an ApiError, falling back to the
 * caller's contract message. The server stays the authority for both the error
 * code and the message; this only decodes the existing error envelope.
 */
export function apiFieldError(error: ApiError, field: string, fallback: string): string {
  const value = error.details?.fieldErrors;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = (value as Record<string, unknown>)[field];
    if (typeof entry === 'string' && entry) return entry;
  }
  return fallback;
}
