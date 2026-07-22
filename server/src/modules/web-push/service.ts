import type { WebPushConfig } from '../../config.js';
import {
  fingerprintVapidPublicKey,
  type WebPushIdentity,
  type WebPushRepository,
} from './repository.js';

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
}
