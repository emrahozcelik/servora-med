/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResultState, ServoraAntProvider } from '../src/ui/antd';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('403 and 404 result states', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function mount(status: '403' | '404', title: string) {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <main className="workspace">
            <ResultState status={status} title={title} headingLevel={1}
              description="Açıklama" action={<a href="/jobs">İşlere dön</a>} />
          </main>
        </ServoraAntProvider>,
      );
    });
  }

  it.each([
    ['403', 'Erişim yetkiniz yok'],
    ['404', 'Sayfa bulunamadı'],
  ] as const)('renders one Turkish h1 and hides the %s artwork from assistive technology', async (status, title) => {
    await mount(status, title);
    const headings = Array.from(host.querySelectorAll('h1')).map((heading) => heading.textContent);
    expect(headings).toEqual([title]);
    const icon = host.querySelector('.servora-result-state__icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // Every nested label-bearing node is inside the hidden artwork slot.
    for (const labelled of Array.from(icon!.querySelectorAll('[aria-label], title'))) {
      expect(labelled.closest('[aria-hidden="true"]')).toBe(icon);
    }
    expect(host.querySelector('[data-servora-result-state]')?.getAttribute('role')).toBe('alert');
  });
});
