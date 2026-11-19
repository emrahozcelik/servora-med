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

  it('gives the conversation list an intentional desktop width between 340 and 380px', () => {
    expect(messagingCss).toMatch(/\.messaging-sidebar\s*\{[^}]*width:\s*clamp\(340px,[^}]*380px\)/s);
  });

  it('gives the sidebar header an explicit control region without a duplicate title', () => {
    expect(messagingCss).toMatch(/\.messaging-sidebar-header\s*\{[^}]*display:\s*flex/s);
    expect(messagingCss).toMatch(/\.messaging-sidebar-heading-row\s*\{[^}]*display:\s*flex/s);
    expect(messagingCss).toMatch(/\.messaging-sidebar-heading-row\s*\{[^}]*justify-content:\s*flex-end/s);
  });

  it('reserves a fixed action rail and a content-sized activity column for every conversation row', () => {
    expect(messagingCss).toContain('--conversation-action-width');
    expect(messagingCss).toMatch(/\.conversation-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--conversation-action-width\)/s);
    expect(messagingCss).toMatch(/\.conversation-item\s*\{[^}]*min-width:\s*0/s);
    expect(messagingCss).toMatch(/\.conversation-item\s*\{[^}]*grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s+auto/s);
    expect(messagingCss).toMatch(/\.conversation-activity\s*\{[^}]*width:\s*auto/s);
    expect(messagingCss).toMatch(/\.conversation-activity\s*\{[^}]*min-width:\s*3\.25rem/s);
    expect(messagingCss).toMatch(/\.conversation-actions\s*\{[^}]*flex:\s*0\s+0\s+var\(--conversation-action-width\)/s);
  });

  it('ellipsizes conversation names while keeping the participant count intact (visual review)', () => {
    expect(messagingCss).toMatch(/\.conversation-name-text\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis/s);
    expect(messagingCss).toMatch(/\.conversation-participants-count\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
    expect(messagingCss).toMatch(/\.conversation-participants-name\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(messagingCss).toMatch(/\.disabled-badge\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  });

  it('draws the selected conversation ring on the whole row, not only the item', () => {
    expect(messagingCss).toMatch(/\.conversation-row:has\(\.conversation-item\.selected\)\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s);
    const itemBlock = messagingCss.slice(
      messagingCss.indexOf('.conversation-item.selected'),
      messagingCss.indexOf('.conversation-item.selected') + 200,
    );
    expect(itemBlock).not.toMatch(/box-shadow/);
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

  it('uses the shared workspace gutter instead of sitting flush to the shell edge (F-08)', () => {
    const baseBlock = messagingCss.slice(0, messagingCss.indexOf('.messaging-container'));
    expect(baseBlock).toMatch(/\.messaging-workspace\s*\{[^}]*padding:\s*0\s+1rem/s);
    const desktopBlock = messagingCss.slice(messagingCss.indexOf('@media (min-width: 64rem)'));
    expect(desktopBlock).toMatch(
      /\.messaging-workspace\s*\{[^}]*padding-inline:\s*clamp\(1rem,\s*3vw,\s*2\.5rem\)/s,
    );
  });

  it('fits the mobile workspace above the fixed bottom navigation (F-08)', () => {
    expect(messagingCss).toMatch(
      /\.authenticated-shell--mobile \.messaging-workspace\s*\{[^}]*height:\s*calc\([^}]*3\.75rem[^}]*safe-area-inset-bottom/s,
    );
    expect(messagingCss).toMatch(
      /\.authenticated-shell--mobile \.shell-content:has\(> \.messaging-workspace\)\s*\{[^}]*padding-bottom:\s*0/s,
    );
  });

  it('keeps the Aktif/Arşiv selector at the 44px control target (F-08)', () => {
    expect(messagingCss).toMatch(
      /\.conversation-view-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    );
    expect(messagingCss).not.toMatch(/min-height:\s*36px/);
  });
});
