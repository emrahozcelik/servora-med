import { AppError } from '../../errors/index.js';

/** Canonical date-only value shared by delivery request identity and persistence. */
export function normalizeExpiryDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0) throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new AppError('VALIDATION_ERROR', 400, 'Teslim ürünü bilgileri geçersiz.');
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
