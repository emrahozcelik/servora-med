import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messagingCss = readFileSync(resolve(__dirname, '../src/messaging/messaging.css'), 'utf8');
const stylesCss = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('messaging desktop workspace layout contract (M1)', () => {
  it('uses the full mobile canvas instead of inheriting the generic document gutters', () => {
    const baseBlock = messagingCss.slice(0, messagingCss.indexOf('.messaging-container'));
    expect(baseBlock).toMatch(/\.messaging-workspace\s*\{[^}]*width:\s*100%/s);
    expect(baseBlock).toMatch(/\.messaging-workspace\s*\{[^}]*max-width:\s*none/s);
    expect(baseBlock).toMatch(/\.messaging-workspace\s*\{[^}]*margin:\s*0/s);
  });

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

  it('gives the sidebar header explicit heading and control regions', () => {
    expect(messagingCss).toMatch(/\.messaging-sidebar-header\s*\{[^}]*display:\s*flex/s);
    expect(messagingCss).toMatch(/\.messaging-sidebar-heading-row\s*\{[^}]*display:\s*flex/s);
    expect(messagingCss).toMatch(/\.messaging-sidebar-heading\s*\{[^}]*min-width:\s*0/s);
    expect(messagingCss).toMatch(/\.messaging-sidebar-heading\s*\{[^}]*text-overflow:\s*clip/s);
  });

  it('reserves a fixed action rail and bounded activity column for every conversation row', () => {
    expect(messagingCss).toContain('--conversation-action-width');
    expect(messagingCss).toMatch(/\.conversation-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--conversation-action-width\)/s);
    expect(messagingCss).toMatch(/\.conversation-item\s*\{[^}]*min-width:\s*0/s);
    expect(messagingCss).toMatch(/\.conversation-item\s*\{[^}]*grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s+4\.5rem/s);
    expect(messagingCss).toMatch(/\.conversation-activity\s*\{[^}]*width:\s*4\.5rem/s);
    expect(messagingCss).toMatch(/\.conversation-actions\s*\{[^}]*flex:\s*0\s+0\s+var\(--conversation-action-width\)/s);
  });

  it('keeps the thread as the flexible application surface with min-width zero', () => {
    expect(messagingCss).toMatch(/\.messaging-thread\s*\{[^}]*flex:\s*1/s);
    expect(messagingCss).toMatch(/\.messaging-thread\s*\{[^}]*min-width:\s*0/s);
  });

  it('gives compose mode a centered, responsive workspace instead of the narrow conversation rail', () => {
    expect(messagingCss).toMatch(/\.messaging-container\.composing\s*\{[^}]*justify-content:\s*center/s);
    expect(messagingCss).toMatch(/\.messaging-container\.composing\s+\.messaging-sidebar\s*\{[^}]*width:\s*min\(100%,\s*48rem\)/s);
    expect(messagingCss).toMatch(/\.messaging-container\.composing\s+\.create-panel\s*\{[^}]*max-height:\s*none/s);
  });

  it('removes the conversation-list header from the visible compose workspace', () => {
    expect(messagingCss).toMatch(/\.messaging-container\.composing\s+\.messaging-sidebar-header\s*\{[^}]*display:\s*none/s);
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
