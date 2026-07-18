/** @vitest-environment jsdom */

import { ConfigProvider, theme } from 'antd';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

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

  it('wires the owned provider around the existing application root', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(mainSource).toContain("import { ServoraAntProvider } from './ui/antd';");
    expect(mainSource).toMatch(
      /<StrictMode>\s*<ServoraAntProvider>\s*<BrowserRouter>\s*<App \/>\s*<\/BrowserRouter>\s*<\/ServoraAntProvider>\s*<\/StrictMode>/,
    );
  });
});
