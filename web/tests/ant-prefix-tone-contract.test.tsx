/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { OperationalCard } from '../src/ui/antd/OperationalCard';
import { MetricStatistic } from '../src/ui/antd/MetricStatistic';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('Ant prefix and operational two-channel contract', () => {
  it('uses servora-ant selectors for every owned Ant card, statistic, and checkbox override', () => {
    expect(css).not.toMatch(/\.ant-(?:card|statistic|checkbox)[\w-]*/);
    expect(css).toContain('.servora-operational-card .servora-ant-card-head');
    expect(css).toContain('.servora-metric-statistic .servora-ant-statistic-title');
    expect(css).toContain('.job-filter-checkbox .servora-ant-checkbox-wrapper');
  });

  it.each(['new', 'upcoming', 'attention', 'overdue', 'success', 'selected'] as const)(
    'styles non-default %s card tone with a readable status label',
    (tone) => {
      const html = renderToStaticMarkup(
        <ServoraAntProvider>
          <OperationalCard tone={tone} title="Görev">Ayrıntılar</OperationalCard>
        </ServoraAntProvider>,
      );
      expect(html).toContain('servora-operational-card--' + tone);
      expect(html).toContain('servora-tone-chip--' + tone);
      expect(css).toContain('.servora-operational-card--' + tone);
    },
  );

  it('supports a specific visible phrase without hiding existing card extra', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <OperationalCard tone="upcoming" statusLabel="Yarın planlı" title="Ziyaret" extra="Sorumlu personel">
          Detay
        </OperationalCard>
      </ServoraAntProvider>,
    );
    expect(html).toContain('Yarın planlı');
    expect(html).toContain('Sorumlu personel');
  });

  it('does not inject a status chip into neutral cards', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider><OperationalCard title="Not">Kayıt</OperationalCard></ServoraAntProvider>,
    );
    expect(html).not.toContain('servora-tone-chip');
  });

  it('uses readable KPI status text in addition to the semantic border', () => {
    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <MetricStatistic title="Geciken" value={2} tone="attention" statusPhrase="Termin süresi aşıldı" />
      </ServoraAntProvider>,
    );
    expect(html).toContain('servora-metric-statistic--attention');
    expect(html).toContain('Termin süresi aşıldı');
    expect(html).toContain('servora-metric-statistic__status');
  });
});
