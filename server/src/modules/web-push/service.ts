import type { WebPushConfig } from '../../config.js';
import { AppError } from '../../errors/index.js';
import {
  fingerprintVapidPublicKey,
  WebPushOwnershipConflictError,
  type WebPushIdentity,
  type WebPushRepository,
} from './repository.js';
import type { CreateWebPushSubscription } from './validation.js';

export type WebPushStatus = Readonly<{
  enabled: boolean;
  vapidPublicKey: string | null;
  renewalRequired: boolean;
  subscription: null | Readonly<{
    id: string;
    createdAt: string;
    fingerprint: string;
  }>;
}>;

export class WebPushService {
  constructor(
    private readonly config: WebPushConfig,
    private readonly repository: WebPushRepository,
  ) {}

  async status(identity: WebPushIdentity): Promise<WebPushStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        vapidPublicKey: null,
        renewalRequired: false,
        subscription: null,
      };
    }

    const subscription = await this.repository.findCurrentSession(identity);
    const renewalRequired = Boolean(
      subscription
      && (
        ['PROVIDER_STALE', 'VAPID_ROTATED'].includes(subscription.disabledReason ?? '')
        || (
          subscription.disabledAt === null
          && subscription.vapidPublicKeyFingerprint
            !== fingerprintVapidPublicKey(this.config.vapidPublicKey!)
        )
      )
    );
    return {
      enabled: true,
      vapidPublicKey: this.config.vapidPublicKey,
      renewalRequired,
      subscription: subscription?.disabledAt === null
        ? {
          id: subscription.id,
          createdAt: subscription.createdAt.toISOString(),
          fingerprint: subscription.subscriptionFingerprint,
        }
        : null,
    };
  }

  async create(identity: WebPushIdentity, input: CreateWebPushSubscription) {
    if (!this.config.enabled) {
      throw new AppError(
        'WEB_PUSH_DISABLED',
        409,
        'Cihaz bildirimleri şu anda etkin değil.',
      );
    }

    let subscription;
    try {
      subscription = await this.repository.upsert({
        ...identity,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        expirationTime: input.expirationTime === null
          ? null
          : new Date(input.expirationTime),
        vapidPublicKeyFingerprint: fingerprintVapidPublicKey(
          this.config.vapidPublicKey!,
        ),
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof WebPushOwnershipConflictError) {
        throw new AppError(
          'PUSH_SUBSCRIPTION_CONFLICT',
          409,
          'Bu cihaz bildirimi başka bir hesapla ilişkilendirilmiş.',
        );
      }
      throw error;
    }
    return {
      id: subscription.id,
      createdAt: subscription.createdAt.toISOString(),
      fingerprint: subscription.subscriptionFingerprint,
    };
  }
}
