import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's').exec(stylesCss);
  if (!match) throw new Error(`Missing rule for ${selector}`);
  return match[1] ?? '';
}

describe('calendar month-cell density (visual review, C1 follow-up)', () => {
  it('keeps the day number compact while enforcing the 44px --control-height floor on event chips', () => {
    // `button { min-height: var(--control-height) }` must not stretch the C1
    // day-number button into a pill, while month-cell event chips keep the
    // owner-approved 44px target floor; the compact mobile calendar uses native cells.
    expect(block('.servora-calendar-date')).toMatch(/min-height:\s*0;/);
    expect(block('.servora-calendar-event-summary')).toMatch(/min-height:\s*var\(--control-height\);/);
  });

  it('removes box chrome from chips inside a cell', () => {
    expect(block('.servora-calendar-event-summary')).toMatch(/border:\s*0;/);
    expect(block('.servora-calendar-event-summary--job')).not.toMatch(/border/);
    expect(block('.servora-calendar-event-summary--manual')).not.toMatch(/border/);
  });

  it('lays chips out as a meta line plus a two-line clamped title', () => {
    expect(block('.servora-calendar-event-summary')).toMatch(/white-space:\s*normal;/);
    expect(block('.servora-calendar-event-meta')).toMatch(/display:\s*flex;/);
    expect(block('.servora-calendar-event-time')).toMatch(/flex:\s*0\s+0\s+auto;/);
    expect(block('.servora-calendar-event-label')).toMatch(/-webkit-line-clamp:\s*2;/);
    expect(block('.servora-calendar-event-label')).toMatch(/overflow:\s*hidden;/);
  });

  it('keeps the visible source cue beside the time', () => {
    expect(block('.servora-calendar-event-kind')).toMatch(/text-overflow:\s*ellipsis;/);
    expect(stylesCss).not.toMatch(/servora-calendar-event-summary[^{]*\{[^}]*-webkit-line-clamp:\s*0/s);
  });

  it('reserves room for the larger compact count badge', () => {
    const compact = stylesCss.slice(stylesCss.indexOf('.servora-calendar--compact .servora-calendar-count'));
    expect(compact).toMatch(/font-size:\s*0\.75rem;/);
    expect(compact).toMatch(/height:\s*1\.3rem;/);
    expect(stylesCss).toMatch(/padding-inline:\s*0\.2rem\s+1\.5rem;/);
  });
});
