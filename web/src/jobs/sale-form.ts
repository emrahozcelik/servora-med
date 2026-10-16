import { listProducts, type ProductFilters } from '../services/products-api';

export const loadSaleProducts = (filters: ProductFilters) => listProducts({ ...filters, status: 'active', dataClass: 'BUSINESS' });
export function saleCount(value: string): number | null {
  if (!/^[1-9]\d{0,8}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= 999999999 ? number : null;
}
