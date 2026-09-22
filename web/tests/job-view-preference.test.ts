import { describe, expect, it, vi } from 'vitest';

import {
  JOB_VIEW_PREFERENCE_KEY,
  readJobViewPreference,
  writeJobViewPreference,
} from '../src/jobs/job-view-preference';

describe('Jobs session view preference', () => {
  it('defaults safely to list and accepts only the board sentinel', () => {
    expect(readJobViewPreference(null)).toBe('list');
    expect(readJobViewPreference({ getItem: () => null })).toBe('list');
    expect(readJobViewPreference({ getItem: () => 'list' })).toBe('list');
    expect(readJobViewPreference({ getItem: () => 'unexpected' })).toBe('list');
    expect(readJobViewPreference({ getItem: () => 'board' })).toBe('board');
  });

  it('persists each explicit mode under the single session-scoped key', () => {
    const setItem = vi.fn();
    writeJobViewPreference('board', { setItem });
    writeJobViewPreference('list', { setItem });
    expect(setItem.mock.calls).toEqual([
      [JOB_VIEW_PREFERENCE_KEY, 'board'],
      [JOB_VIEW_PREFERENCE_KEY, 'list'],
    ]);
  });

  it('fails closed when session storage is unavailable', () => {
    expect(readJobViewPreference({ getItem: () => { throw new Error('denied'); } })).toBe('list');
    expect(() => writeJobViewPreference('board', {
      setItem: () => { throw new Error('denied'); },
    })).not.toThrow();
  });
});
