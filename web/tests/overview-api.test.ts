import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/services/api';
import { parseOverviewResponse } from '../src/services/overview-api';

const common = {
  range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
  generatedAt: '2026-07-26T08:00:00.000Z',
  recentCompletedWork: [],
  recentNotes: [],
};

describe('overview API parser', () => {
  it('parses the Staff discriminator without accepting management fields as authority', () => {
    const parsed = parseOverviewResponse({
      ...common, scope: 'staff', openJobCards: 2, waitingApproval: 1,
      revisionRequested: 0, completedInPeriod: 4, active: 999,
    });
    expect(parsed).toEqual({
      ...common, scope: 'staff', openJobCards: 2, waitingApproval: 1,
      revisionRequested: 0, completedInPeriod: 4,
    });
    expect('active' in parsed).toBe(false);
  });

  it('rejects an unknown discriminator and malformed required fields', () => {
    expect(() => parseOverviewResponse({ ...common, scope: 'other' }))
      .toThrow(ApiError);
    expect(() => parseOverviewResponse({
      ...common, scope: 'staff', openJobCards: '2', waitingApproval: 1,
      revisionRequested: 0, completedInPeriod: 4,
    })).toThrow(ApiError);
  });
});
