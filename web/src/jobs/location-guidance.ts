import type { ActionLocationCapture } from './start-location-capture';

/**
 * #347 presentation-only device classification. Pure and deterministic: it
 * only reads browser values the caller passes in, never persists anything,
 * never sends device data to the server, and performs no fingerprinting.
 */
export type DeviceCategory = 'IOS' | 'ANDROID' | 'MACOS' | 'WINDOWS' | 'GENERIC';

export type DeviceSignals = Readonly<{
  userAgent?: string | null;
  platform?: string | null;
  maxTouchPoints?: number | null;
}>;

export type LocationUnavailableReason =
  Extract<ActionLocationCapture, { outcome: 'unavailable' }>['reason'];

export function readDeviceSignals(): DeviceSignals {
  if (typeof navigator === 'undefined') return {};
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

export function classifyDevice(signals: DeviceSignals): DeviceCategory {
  const userAgent = (signals.userAgent ?? '').toLowerCase();
  const platform = (signals.platform ?? '').toLowerCase();
  const touchCapable = typeof signals.maxTouchPoints === 'number' && signals.maxTouchPoints > 1;

  if (userAgent.includes('iphone') || userAgent.includes('ipod') || userAgent.includes('ipad')) {
    return 'IOS';
  }
  // iPadOS 13+ may present a desktop-class "Macintosh" user agent; a
  // touch-capable Mac-like platform is the reliable iPad signal.
  if (userAgent.includes('macintosh') || userAgent.includes('mac os x')
    || platform === 'macintel' || platform === 'macppc') {
    return touchCapable ? 'IOS' : 'MACOS';
  }
  if (userAgent.includes('android')) return 'ANDROID';
  if (userAgent.includes('windows') || platform.startsWith('win')) return 'WINDOWS';
  return 'GENERIC';
}

/** Fixed advisory after a successful START whose local capture was unavailable. */
export function startLocationUnavailableAdvisory(): string {
  return 'İş başlatıldı ancak konum alınamadı. Yönetici onayına gönderirken konum '
    + 'yeniden denenecek. Konum servislerini açık tutmanız önemlidir.';
}

const REASON_GUIDANCE: Record<LocationUnavailableReason, string> = {
  PERMISSION_DENIED: 'Tarayıcıda bu site için konum iznini etkinleştirin.',
  POSITION_UNAVAILABLE:
    'Cihazınızın konum (GPS) hizmetinin açık ve kullanılabilir olduğundan emin olun.',
  TIMEOUT: 'Konum servislerini açık tutun ve daha net bir konum sinyaliyle yeniden deneyin.',
  UNSUPPORTED: 'Konum özelliğini destekleyen güncel bir tarayıcı veya cihaz kullanın.',
  UNKNOWN: '',
};

const PLATFORM_GUIDANCE: Record<DeviceCategory, string> = {
  IOS: 'iPhone/iPad: Ayarlar > Gizlilik ve Güvenlik > Konum Servisleri bölümünden konumu '
    + 'açın ve kullandığınız tarayıcı için konum iznini etkinleştirin.',
  ANDROID: 'Android: Ayarlar > Konum bölümünden konumu açın. Ardından Ayarlar > Uygulamalar > '
    + 'kullandığınız tarayıcı > İzinler > Konum bölümünden izin verin.',
  MACOS: 'macOS: Sistem Ayarları > Gizlilik ve Güvenlik > Konum Servisleri bölümünden konumu '
    + 'açın ve tarayıcınıza izin verin.',
  WINDOWS: 'Windows: Ayarlar > Gizlilik ve güvenlik > Konum bölümünden konum hizmetlerini '
    + 'açın ve tarayıcı erişimine izin verin.',
  GENERIC: 'Cihazınızın konum servislerini açın ve bu site için tarayıcı konum iznini '
    + 'etkinleştirin.',
};

/**
 * Advisory for a successful SUBMIT whose local capture was unavailable. The
 * submission already succeeded: this is guidance, never an error. The
 * reason-specific and platform-specific sentences stay resilient to small
 * menu renames and never claim the browser can open OS settings itself.
 */
export function submitLocationUnavailableGuidance(input: {
  reason?: LocationUnavailableReason | null;
  device: DeviceCategory;
}): string {
  const reasonLine = input.reason ? REASON_GUIDANCE[input.reason] : '';
  return [
    'İş yönetici onayına gönderildi ancak konum alınamadı. '
      + 'Konum kaydı saha doğrulaması için önemlidir.',
    reasonLine,
    PLATFORM_GUIDANCE[input.device],
  ].filter((part) => part.length > 0).join(' ');
}
