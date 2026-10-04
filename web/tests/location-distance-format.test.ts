/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { formatLocationDistance, submitComparisonWarning } from '../src/jobs/location-distance-format';

describe('formatLocationDistance', () => {
  it('renders sub-kilometre distances in metres', () => {
    expect(formatLocationDistance(0)).toBe('0 metre');
    expect(formatLocationDistance(18)).toBe('18 metre');
    expect(formatLocationDistance(299.9)).toBe('300 metre');
  });

  it('renders kilometre distances with one tr-TR decimal', () => {
    expect(formatLocationDistance(1000)).toBe('1 km');
    expect(formatLocationDistance(1240.5).replace(/[\s\u00a0\u202f]+/gu, ' '))
      .toBe('1,2 km');
  });

  it('degrades non-finite input to a dash', () => {
    expect(formatLocationDistance(Number.NaN)).toBe('—');
    expect(formatLocationDistance(-5)).toBe('—');
  });
});

describe('submitComparisonWarning', () => {
  it('states the approximate gap, the history record, and manager visibility', () => {
    const warning = submitComparisonWarning(1240.5).replace(/[\s\u00a0\u202f]+/gu, ' ');
    expect(warning).toContain('Başlangıç konumu ile onaya gönderme konumu arasında yaklaşık 1,2 km fark');
    expect(warning).toContain('iş geçmişine kaydedildi');
    expect(warning).toContain('yönetici tarafından görülebilir');
    expect(warning).not.toMatch(/sahte|hile|yanılt|kesinlikle|tam olarak/i);
  });
});
