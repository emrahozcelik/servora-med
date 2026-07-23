/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX,
  RecordDescriptions,
  ServoraAntProvider,
} from '../src/ui/antd';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ObserverEntry = { contentRect: { width: number } };
type ObserverCallback = (entries: ObserverEntry[]) => void;

let observerInstances: Array<{
  callback: ObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (width: number) => void;
}>;

function installResizeObserverMock() {
  observerInstances = [];
  class MockResizeObserver {
    callback: ObserverCallback;
    observe = vi.fn((_element: Element) => {});
    unobserve = vi.fn();
    disconnect = vi.fn();

    constructor(callback: ObserverCallback) {
      this.callback = callback;
      const instance = {
        callback,
        observe: this.observe,
        disconnect: this.disconnect,
        trigger: (width: number) => {
          callback([{ contentRect: { width } }]);
        },
      };
      observerInstances.push(instance);
      // Bind disconnect tracking
      this.disconnect = instance.disconnect;
      this.observe = instance.observe;
    }
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
}

const sampleItems = [
  { key: 'status', label: 'Durum', content: 'Atandı' },
  { key: 'assignee', label: 'Sorumlu personel', content: 'Sezer Dener' },
  {
    key: 'description',
    label: 'Açıklama',
    content: <span data-testid="desc-node">Uzun açıklama içeriği</span>,
    wide: true,
  },
] as const;

describe('RecordDescriptions container-responsive columns', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installResizeObserverMock();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderAtWidth(width: number | null) {
    if (width !== null) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width,
        height: 100,
        top: 0,
        left: 0,
        bottom: 100,
        right: width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <RecordDescriptions ariaLabel="İş kayıt bilgileri" items={sampleItems} />
        </ServoraAntProvider>,
      );
    });
  }

  function hostEl() {
    return host.querySelector('.servora-record-descriptions-host');
  }

  function columnCount() {
    return hostEl()?.getAttribute('data-column-count');
  }

  it('R1: safe initial render uses one column when measurement has not forced two', async () => {
    // No getBoundingClientRect override → width 0 from jsdom → stays 1
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <RecordDescriptions ariaLabel="İş kayıt bilgileri" items={sampleItems} />
        </ServoraAntProvider>,
      );
    });

    expect(columnCount()).toBe('1');
    expect(host.textContent).toContain('Durum');
    expect(host.textContent).toContain('Atandı');
  });

  it('R2: narrow container (520) stays single column; wide item does not force span layout mode', async () => {
    await renderAtWidth(520);
    expect(columnCount()).toBe('1');
    expect(host.textContent).toContain('Açıklama');
    expect(host.textContent).toContain('Uzun açıklama içeriği');
  });

  it('R3: sufficient container (720) uses two columns', async () => {
    await renderAtWidth(720);
    expect(columnCount()).toBe('2');
    expect(RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX).toBe(640);
  });

  it('R4: resize wide → narrow collapses to one column', async () => {
    await renderAtWidth(720);
    expect(columnCount()).toBe('2');
    expect(observerInstances.length).toBeGreaterThan(0);

    await act(async () => {
      observerInstances[0]!.trigger(520);
    });

    expect(columnCount()).toBe('1');
  });

  it('R5: resize narrow → wide expands to two columns', async () => {
    await renderAtWidth(520);
    expect(columnCount()).toBe('1');

    await act(async () => {
      observerInstances[0]!.trigger(720);
    });

    expect(columnCount()).toBe('2');
  });

  it('R6: disconnects ResizeObserver on unmount exactly once; late callbacks do not throw', async () => {
    await renderAtWidth(720);
    const instance = observerInstances[0]!;
    expect(instance.observe).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    // remount root for afterEach safety
    root = createRoot(host);

    expect(instance.disconnect).toHaveBeenCalledTimes(1);

    expect(() => {
      instance.trigger(400);
    }).not.toThrow();
  });

  it('R7: ResizeObserver unavailable falls back to one column without throwing', async () => {
    vi.stubGlobal('ResizeObserver', undefined);

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <RecordDescriptions ariaLabel="İş kayıt bilgileri" items={sampleItems} />
        </ServoraAntProvider>,
      );
    });

    expect(columnCount()).toBe('1');
    expect(host.textContent).toContain('Sorumlu personel');
  });

  it('R8: preserves aria label, order, labels, and ReactNode content', async () => {
    await renderAtWidth(720);

    const descriptions = host.querySelector('.servora-record-descriptions[aria-label="İş kayıt bilgileri"]');
    expect(descriptions).not.toBeNull();

    const text = host.textContent ?? '';
    expect(text.indexOf('Durum')).toBeLessThan(text.indexOf('Sorumlu personel'));
    expect(text.indexOf('Sorumlu personel')).toBeLessThan(text.indexOf('Açıklama'));
    expect(host.querySelector('[data-testid="desc-node"]')?.textContent).toBe('Uzun açıklama içeriği');
  });

  it('threshold boundary: width exactly at min width uses two columns', async () => {
    await renderAtWidth(RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX);
    expect(columnCount()).toBe('2');
  });

  it('threshold boundary: one px below min width uses one column', async () => {
    await renderAtWidth(RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX - 1);
    expect(columnCount()).toBe('1');
  });
});
