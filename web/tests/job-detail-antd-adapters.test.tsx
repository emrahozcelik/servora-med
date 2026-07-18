/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ServoraAntProvider } from '../src/ui/antd';

type Boundary = {
  WorkflowSteps?: React.ComponentType<{
    currentKey: string | null;
    items: Array<{ key: string; label: string; state: 'complete' | 'current' | 'upcoming' | 'skipped' | 'attention' }>;
  }>;
  RecordDescriptions?: React.ComponentType<{
    ariaLabel: string;
    items: Array<{ key: string; label: string; content: React.ReactNode; wide?: boolean }>;
  }>;
  ActivityTimeline?: React.ComponentType<{
    items: Array<{
      key: string; action: string; detail: string; reason: string | null;
      actor: string; occurredAt: string; occurredAtLabel: string;
    }>;
  }>;
};

async function boundary(): Promise<Boundary> {
  return import('../src/ui/antd') as Promise<Boundary>;
}

describe('owned JobDetail Ant adapters', () => {
  it('renders prepared workflow phases with current and non-color state semantics', async () => {
    const { WorkflowSteps } = await boundary();
    expect(WorkflowSteps).toBeTypeOf('function');
    if (!WorkflowSteps) return;

    const html = renderToStaticMarkup(<ServoraAntProvider><WorkflowSteps
      currentKey="EXECUTION"
      items={[
        { key: 'CREATED', label: 'Atandı', state: 'complete' },
        { key: 'ACCEPTANCE', label: 'Planlama atlandı', state: 'skipped' },
        { key: 'EXECUTION', label: 'Uygulanıyor', state: 'current' },
        { key: 'REVIEW', label: 'Yönetici kontrolü', state: 'upcoming' },
        { key: 'COMPLETION', label: 'Tamamlandı', state: 'upcoming' },
      ]}
    /></ServoraAntProvider>);

    expect(html).toContain('aria-label="İş süreci"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Uygulanıyor');
    expect(html).toContain('Şu an');
    expect(html).toContain('Planlama atlandı');
    expect(html).toContain('Atlandı');
  });

  it('renders prepared read-only description items without domain knowledge', async () => {
    const { RecordDescriptions } = await boundary();
    expect(RecordDescriptions).toBeTypeOf('function');
    if (!RecordDescriptions) return;

    const html = renderToStaticMarkup(<ServoraAntProvider><RecordDescriptions
      ariaLabel="İş kayıt bilgileri"
      items={[
        { key: 'status', label: 'Durum', content: 'Uygulanıyor' },
        { key: 'description', label: 'Açıklama', content: 'Klinik teslimi', wide: true },
      ]}
    /></ServoraAntProvider>);

    expect(html).toContain('aria-label="İş kayıt bilgileri"');
    expect(html).toContain('Durum');
    expect(html).toContain('Uygulanıyor');
    expect(html).toContain('Açıklama');
    expect(html).toContain('Klinik teslimi');
  });

  it('renders persisted activity presentation with actor, time, detail, and reason', async () => {
    const { ActivityTimeline } = await boundary();
    expect(ActivityTimeline).toBeTypeOf('function');
    if (!ActivityTimeline) return;

    const html = renderToStaticMarkup(<ServoraAntProvider><ActivityTimeline items={[{
      key: 'a1', action: 'Düzeltme için geri gönderildi',
      detail: 'Yönetici kontrolünde → Düzeltme gerekiyor', reason: 'Miktarı düzeltin',
      actor: 'Emrah Yönetici', occurredAt: '2026-07-18T09:00:00.000Z',
      occurredAtLabel: '18 Tem 2026 12:00',
    }]} /></ServoraAntProvider>);

    expect(html).toContain('data-activity-id="a1"');
    expect(html).toContain('Düzeltme için geri gönderildi');
    expect(html).toContain('Miktarı düzeltin');
    expect(html).toContain('Emrah Yönetici');
    expect(html).toContain('dateTime="2026-07-18T09:00:00.000Z"');
  });
});
