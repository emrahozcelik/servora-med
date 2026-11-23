import { AppError } from '../../errors/index.js';
import { validation } from './validation.js';

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

/** Whole-unit delivery quantity bounds, mirroring SALE-QTY-001. */
export const DELIVERY_QUANTITY_MIN = 1;
export const DELIVERY_QUANTITY_MAX = 999_999_999;

/**
 * Single delivery-item quantity rule for create, add and patch when a
 * quantity is supplied: a finite JSON number that is a whole-unit count in
 * 1–999999999. Fractions are never rounded or truncated. Historical fractional
 * rows stay readable and editable; only a supplied new quantity is validated.
 */
export function parseDeliveryQuantity(value: unknown, field = 'quantity'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < DELIVERY_QUANTITY_MIN || value > DELIVERY_QUANTITY_MAX) {
    throw validation(field);
  }
  return value;
}
