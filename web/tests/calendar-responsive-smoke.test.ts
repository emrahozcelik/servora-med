import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { calendarScreenshotPath } from '../scripts/calendar-responsive-screenshot-path.mjs';

describe('Calendar responsive smoke harness', () => {
  it('writes screenshots under the host OS temporary directory', () => {
    const screenshotPath = calendarScreenshotPath('390x844');
    const smokeSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/calendar-responsive-smoke.mjs'),
      'utf8',
    );

    expect(dirname(screenshotPath)).toBe(tmpdir());
    expect(basename(screenshotPath)).toBe('servora-calendar-390x844.png');
    expect(smokeSource).toContain('path: calendarScreenshotPath(viewport.name)');
    expect(smokeSource).not.toContain('/private/tmp/');
  });
});
