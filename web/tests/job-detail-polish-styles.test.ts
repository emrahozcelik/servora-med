import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

function ruleFor(selector: string): string {
  const pattern = new RegExp(`^${selector.replace(/\./g, '\\.')} \\{`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`CSS rule not found: ${selector}`);
  const end = css.indexOf('}', match.index);
  return css.slice(match.index, end + 1);
}

describe('job detail desktop polish — styles source contract', () => {
  it('stacks the actions helper above the buttons on desktop (no horizontal competition)', () => {
    const action = ruleFor('.detail-action');
    expect(action).toContain('flex-direction: column');
    expect(action).toContain('align-items: stretch');
    expect(action).not.toContain('justify-content: space-between');
  });

  it('keeps the actions helper full-width without narrow-column wrapping', () => {
    const helper = ruleFor('.detail-action-consequence');
    expect(helper).toContain('width: 100%');
    expect(helper).toContain('max-width: none');
    expect(helper).toContain('overflow-wrap: normal');
  });

  it('gives the schedule form action row clear spacing from the field', () => {
    const scheduleActions = ruleFor('.job-schedule-edit .review-buttons');
    expect(scheduleActions).toMatch(/margin-top:\s*1rem/);
  });

  it('scopes the job detail workflow action group to left alignment', () => {
    const scoped = ruleFor('.job-detail-workflow-main .review-buttons');
    expect(scoped).toContain('justify-content: flex-start');
    const global = ruleFor('.review-buttons');
    expect(global).toContain('justify-content: flex-end');
  });
});
