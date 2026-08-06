/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_ROOTS = `
  <div id="responsive-descriptions-root"></div>
  <div id="responsive-descriptions-wide-root"></div>
  <div id="responsive-timeline-root"></div>
`;

const TIMELINE_ITEMS = [
  {
    key: 'smoke-activity-1',
    action: 'Düzeltme için geri gönderildi',
    detail: 'Yönetici kontrolünde → Düzeltme gerekiyor',
    reason: 'Teslim miktarını doğrulayın',
    actor: 'Emrah Yönetici',
    occurredAt: '2026-07-18T09:00:00.000Z',
    occurredAtLabel: '18 Tem 2026 12:00',
  },
];

const DESCRIPTION_ITEMS = [
  { key: 'status', label: 'Durum', content: 'Hazırlanıyor' },
  { key: 'customer', label: 'Müşteri', content: 'DentArt Ağız ve Diş Sağlığı' },
];

describe('responsive smoke job-detail fixture readiness', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    delete document.documentElement.dataset.smokeJobDetailReady;
    host = document.createElement('div');
    host.innerHTML = FIXTURE_ROOTS;
    document.body.append(host);
    vi.resetModules();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    host.remove();
    delete document.documentElement.dataset.smokeJobDetailReady;
    vi.unstubAllGlobals();
  });

  it('sets the ready marker only after ActivityTimeline and RecordDescriptions commit', async () => {
    const { mountResponsiveJobDetailFixture } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    await act(async () => {
      mountResponsiveJobDetailFixture();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
    expect(document.querySelector('#responsive-timeline-root .servora-ant-timeline'))
      .not.toBeNull();
    expect(document.querySelector('#responsive-descriptions-root .servora-record-descriptions'))
      .not.toBeNull();
  });

  it('never marks ready before React commits (marker is commit-gated)', async () => {
    const { mountResponsiveJobDetailFixture } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    expect(document.querySelector('#responsive-timeline-root .servora-ant-timeline')).toBeNull();
    await act(async () => {
      mountResponsiveJobDetailFixture();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
  });

  it('does not treat a static timeline parent as ready when the fixture is not mounted', async () => {
    host.innerHTML = '<section class="job-timeline" data-smoke-timeline></section>';
    await act(async () => {
      await import('../scripts/responsive-job-detail-fixture');
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    expect(document.querySelector('.servora-ant-timeline')).toBeNull();
  });
});

describe('order-independent commit coordinator', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    delete document.documentElement.dataset.smokeJobDetailReady;
    host = document.createElement('div');
    host.innerHTML = FIXTURE_ROOTS;
    document.body.append(host);
    vi.resetModules();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    host.remove();
    delete document.documentElement.dataset.smokeJobDetailReady;
    vi.unstubAllGlobals();
  });

  it('timeline first: marker waits for the descriptions root', async () => {
    const { FixtureCommitSignal } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    const { ActivityTimeline, RecordDescriptions, ServoraAntProvider } = await import('../src/ui/antd');
    await act(async () => {
      createRoot(document.getElementById('responsive-timeline-root')!).render(
        <ServoraAntProvider>
          <ActivityTimeline items={TIMELINE_ITEMS} />
          <FixtureCommitSignal part="timeline" />
        </ServoraAntProvider>,
      );
    });
    expect(document.querySelector('#responsive-timeline-root .servora-ant-timeline'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    await act(async () => {
      createRoot(document.getElementById('responsive-descriptions-root')!).render(
        <ServoraAntProvider>
          <RecordDescriptions
            ariaLabel="İş kayıt bilgileri"
            items={DESCRIPTION_ITEMS}
            maxColumns={1}
          />
          <FixtureCommitSignal part="descriptions" />
        </ServoraAntProvider>,
      );
    });
    expect(document.querySelector('#responsive-descriptions-root .servora-record-descriptions'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
  });

  it('descriptions first: marker waits for the timeline root', async () => {
    const { FixtureCommitSignal } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    const { ActivityTimeline, RecordDescriptions, ServoraAntProvider } = await import('../src/ui/antd');
    await act(async () => {
      createRoot(document.getElementById('responsive-descriptions-root')!).render(
        <ServoraAntProvider>
          <RecordDescriptions
            ariaLabel="İş kayıt bilgileri"
            items={DESCRIPTION_ITEMS}
            maxColumns={1}
          />
          <FixtureCommitSignal part="descriptions" />
        </ServoraAntProvider>,
      );
    });
    expect(document.querySelector('#responsive-descriptions-root .servora-record-descriptions'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    await act(async () => {
      createRoot(document.getElementById('responsive-timeline-root')!).render(
        <ServoraAntProvider>
          <ActivityTimeline items={TIMELINE_ITEMS} />
          <FixtureCommitSignal part="timeline" />
        </ServoraAntProvider>,
      );
    });
    expect(document.querySelector('#responsive-timeline-root .servora-ant-timeline'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
  });

  it('delayed second root: marker appears when the gated root commits', async () => {
    const { FixtureCommitSignal } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    const { ActivityTimeline, RecordDescriptions, ServoraAntProvider } = await import('../src/ui/antd');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await act(async () => {
      createRoot(document.getElementById('responsive-timeline-root')!).render(
        <ServoraAntProvider>
          <ActivityTimeline items={TIMELINE_ITEMS} />
          <FixtureCommitSignal part="timeline" />
        </ServoraAntProvider>,
      );
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();

    const pending = (async () => {
      await gate;
      await act(async () => {
        createRoot(document.getElementById('responsive-descriptions-root')!).render(
          <ServoraAntProvider>
            <RecordDescriptions
              ariaLabel="İş kayıt bilgileri"
              items={DESCRIPTION_ITEMS}
              maxColumns={1}
            />
            <FixtureCommitSignal part="descriptions" />
          </ServoraAntProvider>,
        );
      });
    })();

    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    release();
    await pending;
    expect(document.querySelector('#responsive-descriptions-root .servora-record-descriptions'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
  });

  it('root cleanup: unmounting either root removes the marker', async () => {
    const { FixtureCommitSignal } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    const { ActivityTimeline, RecordDescriptions, ServoraAntProvider } = await import('../src/ui/antd');
    const timelineRoot: Root = createRoot(document.getElementById('responsive-timeline-root')!);
    const descriptionsRoot: Root = createRoot(document.getElementById('responsive-descriptions-root')!);
    await act(async () => {
      timelineRoot.render(
        <ServoraAntProvider>
          <ActivityTimeline items={TIMELINE_ITEMS} />
          <FixtureCommitSignal part="timeline" />
        </ServoraAntProvider>,
      );
      descriptionsRoot.render(
        <ServoraAntProvider>
          <RecordDescriptions
            ariaLabel="İş kayıt bilgileri"
            items={DESCRIPTION_ITEMS}
            maxColumns={1}
          />
          <FixtureCommitSignal part="descriptions" />
        </ServoraAntProvider>,
      );
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');

    await act(async () => {
      descriptionsRoot.unmount();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();

    await act(async () => {
      createRoot(document.getElementById('responsive-descriptions-root')!).render(
        <ServoraAntProvider>
          <RecordDescriptions
            ariaLabel="İş kayıt bilgileri"
            items={DESCRIPTION_ITEMS}
            maxColumns={1}
          />
          <FixtureCommitSignal part="descriptions" />
        </ServoraAntProvider>,
      );
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');

    await act(async () => {
      timelineRoot.unmount();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
  });

  it('StrictMode replay: final live mount sets the marker, unmount removes it', async () => {
    const { FixtureCommitSignal } = await import(
      '../scripts/responsive-job-detail-fixture-runtime'
    );
    const { ActivityTimeline, RecordDescriptions, ServoraAntProvider } = await import('../src/ui/antd');
    const timelineRoot: Root = createRoot(document.getElementById('responsive-timeline-root')!);
    const descriptionsRoot: Root = createRoot(document.getElementById('responsive-descriptions-root')!);
    await act(async () => {
      timelineRoot.render(
        <StrictMode>
          <ServoraAntProvider>
            <ActivityTimeline items={TIMELINE_ITEMS} />
            <FixtureCommitSignal part="timeline" />
          </ServoraAntProvider>
        </StrictMode>,
      );
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    await act(async () => {
      descriptionsRoot.render(
        <StrictMode>
          <ServoraAntProvider>
            <RecordDescriptions
              ariaLabel="İş kayıt bilgileri"
              items={DESCRIPTION_ITEMS}
              maxColumns={1}
            />
            <FixtureCommitSignal part="descriptions" />
          </ServoraAntProvider>
        </StrictMode>,
      );
    });
    expect(document.querySelector('#responsive-timeline-root .servora-ant-timeline'))
      .not.toBeNull();
    expect(document.querySelector('#responsive-descriptions-root .servora-record-descriptions'))
      .not.toBeNull();
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');

    await act(async () => {
      timelineRoot.unmount();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
  });
});

describe('production mount contract', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    delete document.documentElement.dataset.smokeJobDetailReady;
    host = document.createElement('div');
    host.innerHTML = FIXTURE_ROOTS;
    document.body.append(host);
    vi.resetModules();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    host.remove();
    delete document.documentElement.dataset.smokeJobDetailReady;
    vi.unstubAllGlobals();
  });

  it('entrypoint mounts each container exactly once with no duplicate-root warnings', async () => {
    const consoleSpy = vi.spyOn(console, 'error');
    await act(async () => {
      await import('../scripts/responsive-job-detail-fixture');
    });
    const duplicateRootWarnings = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((msg) => msg.includes('already been passed to createRoot'));
    expect(duplicateRootWarnings).toEqual([]);
    expect(document.querySelectorAll('#responsive-timeline-root > *')).toHaveLength(1);
    expect(document.querySelectorAll('#responsive-descriptions-root > *')).toHaveLength(1);
    expect(document.querySelectorAll('#responsive-descriptions-wide-root > *')).toHaveLength(1);
    expect(document.documentElement.dataset.smokeJobDetailReady).toBe('true');
  });
});
