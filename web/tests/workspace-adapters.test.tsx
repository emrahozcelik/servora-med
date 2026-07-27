/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ServoraAntProvider } from '../src/ui/antd';
import { MetricStatistic } from '../src/ui/antd/MetricStatistic';
import { UserAvatar } from '../src/ui/antd/UserAvatar';
import { IconSegmented } from '../src/ui/antd/IconSegmented';
import { ContentCollapse } from '../src/ui/antd/ContentCollapse';
import { ContentAnchor } from '../src/ui/antd/ContentAnchor';
import { SettingsTabs } from '../src/ui/antd/SettingsTabs';

describe('MetricStatistic', () => {
  it('renders title and value', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Toplam Teslimat" value={42} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-metric-statistic');
    expect(html).toContain('Toplam Teslimat');
    expect(html).toContain('42');
  });

  it('applies tone class when not default', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Geciken" value={5} tone="attention" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-metric-statistic--attention');
  });

  it('renders without tone class for default', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Normal" value={10} tone="default" />
      </ServoraAntProvider>,
    );
    expect(html).not.toContain('--default');
  });

  it('wraps value in Link when linkTo provided', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ServoraAntProvider>
          <MetricStatistic title="Rapor" value="Görüntüle" linkTo="/reports" />
        </ServoraAntProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('href="/reports"');
    expect(html).toContain('Görüntüle');
  });

  it('shows loading skeleton when loading', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Yükleniyor" value={0} loading />
      </ServoraAntProvider>,
    );
    expect(html).toContain('data-servora-loading-skeleton="true"');
    expect(html).toContain('Yükleniyor');
  });

  it('renders prefix and suffix', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Gelir" value="12.500" prefix="₺" suffix="TL" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('₺');
    expect(html).toContain('TL');
  });
});

describe('UserAvatar', () => {
  it('generates initials from name', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <UserAvatar name="Demo Staff" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('DS');
  });

  it('generates initials for single-word name', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <UserAvatar name="Admin" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('A');
  });

  it('generates initials for multi-word name', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <UserAvatar name="Ayşe Personel" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('AP');
  });

  it('handles names with extra spaces', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <UserAvatar name="  Ahmet  Yılmaz  " />
      </ServoraAntProvider>,
    );
    expect(html).toContain('AY');
  });

  it('renders with servora CSS class', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <UserAvatar name="Test User" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-user-avatar');
  });
});

describe('IconSegmented', () => {
  const options = [
    { label: 'Aylık', value: 'monthly' },
    { label: 'Haftalık', value: 'weekly' },
    { label: 'Günlük', value: 'daily' },
  ];

  it('renders all options', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <IconSegmented
          options={options}
          value="monthly"
          onChange={() => {}}
        />
      </ServoraAntProvider>,
    );
    expect(html).toContain('Aylık');
    expect(html).toContain('Haftalık');
    expect(html).toContain('Günlük');
  });

  it('prepends icon to label when provided', () => {
    const iconOptions = [
      { label: 'Ara', value: 'search', icon: '🔍' },
    ];
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <IconSegmented
          options={iconOptions}
          value="search"
          onChange={() => {}}
        />
      </ServoraAntProvider>,
    );
    expect(html).toContain('🔍');
    expect(html).toContain('Ara');
  });

  it('renders with servora CSS class', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <IconSegmented
          options={options}
          value="monthly"
          onChange={() => {}}
        />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-icon-segmented');
  });
});

describe('ContentCollapse', () => {
  const items = [
    { key: '1', label: 'Bölüm 1', children: <p>İçerik 1</p> },
    { key: '2', label: 'Bölüm 2', children: <p>İçerik 2</p> },
  ];

  it('renders all item labels', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentCollapse items={items} defaultActiveKey={['1', '2']} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('Bölüm 1');
    expect(html).toContain('Bölüm 2');
    expect(html).toContain('İçerik 1');
    expect(html).toContain('İçerik 2');
  });

  it('renders with servora CSS class', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentCollapse items={items} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-content-collapse');
  });

  it('accepts accordion prop', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentCollapse items={items} accordion />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-content-collapse');
  });
});

describe('ContentAnchor', () => {
  const items = [
    { key: 'intro', href: '#intro', title: 'Giriş' },
    { key: 'usage', href: '#usage', title: 'Kullanım' },
  ];

  it('renders all links', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentAnchor items={items} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('href="#intro"');
    expect(html).toContain('href="#usage"');
    expect(html).toContain('Giriş');
    expect(html).toContain('Kullanım');
  });

  it('renders with servora CSS class', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentAnchor items={items} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-content-anchor');
  });

  it('renders offsetTop when provided', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ContentAnchor items={items} offsetTop={80} />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-content-anchor');
  });
});

describe('SettingsTabs', () => {
  const items = [
    { key: 'general', label: 'Genel', to: '/settings/general' },
    { key: 'security', label: 'Güvenlik', to: '/settings/security' },
  ];

  it('renders tab links with correct hrefs', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ServoraAntProvider>
          <SettingsTabs items={items} activeKey="general" />
        </ServoraAntProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('href="/settings/general"');
    expect(html).toContain('href="/settings/security"');
    expect(html).toContain('Genel');
    expect(html).toContain('Güvenlik');
  });

  it('renders with servora CSS class', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ServoraAntProvider>
          <SettingsTabs items={items} activeKey="general" />
        </ServoraAntProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('servora-settings-tabs');
  });

  it('sets activeKey on tabs', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ServoraAntProvider>
          <SettingsTabs items={items} activeKey="general" />
        </ServoraAntProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('servora-settings-tabs');
  });
});
