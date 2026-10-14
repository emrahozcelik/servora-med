import { AppError } from '../../errors/index.js';
import type { SaleSource } from './sale-repository.js';
import type { JobCardEngagementKind } from './types.js';

export const SALE_SOURCE_ENGAGEMENT_KINDS: readonly JobCardEngagementKind[] = [
  'CUSTOMER_VISIT', 'SALES_MEETING', 'PRODUCT_DEMO', 'FOLLOW_UP',
];

/** V1 visit-origin policy, not a global rule for future standalone orders. */
export function assertSaleSourceEligible(source: SaleSource) {
  if (source.type !== 'SALES_MEETING' || source.status !== 'IN_PROGRESS'
    || source.dataClass !== 'BUSINESS' || source.customerId === null
    || source.engagementKind === null || !SALE_SOURCE_ENGAGEMENT_KINDS.includes(source.engagementKind)) {
    throw new AppError('SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE', 409, 'Bu ziyaret satış kaydı oluşturmak için uygun değil.');
  }
}

export function assertSaleTimeValid(soldAt: string, time: Date) {
  if (!isSaleTimeValid(soldAt, time)) {
    throw new AppError('SALE_TIME_INVALID', 400, 'Gerçekleşen satış zamanı geçersizdir.');
  }
}

export function isSaleTimeValid(soldAt: string, time: Date) {
  return Number.isFinite(Date.parse(soldAt)) && Date.parse(soldAt) <= time.valueOf() + 15 * 60_000;
}
