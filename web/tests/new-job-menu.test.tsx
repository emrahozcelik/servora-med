/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewJobMenu } from '../src/jobs/NewJobMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('NewJobMenu', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root && host) {
      act(() => { root!.unmount(); });
      host.remove();
    }
    root = null;
    host = null;
  });

  it('renders a single Yeni iş primary, not three top-level create primaries', () => {
    const html = renderToStaticMarkup(
      <NewJobMenu
        onCreateMeeting={() => {}}
        onCreateTask={() => {}}
        onCreateDelivery={() => {}}
      />,
    );
    expect(html).toContain('Yeni iş');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Yeni görüşme');
    expect(html).not.toContain('Yeni görev');
    expect(html).not.toContain('Yeni teslim');
  });

  it('lists create options after open and runs the chosen action', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onCreateMeeting = vi.fn();
    const onCreateTask = vi.fn();
    const onCreateDelivery = vi.fn();
    act(() => {
      root!.render(
        <NewJobMenu
          onCreateMeeting={onCreateMeeting}
          onCreateTask={onCreateTask}
          onCreateDelivery={onCreateDelivery}
        />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    act(() => { trigger.click(); });
    expect(host.textContent).toContain('Yeni görüşme');
    expect(host.textContent).toContain('Yeni görev');
    expect(host.textContent).toContain('Yeni teslim');
    const meeting = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Yeni görüşme');
    act(() => { meeting?.click(); });
    expect(onCreateMeeting).toHaveBeenCalledTimes(1);
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(onCreateDelivery).not.toHaveBeenCalled();
  });

  it('closes on Escape without trapping focus on desktop disclosure', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu onCreateMeeting={() => {}} onCreateTask={() => {}} onCreateDelivery={() => {}} />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(host.querySelector('[role="menu"], [role="dialog"]')).toBeTruthy();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[role="menu"], [role="dialog"]')).toBeNull();
  });
});
