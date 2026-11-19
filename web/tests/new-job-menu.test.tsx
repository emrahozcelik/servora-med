/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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
    expect(html).toContain('aria-controls=');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('Görüşme / ziyaret planla');
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
    expect(host.textContent).toContain('Görüşme / ziyaret planla');
    expect(host.textContent).toContain('Yeni görev');
    expect(host.textContent).toContain('Yeni teslim');
    const meeting = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Görüşme / ziyaret planla');
    act(() => { meeting?.click(); });
    expect(onCreateMeeting).toHaveBeenCalledTimes(1);
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(onCreateDelivery).not.toHaveBeenCalled();
  });

  it('closes on Escape for desktop disclosure without menu role', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu
          presentation="popover"
          onCreateMeeting={() => {}}
          onCreateTask={() => {}}
          onCreateDelivery={() => {}}
        />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(host.querySelector('.new-job-menu-panel')).toBeTruthy();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('.new-job-menu-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside pointerdown without restoring focus to the trigger', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu presentation="popover" onCreateMeeting={() => {}} />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(host.querySelector('.new-job-menu-panel')).toBeTruthy();

    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Dış kontrol';
    document.body.appendChild(outside);
    outside.focus();

    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(host.querySelector('.new-job-menu-panel')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps the menu open for pointerdown inside the panel', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu presentation="popover" onCreateMeeting={() => {}} />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    const panel = host.querySelector('.new-job-menu-panel') as HTMLElement;

    act(() => {
      panel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(host.querySelector('.new-job-menu-panel')).toBe(panel);
  });

  it('closes when the same trigger is activated again', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu presentation="popover" onCreateMeeting={() => {}} />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(host.querySelector('.new-job-menu-panel')).toBeTruthy();

    act(() => { trigger.click(); });

    expect(host.querySelector('.new-job-menu-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens from keyboard activation', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu presentation="popover" onCreateMeeting={() => {}} />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;

    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(host.querySelector('.new-job-menu-panel')).toBeTruthy();
  });

  it('uses sheet presentation with dialog role and body scroll lock for the mobile create', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu
          presentation="sheet"
          onCreateMeeting={() => {}}
          onCreateTask={() => {}}
          onCreateDelivery={() => {}}
        />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('portals the sheet and its backdrop to the document body', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<NewJobMenu presentation="sheet" onCreateMeeting={() => {}} />);
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    const panel = document.querySelector('.new-job-menu-panel--sheet')!;
    const backdrop = document.querySelector('.new-job-menu-backdrop')!;
    expect(panel.parentElement).toBe(document.body);
    expect(backdrop.parentElement).toBe(document.body);
    expect(host.contains(panel)).toBe(false);
  });

  it('wraps Tab and Shift+Tab inside the sheet', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <NewJobMenu
          presentation="sheet"
          onCreateMeeting={() => {}}
          onCreateTask={() => {}}
          onCreateDelivery={() => {}}
        />,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    const panel = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;
    const focusables = Array.from(panel.querySelectorAll<HTMLButtonElement>('button'));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(first.textContent).toBe('Görüşme / ziyaret planla');
    expect(last.textContent).toBe('Vazgeç');
    expect(document.activeElement).toBe(first);

    last.focus();
    act(() => { panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
    expect(document.activeElement).toBe(first);

    first.focus();
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('contains focus inside the sheet for non-Tab focus moves', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<NewJobMenu presentation="sheet" onCreateMeeting={() => {}} />);
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    const panel = document.querySelector<HTMLElement>('.new-job-menu-panel--sheet')!;

    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    outside.focus();

    expect(panel.contains(document.activeElement)).toBe(true);
    outside.remove();
  });

  it.each([
    ['backdrop', () => document.querySelector<HTMLButtonElement>('.new-job-menu-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))],
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['Vazgeç', () => Array.from(document.querySelectorAll<HTMLButtonElement>('.new-job-menu-panel--sheet button'))
      .find((button) => button.textContent === 'Vazgeç')!.click()],
  ] as const)('closes the sheet via %s and restores focus to the trigger', (_label, close) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<NewJobMenu presentation="sheet" onCreateMeeting={() => {}} />);
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(document.querySelector('.new-job-menu-panel--sheet')).not.toBeNull();

    act(() => { close(); });

    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the desktop disclosure free of focus trapping', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<NewJobMenu presentation="popover" onCreateMeeting={() => {}} />);
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    const panel = host.querySelector<HTMLElement>('.new-job-menu-panel')!;
    expect(panel.getAttribute('role')).toBeNull();
    expect(panel.getAttribute('aria-modal')).toBeNull();

    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    outside.focus();

    expect(document.activeElement).toBe(outside);
    expect(host.querySelector('.new-job-menu-panel')).toBe(panel);
    outside.remove();
  });

  it('closes the open sheet when the router location changes', () => {
    function NavButton() {
      const navigate = useNavigate();
      return <button type="button" data-nav onClick={() => navigate('/customers')}>Git</button>;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <MemoryRouter initialEntries={['/jobs']}>
          <NavButton />
          <NewJobMenu presentation="sheet" onCreateMeeting={() => {}} />
        </MemoryRouter>,
      );
    });
    const trigger = host.querySelector('button.new-job-menu-trigger') as HTMLButtonElement;
    act(() => { trigger.click(); });
    expect(document.querySelector('.new-job-menu-panel--sheet')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    act(() => { host!.querySelector<HTMLButtonElement>('[data-nav]')!.click(); });

    expect(document.querySelector('.new-job-menu-panel--sheet')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).not.toBe(trigger);
  });
});
