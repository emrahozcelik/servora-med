export type ReverseGeocodingQuotaScope = Readonly<{
  provider: 'GOOGLE';
  organizationId: string;
  actorUserId: string;
  now: Date;
}>;

export type ReverseGeocodingQuotaDenialReason =
  | 'USER_DAILY_LIMIT'
  | 'ORGANIZATION_DAILY_LIMIT'
  | 'GLOBAL_MONTHLY_LIMIT';

export type ReverseGeocodingQuotaDecision =
  | Readonly<{
      allowed: true;
      userUsed: number;
      organizationUsed: number;
      globalUsed: number;
    }>
  | Readonly<{
      allowed: false;
      reason: ReverseGeocodingQuotaDenialReason;
    }>;

export interface ReverseGeocodingQuotaGuard {
  reserve(
    scope: ReverseGeocodingQuotaScope,
  ): Promise<ReverseGeocodingQuotaDecision>;
}

export type ReverseGeocodingQuotaLimits = Readonly<{
  userDailyLimit: number;
  organizationDailyLimit: number;
  globalMonthlyLimit: number;
}>;
