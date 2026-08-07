import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messagingCss = readFileSync(resolve(__dirname, '../src/messaging/messaging.css'), 'utf8');
const stylesCss = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('messaging desktop workspace layout contract (M1)', () => {
  it('keeps the generic document column cap intact for other pages', () => {
    expect(stylesCss).toMatch(/\.workspace\s*\{[^}]*width:\s*min\(100%\s*-\s*2rem,\s*68rem\)/s);
  });

  it('escapes the document cap only for the messaging workspace on desktop', () => {
    const block = messagingCss.slice(messagingCss.indexOf('@media (min-width: 64rem)'));
    expect(block).toMatch(/\.messaging-workspace\s*\{[^}]*width:\s*100%/s);
    expect(block).toMatch(/\.messaging-workspace\s*\{[^}]*max-width:\s*none/s);
    expect(block).toMatch(/\.messaging-workspace\s*\{[^}]*margin:\s*0/s);
    expect(block).toMatch(/\.messaging-workspace\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*4\.75rem\)/s);
  });

  it('gives the conversation list an intentional desktop width between 320 and 360px', () => {
    expect(messagingCss).toMatch(/\.messaging-sidebar\s*\{[^}]*width:\s*clamp\(320px,[^}]*360px\)/s);
  });

  it('keeps the thread as the flexible application surface with min-width zero', () => {
    expect(messagingCss).toMatch(/\.messaging-thread\s*\{[^}]*flex:\s*1/s);
    expect(messagingCss).toMatch(/\.messaging-thread\s*\{[^}]*min-width:\s*0/s);
  });

  it('caps message bubbles to a readable internal width on wide threads', () => {
    expect(messagingCss).toMatch(/\.message-bubble\s*\{[^}]*max-width:\s*min\(70%,\s*46rem\)/s);
  });

  it('preserves the narrow-screen overlay behavior below 768px', () => {
    const block = messagingCss.slice(messagingCss.indexOf('@media (max-width: 768px)'));
    expect(block).toMatch(/\.messaging-sidebar\s*\{[^}]*width:\s*100%/s);
    expect(block).toMatch(/\.messaging-thread\s*\{[^}]*display:\s*none/s);
  });
});
