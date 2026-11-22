/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffLatenessSection } from '../src/reports/StaffLatenessSection';
import { StaffOperationalReport } from '../src/reports/StaffOperationalReport';
import type {
  ResolvedReportRange,
  StaffLatenessIncidentItem,
  StaffLatenessIncidentListResponse,
  StaffLatenessSummary,
} from '../src/reports/report-types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const range: ResolvedReportRange = {
  from: '2026-09-01',
  to: '2026-10-31',
  timezone: 'Europe/Istanbul',
};

const lateness: StaffLatenessSummary = {
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  staffResponsibility: {
    delayedJobCount: 2,
    incidentCount: 3,
    byType: [
      {
        delayType: 'LATE_START',
        incidentCount: 2,
        recovered: { count: 1, medianSeconds: 8_100, maxSeconds: 8_100 },
        extended: { count: 1, medianSeconds: 90_000, maxSeconds: 90_000 },
        open: { count: 0, maxElapsedSeconds: null },
      },
      {
        delayType: 'LATE_SUBMISSION',
        incidentCount: 1,
        recovered: { count: 0, medianSeconds: null, maxSeconds: null },
        extended: { count: 0, medianSeconds: null, maxSeconds: null },
        open: { count: 1, maxElapsedSeconds: 7_200 },
      },
    ],
  },
  operational: {
    delayedJobCount: 2,
    incidentCount: 2,
    byReason: [
      { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 1 },
      { reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 },
    ],
  },
};

const emptyLateness: StaffLatenessSummary = {
  ...lateness,
  staffResponsibility: {
    delayedJobCount: 0,
    incidentCount: 0,
    byType: [
      {
        delayType: 'LATE_START',
        incidentCount: 0,
        recovered: { count: 0, medianSeconds: null, maxSeconds: null },
        extended: { count: 0, medianSeconds: null, maxSeconds: null },
        open: { count: 0, maxElapsedSeconds: null },
      },
      {
        delayType: 'LATE_SUBMISSION',
        incidentCount: 0,
        recovered: { count: 0, medianSeconds: null, maxSeconds: null },
        extended: { count: 0, medianSeconds: null, maxSeconds: null },
        open: { count: 0, maxElapsedSeconds: null },
      },
    ],
  },
  operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
};

function incident(overrides: Partial<StaffLatenessIncidentItem> = {}): StaffLatenessIncidentItem {
  return {
    incidentId: '44444444-4444-4444-8444-444444444444',
    delayType: 'LATE_START',
    episodeNo: 1,
    scheduleRevisionNo: 1,
    deadlineAt: '2026-10-20T06:00:00.000Z',
    breachedAt: '2026-10-20T06:05:00.000Z',
    outcome: 'RECOVERED',
    closedAt: '2026-10-20T07:00:00.000Z',
    durationSeconds: 3_300,
    operationalReason: null,
    job: {
      id: JOB_ID,
      title: 'Klinik ziyareti',
      type: 'SALES_MEETING',
      jobPath: `/jobs/${JOB_ID}`,
    },
    ...overrides,
  };
}

function page(
  items: StaffLatenessIncidentItem[],
  total = items.length,
  offset = 0,
): StaffLatenessIncidentListResponse {
  return { range, items, total, limit: 20, offset };
}

