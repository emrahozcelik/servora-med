import { describe, expect, it, vi } from 'vitest';

import {
  classifyUserStyleScroll,
  userStyleScroll,
} from '../scripts/follow-up-dialog-geometry-lib.mjs';

describe('classifyUserStyleScroll', () => {
  it('reports PASS only when a supported input moved content', () => {
    expect(classifyUserStyleScroll({ supported: true, moved: true })).toBe('PASS');
    expect(classifyUserStyleScroll({ supported: true, moved: 12 })).toBe('PASS');
  });

  it('reports FAIL when a supported input moved nothing', () => {
    expect(classifyUserStyleScroll({ supported: true, moved: false })).toBe('FAIL');
    expect(classifyUserStyleScroll({ supported: true, moved: 0 })).toBe('FAIL');
  });

  it('reports NOT_SUPPORTED instead of passing when input is unavailable', () => {
    expect(classifyUserStyleScroll({ supported: false, moved: false })).toBe('NOT_SUPPORTED');
    expect(classifyUserStyleScroll({ supported: false, moved: true })).toBe('NOT_SUPPORTED');
  });
});

function fakePage(behavior: { throwsOn?: 'move' | 'wheel'; tops: number[] }) {
  const tops = [...behavior.tops];
  return {
    mouse: {
      move: behavior.throwsOn === 'move' ? vi.fn(async () => { throw new Error('no mouse'); }) : vi.fn(async () => {}),
      wheel: behavior.throwsOn === 'wheel' ? vi.fn(async () => { throw new Error('no wheel'); }) : vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => tops.shift() ?? 0),
  };
}

const viewport = { width: 390, height: 844 };

describe('userStyleScroll', () => {
  it('passes on first-attempt movement', async () => {
    const page = fakePage({ tops: [120] });
    await expect(userStyleScroll(page, viewport)).resolves.toEqual({ result: 'PASS', wheelTop: 120 });
    expect(page.mouse.wheel).toHaveBeenCalledTimes(1);
  });

  it('passes when a bounded retry moves content', async () => {
    const page = fakePage({ tops: [0, 64] });
    await expect(userStyleScroll(page, viewport)).resolves.toEqual({ result: 'PASS', wheelTop: 64 });
    expect(page.mouse.wheel).toHaveBeenCalledTimes(2);
  });

  it('fails after bounded retries with zero movement', async () => {
    const page = fakePage({ tops: [0, 0, 0] });
    await expect(userStyleScroll(page, viewport)).resolves.toEqual({ result: 'FAIL', wheelTop: 0 });
    expect(page.mouse.wheel).toHaveBeenCalledTimes(2);
  });

  it('reports NOT_SUPPORTED when wheel input throws', async () => {
    const page = fakePage({ throwsOn: 'wheel', tops: [] });
    await expect(userStyleScroll(page, viewport)).resolves.toEqual({ result: 'NOT_SUPPORTED', wheelTop: 0 });
  });

  it('reports NOT_SUPPORTED when pointer move throws', async () => {
    const page = fakePage({ throwsOn: 'move', tops: [] });
    await expect(userStyleScroll(page, viewport)).resolves.toEqual({ result: 'NOT_SUPPORTED', wheelTop: 0 });
  });
});
