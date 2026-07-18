import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  ReportEmptyState,
  ReportErrorState,
  ReportLoadingState,
} from '../src/reports/report-shell';

type Boundary = {
  ServoraAntProvider: ComponentType<{ children: ReactNode }>;
  ResultState?: ComponentType<{
    status: 'error';
    title: string;
    description: string;
    action: ReactNode;
    headingLevel: 2;
  }>;
  EmptyState?: ComponentType<{
    title: string;
    description: string;
    action: ReactNode;
    headingLevel: 3;
  }>;
  LoadingSkeleton?: ComponentType<{
    title: string;
    headingLevel: 1;
    rows: number;
  }>;
};

async function boundary(): Promise<Boundary> {
  return import('../src/ui/antd') as Promise<Boundary>;
}

describe('owned result-state adapters', () => {
  it('renders an announced Result with a semantic heading and action', async () => {
    const { ResultState, ServoraAntProvider } = await boundary();
    expect(ResultState).toBeTypeOf('function');
    if (!ResultState) return;

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <ResultState
          status="error"
          title="Rapor yüklenemedi"
          description="Sunucuya ulaşılamadı."
          headingLevel={2}
          action={<button type="button">Tekrar dene</button>}
        />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-servora-result-state="true"');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<h2[^>]*>Rapor yüklenemedi<\/h2>/);
    expect(html).toContain('Sunucuya ulaşılamadı.');
    expect(html).toContain('>Tekrar dene</button>');
  });

  it('renders an explanatory Empty with a semantic heading and optional action', async () => {
    const { EmptyState, ServoraAntProvider } = await boundary();
    expect(EmptyState).toBeTypeOf('function');
    if (!EmptyState) return;

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <EmptyState
          title="Onaylı teslim yok"
          description="Tarih aralığını değiştirin."
          headingLevel={3}
          action={<button type="button">Filtreleri temizle</button>}
        />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-servora-empty-state="true"');
    expect(html).toMatch(/<h3[^>]*>Onaylı teslim yok<\/h3>/);
    expect(html).toContain('Tarih aralığını değiştirin.');
    expect(html).toContain('>Filtreleri temizle</button>');
  });

  it('renders a labelled busy Skeleton with stable paragraph geometry', async () => {
    const { LoadingSkeleton, ServoraAntProvider } = await boundary();
    expect(LoadingSkeleton).toBeTypeOf('function');
    if (!LoadingSkeleton) return;

    const html = renderToStaticMarkup(
      <ServoraAntProvider>
        <LoadingSkeleton title="Rapor yükleniyor" headingLevel={1} rows={3} />
      </ServoraAntProvider>,
    );

    expect(html).toContain('data-servora-loading-skeleton="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<h1[^>]*class="sr-only"[^>]*>Rapor yükleniyor<\/h1>/);
    expect(html).toContain('servora-loading-skeleton__content');
    expect((html.match(/<li/g) ?? [])).toHaveLength(3);
  });

  it('routes report states through the owned shared adapters', () => {
    const empty = renderToStaticMarkup(
      <ReportEmptyState title="Kayıt yok" description="Filtreleri değiştirin." />,
    );
    const error = renderToStaticMarkup(
      <ReportErrorState title="Yüklenemedi" message="Bağlantı yok" onRetry={() => {}} />,
    );
    const loading = renderToStaticMarkup(<ReportLoadingState title="Yükleniyor" />);

    expect(empty).toContain('data-servora-empty-state="true"');
    expect(error).toContain('data-servora-result-state="true"');
    expect(error).toContain('role="alert"');
    expect(loading).toContain('data-servora-loading-skeleton="true"');
  });
});
