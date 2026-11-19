import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messagingCss = readFileSync(resolve(__dirname, '../src/messaging/messaging.css'), 'utf8');

describe('messaging sender label contract (S4/S5)', () => {
  it('defines a readable sender label with clear hierarchy below the body size', () => {
    const block = messagingCss.slice(messagingCss.indexOf('.message-sender'));
    expect(block).toMatch(/\.message-sender\s*\{[^}]*font-size:\s*0\.7[0-9]rem/s);
    expect(block).toMatch(/\.message-sender\s*\{[^}]*font-weight:\s*600/s);
    expect(block).toMatch(/\.message-sender\s*\{[^}]*display:\s*block/s);
  });

  it('keeps bubble wrapping and width contract intact so labels cannot cause horizontal overflow', () => {
    expect(messagingCss).toMatch(/\.message-bubble\s*\{[^}]*max-width:\s*min\(70%,\s*46rem\)/s);
    expect(messagingCss).toMatch(/\.message-bubble\s*\{[^}]*word-wrap:\s*break-word/s);
    expect(messagingCss).toMatch(/\.message-sender\s*\{[^}]*overflow-wrap:\s*break-word/s);
  });

  it('keeps the body/time hierarchy below the body size at the 12px floor', () => {
    expect(messagingCss).toMatch(/\.message-body\s*\{[^}]*font-size:\s*0\.95rem/s);
    expect(messagingCss).toMatch(/\.message-time\s*\{[^}]*font-size:\s*0\.75rem/s);
  });

  it('never declares type below the 12px floor (UI audit F-11)', () => {
    const sizes = [...messagingCss.matchAll(/font-size:\s*([\d.]+)rem/g)]
      .map((match) => Number.parseFloat(match[1]!));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.75);
  });
});
