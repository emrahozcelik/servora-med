/** @vitest-environment jsdom */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE_ROOTS = `
  <div id="responsive-descriptions-root"></div>
  <div id="responsive-descriptions-wide-root"></div>
  <div id="responsive-timeline-root"></div>
`;

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
      '../scripts/responsive-job-detail-fixture'
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
      '../scripts/responsive-job-detail-fixture'
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
    const { mountResponsiveJobDetailFixture } = await import(
      '../scripts/responsive-job-detail-fixture'
    );
    await act(async () => {
      mountResponsiveJobDetailFixture();
    });
    expect(document.documentElement.dataset.smokeJobDetailReady).toBeUndefined();
    expect(document.querySelector('.servora-ant-timeline')).toBeNull();
  });
});
