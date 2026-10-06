import { describe, expect, it } from 'vitest';

import {
  classifyDevice,
  startLocationUnavailableAdvisory,
  submitLocationUnavailableGuidance,
} from '../src/jobs/location-guidance';

describe('classifyDevice', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 'iPhone', 5],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 'iPad', 5],
    ['iPod', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', 'iPod', 5],
  ] as const)('classifies %s as IOS', (_name, userAgent, platform, maxTouchPoints) => {
    expect(classifyDevice({ userAgent, platform, maxTouchPoints })).toBe('IOS');
  });

  it('classifies an iPadOS desktop-class Mac user agent as IOS via touch points', () => {
    expect(classifyDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe('IOS');
  });

  it('classifies a touchless Mac as MACOS', () => {
    expect(classifyDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    })).toBe('MACOS');
  });

  it('classifies Android as ANDROID', () => {
    expect(classifyDevice({
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
    })).toBe('ANDROID');
  });

  it('classifies Windows as WINDOWS via user agent or platform fallback', () => {
    expect(classifyDevice({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      platform: 'Win32',
      maxTouchPoints: 0,
    })).toBe('WINDOWS');
    expect(classifyDevice({ platform: 'Win32' })).toBe('WINDOWS');
  });

  it('falls back to GENERIC for unknown or missing signals', () => {
    expect(classifyDevice({})).toBe('GENERIC');
    expect(classifyDevice({ userAgent: 'SomeEmbeddedBrowser/1.0', platform: 'unknown' }))
      .toBe('GENERIC');
  });
});

describe('submitLocationUnavailableGuidance', () => {
  it('keeps the successful-submit core message and appends platform guidance', () => {
    const message = submitLocationUnavailableGuidance({ reason: 'PERMISSION_DENIED', device: 'IOS' });
    expect(message).toContain('İş yönetici onayına gönderildi ancak konum alınamadı');
    expect(message).toContain('Konum kaydı saha doğrulaması için önemlidir');
    expect(message).toContain('Tarayıcıda bu site için konum iznini etkinleştirin');
    expect(message).toContain('iPhone/iPad: Ayarlar > Gizlilik ve Güvenlik');
  });

  it.each([
    ['ANDROID', 'Android: Ayarlar > Konum bölümünden konumu açın'],
    ['MACOS', 'macOS: Sistem Ayarları > Gizlilik ve Güvenlik'],
    ['WINDOWS', 'Windows: Ayarlar > Gizlilik ve güvenlik > Konum'],
    ['GENERIC', 'Cihazınızın konum servislerini açın ve bu site için tarayıcı konum iznini'],
  ] as const)('appends %s platform guidance', (device, expected) => {
    expect(submitLocationUnavailableGuidance({ reason: 'UNKNOWN', device })).toContain(expected);
  });

  it.each([
    ['POSITION_UNAVAILABLE', 'Cihazınızın konum (GPS) hizmetinin açık ve kullanılabilir olduğundan'],
    ['TIMEOUT', 'Konum servislerini açık tutun ve daha net bir konum sinyaliyle yeniden deneyin'],
    ['UNSUPPORTED', 'Konum özelliğini destekleyen güncel bir tarayıcı veya cihaz kullanın'],
  ] as const)('emphasizes the reason guidance for %s', (reason, expected) => {
    expect(submitLocationUnavailableGuidance({ reason, device: 'GENERIC' })).toContain(expected);
  });

  it('omits reason emphasis when the reason is unknown or missing', () => {
    const unknown = submitLocationUnavailableGuidance({ reason: 'UNKNOWN', device: 'GENERIC' });
    const missing = submitLocationUnavailableGuidance({ device: 'GENERIC' });
    expect(unknown).not.toContain('Tarayıcıda bu site için konum iznini');
    expect(unknown).not.toContain('(GPS)');
    expect(missing).toEqual(unknown);
  });
});

describe('startLocationUnavailableAdvisory', () => {
  it('states the start succeeded and location will be retried at approval', () => {
    const message = startLocationUnavailableAdvisory();
    expect(message).toContain('İş başlatıldı ancak konum alınamadı');
    expect(message).toContain('Yönetici onayına gönderirken konum yeniden denenecek');
    expect(message).toContain('Konum servislerini açık tutmanız önemlidir');
  });
});
