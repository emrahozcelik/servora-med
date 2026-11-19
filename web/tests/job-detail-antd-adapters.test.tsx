/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ServoraAntProvider } from '../src/ui/antd';
import {
  resolveItemSpans,
  type RecordDescriptionItem,
} from '../src/ui/antd/RecordDescriptions';

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
  it('gives a trailing wide item its own full row in two-column mode', () => {
    const items: readonly RecordDescriptionItem[] = Array.from({ length: 8 }, (_, index) => ({
      key: `item-${index}`,
      label: `Label ${index}`,
      content: `Value ${index}`,
      wide: index === 7,
    }));
    expect(resolveItemSpans(items, 2)).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
  });

  it('keeps a wide item on its own row when it starts a fresh row', () => {
    const items: readonly RecordDescriptionItem[] = Array.from({ length: 6 }, (_, index) => ({
      key: `item-${index}`,
      label: `Label ${index}`,
      content: `Value ${index}`,
      wide: index === 3,
    }));
    expect(resolveItemSpans(items, 2)).toEqual([1, 1, 2, 2, 1, 1]);
  });

  it('uses single spans for one-column layouts and closes the row before a wide item', () => {
    const items: readonly RecordDescriptionItem[] = [
      { key: 'a', label: 'A', content: '1' },
      { key: 'b', label: 'B', content: '2', wide: true },
    ];
    expect(resolveItemSpans(items, 1)).toEqual([1, 1]);
    expect(resolveItemSpans(items, 2)).toEqual([2, 2]);
  });

  it('renders prepared workflow phases with current and non-color state semantics', async () => {
    const { WorkflowSteps } = await boundary();
    expect(WorkflowSteps).toBeTypeOf('function');
    if (!WorkflowSteps) return;

    const items = [
      { key: 'CREATED', label: 'Atandı', state: 'complete' as const },
      { key: 'ACCEPTANCE', label: 'Planlama atlandı', state: 'skipped' as const },
      { key: 'EXECUTION', label: 'Uygulanıyor', state: 'current' as const },
      { key: 'REVIEW', label: 'Yönetici kontrolü', state: 'upcoming' as const },
      { key: 'COMPLETION', label: 'Tamamlandı', state: 'upcoming' as const },
    ];

    const html = renderToStaticMarkup(<ServoraAntProvider><WorkflowSteps
      currentKey="EXECUTION"
      items={items}
    /></ServoraAntProvider>);

    expect(html).toContain('aria-label="İş süreci"');
    expect(html).toContain('servora-ant-steps');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Uygulanıyor');
    expect(html).toContain('Şu an');
    expect(html).toContain('Planlama atlandı');
    expect(html).toContain('Atlandı');
    expect(html).toMatch(/aria-hidden="true"/);

    // Accessible list contract: real ol/li (or list/listitem), one current step, state text.
    document.body.innerHTML = html;
    const list = document.body.querySelector(
      'ol[aria-label="İş süreci"], [role="list"][aria-label="İş süreci"]',
    );
    const listItems = list?.querySelectorAll('li, [role="listitem"]');
    expect(listItems).toHaveLength(5);
    expect(
      Array.from(listItems ?? []).filter(
        (item) => item.getAttribute('aria-current') === 'step',
      ),
    ).toHaveLength(1);
    const stateTexts = ['Tamamlandı', 'Şu an', 'Sırada', 'Atlandı', 'Dikkat gerekiyor'];
    for (const item of Array.from(listItems ?? [])) {
      const text = item.textContent ?? '';
      expect(stateTexts.some((state) => text.includes(state))).toBe(true);
    }
    document.body.innerHTML = '';
  });

  it('renders revision attention without the Ant error status or Critical Red semantics', async () => {
    const { WorkflowSteps } = await boundary();
    if (!WorkflowSteps) return;
    const html = renderToStaticMarkup(<ServoraAntProvider><WorkflowSteps
      currentKey="EXECUTION"
      items={[
        { key: 'CREATED', label: 'Atandı', state: 'complete' as const },
        { key: 'ACCEPTANCE', label: 'Kabul edildi', state: 'complete' as const },
        { key: 'EXECUTION', label: 'Uygulanıyor', state: 'attention' as const },
        { key: 'REVIEW', label: 'Yönetici kontrolü', state: 'upcoming' as const },
        { key: 'COMPLETION', label: 'Tamamlandı', state: 'upcoming' as const },
      ]}
    /></ServoraAntProvider>);
    // Attention is Delay Amber plus text/icon — never Ant's error status.
    expect(html).not.toContain('servora-ant-steps-item-error');
    expect(html).toContain('servora-workflow-step--attention');
    expect(html).toContain('Dikkat gerekiyor');
    expect(html).toContain('⚠');

    // The attention step owns its icon slot instead of Ant's numeric `process`
    // icon, so the numbered primary-blue circle cannot render.
    document.body.innerHTML = html;
    const attention = document.body.querySelector('.servora-workflow-step--attention')!;
    expect(attention.querySelector('.servora-workflow-attention-icon')).not.toBeNull();
    expect(attention.querySelector('.servora-ant-steps-item-icon-number')).toBeNull();
    expect(attention.classList.contains('servora-ant-steps-item-custom')).toBe(true);
    for (const step of Array.from(document.body.querySelectorAll('.servora-workflow-step'))) {
      if (step.classList.contains('servora-workflow-step--attention')) continue;
      expect(step.querySelector('.servora-workflow-attention-icon')).toBeNull();
    }
    document.body.innerHTML = '';
  });

  it('collapses the stepper behind a one-line summary on narrow shells', async () => {
    const { WorkflowSteps } = await boundary();
    if (!WorkflowSteps) return;
    // jsdom has no matchMedia, which the adapter treats as a narrow shell.
    const html = renderToStaticMarkup(<ServoraAntProvider><WorkflowSteps
      currentKey="EXECUTION"
      items={[
        { key: 'CREATED', label: 'Atandı', state: 'complete' as const },
        { key: 'ACCEPTANCE', label: 'Kabul edildi', state: 'complete' as const },
        { key: 'EXECUTION', label: 'Uygulanıyor', state: 'current' as const },
        { key: 'REVIEW', label: 'Yönetici kontrolü', state: 'upcoming' as const },
        { key: 'COMPLETION', label: 'Tamamlandı', state: 'upcoming' as const },
      ]}
    /></ServoraAntProvider>);
    expect(html).toContain('data-workflow-compact="true"');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('3 / 5');
    expect(html).toContain('Uygulanıyor');
    // The screen-reader ordered list stays outside the disclosure.
    const detailsAt = html.indexOf('<details');
    const listAt = html.indexOf('aria-label="İş süreci"');
    expect(listAt).toBeGreaterThan(-1);
    expect(listAt).toBeLessThan(detailsAt);
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
    expect(html).toContain('servora-ant-descriptions');
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
    expect(html).toContain('servora-ant-timeline');
    expect(html).toContain('Düzeltme için geri gönderildi');
    expect(html).toContain('Miktarı düzeltin');
    expect(html).toContain('Emrah Yönetici');
    expect(html).toContain('dateTime="2026-07-18T09:00:00.000Z"');
  });
});