function renderSection(
  props: Partial<Parameters<typeof StaffLatenessSection>[0]> = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <StaffLatenessSection
        lateness={lateness}
        timezone={range.timezone}
        range={range}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('Staff lateness section', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders the fixed copy, both groups and the required duration labels', () => {
    const html = renderSection({ onRefresh: () => {} }).replaceAll('&#x27;', "'");

    expect(html).toMatch(/<h3[^>]*>Gecikme kayıtları<\/h3>/);
    expect(html).toContain(
      'Seçilen dönemde süresi aşılan başlama ve onaya gönderme kayıtları. '
      + 'Tek başına başarı veya zamanında bitirme oranı değildir.',
    );
    expect(html).toContain('Durumlar ');
    expect(html).toContain('itibarıyladır.');
    expect(html).toContain("Gecikme kayıtları 21 Eylül 2026'dan önce eksik olabilir.");
    expect(html).toContain('Personel sorumluluğundaki gecikmeler');
    for (const label of [
      'Geciken iş', 'Gecikme kaydı', 'Geç başlama', 'Geç onaya gönderme',
      'Kapandı', 'Tarih uzatıldı', 'Devam ediyor', 'Ortanca süre', 'En uzun süre',
      'Devam eden en uzun süre',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili gecikmeler');
    expect(html).toContain(
      'Bu ilişki otomatik belirlenir; talebin gecikmenin nedeni olduğu kesin değildir. '
      + 'Bu kayıtlar personel sorumluluğundaki sayılara eklenmez.',
    );
    expect(html).toContain('Müşteri / ilgili kişi yerinde değildi');
    expect(html).toContain('Stok veya ekipman eksik');
    // Durations reuse the shared authority: 8100 s = 2 saat 15 dakika.
    expect(html).toContain('2 saat 15 dakika');
    expect(html).toContain('1 gün 1 saat');
    expect(html).toContain('2 saat');
    // A listing control needs the parent-supplied loader.
    expect(html).not.toContain('Kayıtları göster');
    expect(html).not.toMatch(/puan|sıralama/i);
  });

  it('hides the list toggle when no loader is supplied and shows it otherwise', () => {
    expect(renderSection()).not.toContain('Kayıtları göster');
    expect(renderSection({ loadIncidents: async () => page([]) })).toContain('Kayıtları göster');
  });

  it('shows only the period empty copy and the tracking note when both groups are empty', () => {
    const html = renderSection({
      lateness: emptyLateness,
      loadIncidents: async () => page([]),
    }).replaceAll('&#x27;', "'");

    expect(html).toContain('Bu dönemde gecikme kaydı yok.');
    expect(html).not.toContain('Personel sorumluluğundaki gecikmeler');
    expect(html).not.toContain('Yönetimce sonuçlandırılan');
    expect(html).toContain("Gecikme kayıtları 21 Eylül 2026'dan önce eksik olabilir.");
    expect(html).not.toContain('Kayıtları göster');
  });

  it('omits the tracking note for a period that starts after tracking began', () => {
    const html = renderSection({
      range: { ...range, from: '2026-10-01' },
    });
    expect(html).not.toContain('eksik olabilir');
  });

  it('states the staff group empty copy while keeping the operational group', () => {
    const html = renderSection({
      lateness: {
        ...lateness,
        staffResponsibility: {
          ...emptyLateness.staffResponsibility,
        },
      },
    });
    expect(html).toContain('Bu dönemde personel sorumluluğunda gecikme kaydı yok.');
    expect(html).toContain('Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili gecikmeler');
    expect(html).not.toContain('Bu dönemde gecikme kaydı yok.');
  });

  it('keeps the section between the selected period and the operational context', () => {
    const report = {
      staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: true },
      range,
      priorRange: { from: '2026-08-31', to: '2026-09-30', timezone: range.timezone },
      performance: {
        completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0,
        correctionRequestEvents: 0, authoredOperationalNotes: 0,
      },
      priorPerformance: { available: false, performance: null },
      staffExecution: {
        staffCompletedJobs: 0, staffCompletionDays: 0,
        jobsPerStaffCompletionDay: 0, missingStaffCompletionTimestamp: 0,
      },
      staffSubmissionAttribution: { recordedSubmissionCount: 0, recordedSubmissionDays: 0 },
      onTime: {
        eligibleScheduledCompletedJobs: 0, onTimeCompletedJobs: 0, lateCompletedJobs: 0,
        ineligibleOrNoDeadlineCompletedJobs: 0, onTimeRate: null,
      },
      completionWorkTypes: [
        { type: 'PRODUCT_DELIVERY' as const, count: 0 },
        { type: 'GENERAL_TASK' as const, count: 0 },
        { type: 'SALES_MEETING' as const, count: 0 },
        { type: 'SALE' as const, count: 0 },
      ],
      currentWorkloadByType: [
        { type: 'PRODUCT_DELIVERY' as const, count: 0 },
        { type: 'GENERAL_TASK' as const, count: 0 },
        { type: 'SALES_MEETING' as const, count: 0 },
        { type: 'SALE' as const, count: 0 },
      ],
      completedTrend: [],
      deliveriesByPurpose: [],
      meetingsByOutcome: [
        { outcome: 'POSITIVE' as const, count: 0 },
        { outcome: 'FOLLOW_UP_REQUIRED' as const, count: 0 },
        { outcome: 'NO_DECISION' as const, count: 0 },
        { outcome: 'NOT_INTERESTED' as const, count: 0 },
      ],
      currentWorkload: {
        openJobCards: 0, overdueJobCards: 0, waitingApproval: 0, revisionRequested: 0,
      },
      lateness,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter><StaffOperationalReport report={report} /></MemoryRouter>,
    );
    const period = html.indexOf('staff-analysis-period');
    const latenessSection = html.indexOf('staff-analysis-lateness');
    const context = html.indexOf('staff-analysis-context');
    expect(period).toBeGreaterThan(-1);
    expect(period).toBeLessThan(latenessSection);
    expect(latenessSection).toBeLessThan(context);
    expect(html).toContain('Gecikme kayıtları');
  });

  it('opens the incident list, pages by 20 and marks transferred jobs', async () => {
    const loadIncidents = vi.fn()
      .mockResolvedValueOnce(page([incident()], 21, 0))
      .mockResolvedValueOnce(page([incident({
        incidentId: '55555555-5555-4555-8555-555555555555',
        delayType: 'LATE_SUBMISSION',
        episodeNo: 2,
        scheduleRevisionNo: 3,
        outcome: 'OPEN',
        closedAt: null,
        operationalReason: { reasonCode: 'OTHER', resolution: 'CORRECTED', resolvedAt: '2026-10-21T08:00:00.000Z' },
        job: null,
      })], 21, 1));

    await act(async () => root.render(
      <MemoryRouter>
        <StaffLatenessSection
          lateness={lateness}
          timezone={range.timezone}
          range={range}
          loadIncidents={loadIncidents}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    ));

    const toggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kayıtları göster')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    await act(async () => { await Promise.resolve(); });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Kayıtları gizle');
    expect(loadIncidents).toHaveBeenCalledWith({ limit: 20, offset: 0 });
    const rows = container.querySelectorAll('.staff-lateness-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Geç başlama');
    expect(rows[0].textContent).toContain('Kapandı');
    expect(rows[0].textContent).toContain('55 dakika');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe(`/jobs/${JOB_ID}`);

    const more = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Daha fazla göster')!;
    await act(async () => more.click());
    await act(async () => { await Promise.resolve(); });

    expect(loadIncidents).toHaveBeenLastCalledWith({ limit: 20, offset: 1 });
    const allRows = container.querySelectorAll('.staff-lateness-row');
    expect(allRows).toHaveLength(2);
    expect(allRows[1].textContent).toContain('Devredilmiş iş');
    expect(allRows[1].textContent).toContain('Gönderim turu 2');
    expect(allRows[1].textContent).toContain('Plan sürümü 3');
    expect(allRows[1].textContent).toContain('İlişkili değişiklik talebi: Diğer');
    expect(container.textContent).toContain('Daha fazla göster');
  });

  it('shows a list error and retries the first page', async () => {
    const loadIncidents = vi.fn()
      .mockRejectedValueOnce(new Error('Gecikme kayıtları alınamadı.'))
      .mockResolvedValueOnce(page([incident()]));

    await act(async () => root.render(
      <MemoryRouter>
        <StaffLatenessSection
          lateness={lateness}
          timezone={range.timezone}
          range={range}
          loadIncidents={loadIncidents}
        />
      </MemoryRouter>,
    ));
    const toggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kayıtları göster')!;
    await act(async () => toggle.click());
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Gecikme kayıtları alınamadı.');
    const retry = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => retry.click());
    await act(async () => { await Promise.resolve(); });

    expect(loadIncidents).toHaveBeenCalledTimes(2);
    expect(loadIncidents).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
    expect(container.querySelectorAll('.staff-lateness-row')).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('calls the parent refresh and reloads loaded rows for a newer summary', async () => {
    const onRefresh = vi.fn();
    const loadIncidents = vi.fn().mockResolvedValue(page([incident()]));

    await act(async () => root.render(
      <MemoryRouter>
        <StaffLatenessSection
          lateness={lateness}
          timezone={range.timezone}
          range={range}
          loadIncidents={loadIncidents}
          onRefresh={onRefresh}
        />
      </MemoryRouter>,
    ));
    const refresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Yenile')!;
    expect(refresh.hasAttribute('disabled')).toBe(false);
    await act(async () => refresh.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const toggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kayıtları göster')!;
    await act(async () => toggle.click());
    await act(async () => { await Promise.resolve(); });
    expect(loadIncidents).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MemoryRouter>
        <StaffLatenessSection
          lateness={{ ...lateness, generatedAt: '2026-11-02T10:00:00.000Z' }}
          timezone={range.timezone}
          range={range}
          loadIncidents={loadIncidents}
          onRefresh={onRefresh}
        />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });

    expect(loadIncidents).toHaveBeenCalledTimes(2);
    expect(loadIncidents).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
    expect(container.textContent).toContain('13:00');
  });

  it('disables the refresh control when the parent supplies no reload', () => {
    const html = renderSection();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Yenile<\/button>/);
  });
});
