/** @vitest-environment jsdom */

import { ConfigProvider, theme } from 'antd';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import {
  getServoraAntTheme,
  getServoraPopupContainer,
  servoraAntTheme,
  ServoraAntProvider,
  useAppFeedback,
} from '../src/ui/antd';

function FoundationProbe() {
  const config = useContext(ConfigProvider.ConfigContext);
  const feedback = useAppFeedback();

  return (
    <output
      data-feedback={[
        typeof feedback.message.open,
        typeof feedback.notification.open,
        typeof feedback.modal.confirm,
      ].join(',')}
      data-locale={config.locale?.locale}
      data-prefix={config.getPrefixCls()}
    />
  );
}

function MotionProbe() {
  const config = useContext(ConfigProvider.ConfigContext);

  return <output data-motion={String(config.theme?.token?.motion)} />;
}

const originalMatchMedia = window.matchMedia;

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener);
  });
  const removeEventListener = vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener);
  });
  const mediaQuery = {
    addEventListener,
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    removeEventListener,
    removeListener: vi.fn(),
  } as unknown as MediaQueryList;

  Object.defineProperty(mediaQuery, 'matches', { get: () => matches });
  const matchMedia = vi.fn(() => mediaQuery);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });

  return {
    addEventListener,
    matchMedia,
    removeEventListener,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: originalMatchMedia,
  });
});

function channelToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16));

  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hexadecimal color, received ${hex}`);
  }

  const [red, green, blue] = channels.map(channelToLinear);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Servora Ant Design foundation', () => {
  it('renders the existing application beneath the owned provider', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MemoryRouter initialEntries={['/jobs']}>
          <App initialUser={null} />
        </MemoryRouter>
      </ServoraAntProvider>,
    );

    expect(html).toContain('Hesabınıza giriş yapın');
  });

  it('provides the isolated prefix, Turkish locale, and context feedback APIs', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <FoundationProbe />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-prefix="servora-ant"');
    expect(html).toContain('data-locale="tr"');
    expect(html).toContain('data-feedback="function,function,function"');
  });

  it('uses the document body as the viewport-level popup container', () => {
    expect(getServoraPopupContainer()).toBe(document.body);
  });

  it('maps the canonical Servora design values into resolved Ant tokens', () => {
    const token = theme.getDesignToken(servoraAntTheme);

    expect(token).toMatchObject({
      borderRadius: 10,
      controlHeight: 44,
      fontSize: 16,
    });
    expect({
      colorPrimary: token.colorPrimary.toUpperCase(),
      colorText: token.colorText.toUpperCase(),
      colorTextSecondary: token.colorTextSecondary.toUpperCase(),
      colorBgBase: token.colorBgBase.toUpperCase(),
      colorBgContainer: token.colorBgContainer.toUpperCase(),
      colorBorder: token.colorBorder.toUpperCase(),
      colorError: token.colorError.toUpperCase(),
      colorWarning: token.colorWarning.toUpperCase(),
      colorSuccess: token.colorSuccess.toUpperCase(),
      colorInfo: token.colorInfo.toUpperCase(),
      controlOutline: token.controlOutline.toUpperCase(),
    }).toEqual({
      colorPrimary: '#00628E',
      colorText: '#1E252B',
      colorTextSecondary: '#535C65',
      colorBgBase: '#F8FBFC',
      colorBgContainer: '#F8FBFC',
      colorBorder: '#CAD2D8',
      colorError: '#902822',
      colorWarning: '#603C07',
      colorSuccess: '#1D4E2B',
      colorInfo: '#00507C',
      controlOutline: '#0084C3',
    });
  });

  it.each([
    ['#00628E', '#F8FBFC'],
    ['#1E252B', '#F8FBFC'],
    ['#535C65', '#F8FBFC'],
    ['#603C07', '#F7EDDC'],
    ['#1D4E2B', '#E3F4E6'],
    ['#00507C', '#D6E7F4'],
  ])('keeps normal text contrast for %s on %s', (foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the focus indicator distinguishable from the base surface', () => {
    expect(contrastRatio('#0084C3', '#F8FBFC')).toBeGreaterThanOrEqual(3);
  });

  it('derives reduced motion without mutating the canonical theme', () => {
    const baseToken = { ...servoraAntTheme.token };
    const reducedMotionTheme = getServoraAntTheme(true);

    expect(getServoraAntTheme(false)).toBe(servoraAntTheme);
    expect(reducedMotionTheme).not.toBe(servoraAntTheme);
    expect(reducedMotionTheme.token?.motion).toBe(false);
    expect(servoraAntTheme.token).toEqual(baseToken);
  });

  it('disables motion on the first render when the system preference requests it', () => {
    const media = installMatchMedia(true);

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MotionProbe />
      </ServoraAntProvider>,
    );

    expect(media.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(html).toContain('data-motion="false"');
  });

  it('keeps motion enabled on the first render when the system preference allows it', () => {
    installMatchMedia(false);

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MotionProbe />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-motion="true"');
  });

  it('updates the theme when the reduced-motion preference changes', async () => {
    const media = installMatchMedia(false);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <MotionProbe />
        </ServoraAntProvider>,
      );
    });
    expect(host.querySelector('output')?.dataset.motion).toBe('true');

    await act(async () => media.setMatches(true));
    expect(host.querySelector('output')?.dataset.motion).toBe('false');

    await act(async () => root.unmount());
    host.remove();
  });

  it('removes the reduced-motion listener when the provider unmounts', async () => {
    const media = installMatchMedia(false);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<ServoraAntProvider>content</ServoraAntProvider>);
    });
    const listener = media.addEventListener.mock.calls[0]?.[1];

    await act(async () => root.unmount());

    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
    host.remove();
  });

  it('falls back to motion-enabled rendering when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MotionProbe />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-motion="true"');
  });

  it('wires the owned provider around the existing application root', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(mainSource).toContain("import { ServoraAntProvider } from './ui/antd/ServoraAntProvider';");
    expect(mainSource).toMatch(
      /<StrictMode>\s*<InstallOpportunityProvider[^>]*>\s*<ServoraAntProvider>\s*<BrowserRouter>\s*<App \/>\s*<\/BrowserRouter>\s*<\/ServoraAntProvider>\s*<\/InstallOpportunityProvider>\s*<\/StrictMode>/,
    );
  });
});
