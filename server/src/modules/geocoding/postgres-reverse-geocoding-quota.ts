import type { Pool, PoolClient } from 'pg';

import {
  dailyBucketExpiresAt,
  istanbulDateString,
  monthlyBucketExpiresAt,
  userDayScopeKey,
  utcMonthStartString,
} from './quota-periods.js';
import type {
  ReverseGeocodingQuotaDecision,
  ReverseGeocodingQuotaDenialReason,
  ReverseGeocodingQuotaGuard,
  ReverseGeocodingQuotaLimits,
  ReverseGeocodingQuotaScope,
} from './reverse-geocoding-quota.js';

type ScopeType = 'GLOBAL_MONTH' | 'ORGANIZATION_DAY' | 'USER_DAY';

type BucketSpec = Readonly<{
  scopeType: ScopeType;
  scopeKey: string;
  periodStart: string;
  expiresAt: Date;
  limit: number;
  denialReason: ReverseGeocodingQuotaDenialReason;
}>;

export class PostgresReverseGeocodingQuotaGuard implements ReverseGeocodingQuotaGuard {
  constructor(
    private readonly pool: Pool,
    private readonly limits: ReverseGeocodingQuotaLimits,
  ) {}

  async reserve(scope: ReverseGeocodingQuotaScope): Promise<ReverseGeocodingQuotaDecision> {
    if (scope.provider !== 'GOOGLE') {
      return { allowed: false, reason: 'GLOBAL_MONTHLY_LIMIT' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM reverse_geocoding_quota_buckets WHERE expires_at < NOW()`,
      );

      const buckets = this.buildBuckets(scope);
      // Fixed order: GLOBAL_MONTH → ORGANIZATION_DAY → USER_DAY (deadlock-safe).
      const used: number[] = [];
      for (const bucket of buckets) {
        const next = await this.tryIncrement(client, bucket);
        if (next === null) {
          await client.query('ROLLBACK');
          return { allowed: false, reason: bucket.denialReason };
        }
        used.push(next);
      }

      await client.query('COMMIT');
      return {
        allowed: true,
        globalUsed: used[0]!,
        organizationUsed: used[1]!,
        userUsed: used[2]!,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // best-effort; connection may already be unusable
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private buildBuckets(scope: ReverseGeocodingQuotaScope): readonly BucketSpec[] {
    const dayStart = istanbulDateString(scope.now);
    const monthStart = utcMonthStartString(scope.now);
    const dayExpires = dailyBucketExpiresAt(scope.now);
    const monthExpires = monthlyBucketExpiresAt(scope.now);

    return [
      {
        scopeType: 'GLOBAL_MONTH',
        scopeKey: 'global',
        periodStart: monthStart,
        expiresAt: monthExpires,
        limit: this.limits.globalMonthlyLimit,
        denialReason: 'GLOBAL_MONTHLY_LIMIT',
      },
      {
        scopeType: 'ORGANIZATION_DAY',
        scopeKey: scope.organizationId,
        periodStart: dayStart,
        expiresAt: dayExpires,
        limit: this.limits.organizationDailyLimit,
        denialReason: 'ORGANIZATION_DAILY_LIMIT',
      },
      {
        scopeType: 'USER_DAY',
        scopeKey: userDayScopeKey(scope.organizationId, scope.actorUserId),
        periodStart: dayStart,
        expiresAt: dayExpires,
        limit: this.limits.userDailyLimit,
        denialReason: 'USER_DAILY_LIMIT',
      },
    ];
  }

  private async tryIncrement(
    client: PoolClient,
    bucket: BucketSpec,
  ): Promise<number | null> {
    const result = await client.query<{ used_count: number }>(
      `INSERT INTO reverse_geocoding_quota_buckets (
         provider,
         scope_type,
         scope_key,
         period_start,
         used_count,
         expires_at
       )
       VALUES ($1, $2, $3, $4::date, 1, $5)
       ON CONFLICT (
         provider,
         scope_type,
         scope_key,
         period_start
       )
       DO UPDATE SET
         used_count = reverse_geocoding_quota_buckets.used_count + 1,
         updated_at = NOW()
       WHERE reverse_geocoding_quota_buckets.used_count < $6
       RETURNING used_count`,
      [
        'GOOGLE',
        bucket.scopeType,
        bucket.scopeKey,
        bucket.periodStart,
        bucket.expiresAt.toISOString(),
        bucket.limit,
      ],
    );
    return result.rows[0]?.used_count ?? null;
  }
}
