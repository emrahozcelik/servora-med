/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '../src/services/api';
import type { Paginated } from '../src/services/crm-api';
import type { WeeklyReportHistoryItem } from '../src/services/people-api';

/**
 * The real API client runs underneath these tests (only `fetch` is stubbed), so
 * the URL, the query string, the strict response parsing and the binary
 * download transport are all exercised for real rather than mocked away.
 */
const realtime = vi.hoisted(() => ({
  latest: null as { keys: string[]; callback: () => void } | null,
}));
const downloads = vi.hoisted(() => ({ saveBlobAs: vi.fn() }));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: (keys: string[], callback: () => void) => {
    realtime.latest = { keys, callback };
  },
}));
vi.mock('../src/services/file-download', () => ({ saveBlobAs: downloads.saveBlobAs }));

import { StaffWeeklyReportHistory } from '../src/StaffProfiles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staffUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@example.test', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
} as CurrentUser;
const managerUser = { ...staffUser, id: 'manager-1', name: 'Murat', role: 'MANAGER' } as CurrentUser;

function item(overrides: Partial<WeeklyReportHistoryItem> = {}): WeeklyReportHistoryItem {
  return {
    reportId: 'report-1', jobCardId: 'job-1', staffUserId: 'staff-1',
    periodStart: '2026-09-21', periodEnd: '2026-09-27', status: 'IN_PROGRESS',
    dueDate: '2026-09-28', submissionCount: 2, latestSubmissionSeqNo: 2,
    latestSubmittedAt: '2026-09-26T09:00:00.000Z', createdAt: '2026-09-21T06:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function page(items: WeeklyReportHistoryItem[], offset = 0, total = items.length): Paginated<WeeklyReportHistoryItem> {
  return { items, total, limit: 20, offset };
}

const OWN_URL = '/api/staff/me/weekly-reports?limit=20&offset=0';
const STAFF_URL = '/api/staff/staff-1/weekly-reports?limit=20&offset=0';
const PAGE_2_URL = '/api/staff/me/weekly-reports?limit=20&offset=20';
const PDF_URL = '/api/job-cards/job-1/weekly-report/submissions/2/pdf';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A PDF response. The body is a plain string on purpose: jsdom's `Blob` is not
 * a valid `BodyInit` for the Node `Response` used by the test environment, and
 * the resulting blob is cross-realm, so assertions read `type`/`size` rather
 * than using `instanceof`.
 */
const pdf = (fileName = 'haftalik-rapor-2026-09-21-seq-2.pdf') =>
  new Response('%PDF-1.4', {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${fileName}"`,
    },
  });

let handlers: Record<string, () => Response>;
let calls: string[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const handler = handlers[url];
    if (!handler) return Promise.resolve(json({ error: 'Bulunamadı.', code: 'NOT_FOUND' }, 404));
    return Promise.resolve(handler());
  }));
}

function pdfCalls() {
  return calls.filter((url) => url.endsWith('/pdf'));
}

describe('StaffWeeklyReportHistory (profile read model)', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    realtime.latest = null;
    handlers = {};
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function flush() {
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  async function render(actor: CurrentUser = managerUser, staffUserId = 'staff-1') {
    stubFetch();
    await act(async () => {
      root.render(
        <MemoryRouter>
          <StaffWeeklyReportHistory actor={actor} staffUserId={staffUserId} />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    await flush();
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
  }

  function click(element: HTMLElement) {
    act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  function alertText(): string {
    return host.querySelector('[role="alert"]')?.textContent ?? '';
  }

  // 1
  it('loads a STAFF owner from the self route, never the profile route', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    await render(staffUser, 'staff-1');
    expect(calls).toEqual([OWN_URL]);
    expect(host.textContent).toContain('2026-09-21 – 2026-09-27');
  });

  // 2
  it('loads another staff member through the encoded profile route for a manager', async () => {
    handlers[STAFF_URL] = () => json(page([item()]));
    await render(managerUser, 'staff-1');
    expect(calls).toEqual([STAFF_URL]);
    expect(calls.some((url) => url.includes('/staff/me/'))).toBe(false);
  });

  // 3
  it('renders the section heading with the authoritative total', async () => {
    handlers[OWN_URL] = () => json(page(
      [item(), item({ reportId: 'report-2', jobCardId: 'job-2' })], 0, 7,
    ));
    await render(staffUser, 'staff-1');
    expect(host.querySelector('#staff-weekly-reports-title')?.textContent).toBe('Haftalık Raporlar');
    expect(host.textContent).toContain('7 kayıt');
  });

  // 4
  it('shows a zero-submission week without any PDF affordance', async () => {
    handlers[OWN_URL] = () => json(page([item({
      submissionCount: 0, latestSubmissionSeqNo: null, latestSubmittedAt: null,
    })]));
    await render(staffUser, 'staff-1');
    expect(host.textContent).toContain('Gönderim yok');
    expect(host.textContent).toContain('PDF yok');
    expect(buttonByText('PDF indir')).toBeUndefined();
  });

  // 5
  it('shows the submission count and an enabled PDF action', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    await render(staffUser, 'staff-1');
    expect(host.textContent).toContain('2 gönderim');
    expect(buttonByText('PDF indir')?.disabled).toBe(false);
  });

  // 6
  it('downloads the latest immutable submission through the binary route', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    handlers[PDF_URL] = () => pdf();
    await render(staffUser, 'staff-1');

    await act(async () => { click(buttonByText('PDF indir')!); await flush(); });

    expect(pdfCalls()).toEqual([PDF_URL]);
    expect(downloads.saveBlobAs).toHaveBeenCalledTimes(1);
    const [blob, fileName] = downloads.saveBlobAs.mock.calls[0]!;
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(0);
    expect(fileName).toBe('haftalik-rapor-2026-09-21-seq-2.pdf');
  });

  // 7
  it('surfaces a download failure and restores the action', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    handlers[PDF_URL] = () => json(
      { error: 'PDF üretilemedi.', code: 'WEEKLY_REPORT_SUBMISSION_NOT_FOUND' }, 404,
    );
    await render(staffUser, 'staff-1');

    await act(async () => { click(buttonByText('PDF indir')!); await flush(); });

    expect(alertText()).toContain('PDF üretilemedi.');
    expect(downloads.saveBlobAs).not.toHaveBeenCalled();
    expect(buttonByText('PDF indir')?.disabled).toBe(false);
  });

  // 8
  it('locks the action while a download is in flight and never double-fires', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    const pending = deferred<Response>();
    handlers[PDF_URL] = () => pending.promise as unknown as Response;
    await render(staffUser, 'staff-1');

    await act(async () => { click(buttonByText('PDF indir')!); await Promise.resolve(); });

    const inFlight = buttonByText('PDF hazırlanıyor…');
    expect(inFlight?.disabled).toBe(true);
    expect(pdfCalls()).toHaveLength(1);

    act(() => { inFlight!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pdfCalls()).toHaveLength(1);

    await act(async () => { pending.resolve(pdf()); await flush(); });
    expect(buttonByText('PDF indir')?.disabled).toBe(false);
  });

  // 9
  it('shows an explicit empty state when the staff member has no reports', async () => {
    handlers[OWN_URL] = () => json(page([], 0, 0));
    await render(staffUser, 'staff-1');
    expect(host.textContent).toContain('Görüntüleyebileceğiniz haftalık rapor bulunmuyor.');
    expect(buttonByText('PDF indir')).toBeUndefined();
  });

  // 10
  it('shows an alert instead of rows for a failed or malformed response', async () => {
    handlers[OWN_URL] = () => json({ error: 'Sunucu hatası.', code: 'INTERNAL_ERROR' }, 500);
    await render(staffUser, 'staff-1');
    expect(alertText()).toContain('Sunucu hatası.');
    expect(host.textContent).not.toContain('2026-09-21 – 2026-09-27');

    // A contract drift (unknown status / extra key) must fail closed as well.
    handlers[OWN_URL] = () => json(page([{ ...item(), status: 'BOGUS' } as unknown as WeeklyReportHistoryItem]));
    await act(async () => { realtime.latest!.callback(); await flush(); });
    expect(alertText()).not.toBe('');
    expect(host.textContent).not.toContain('2026-09-21 – 2026-09-27');
  });

  // 11
  it('refreshes on the staff-profile realtime key', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    await render(staffUser, 'staff-1');
    expect(realtime.latest?.keys).toEqual(['staff-profile:staff-1']);
    expect(calls).toHaveLength(1);

    await act(async () => { realtime.latest!.callback(); await flush(); });
    expect(calls).toEqual([OWN_URL, OWN_URL]);
  });

  // 12
  it('pages forward and back with the bounded page size', async () => {
    handlers[OWN_URL] = () => json(page([item()], 0, 40));
    handlers[PAGE_2_URL] = () => json(page([item({
      reportId: 'report-3', jobCardId: 'job-3',
      periodStart: '2026-09-14', periodEnd: '2026-09-20',
    })], 20, 40));
    await render(staffUser, 'staff-1');

    await act(async () => { click(buttonByText('Daha fazla göster')!); await flush(); });
    expect(calls).toContain(PAGE_2_URL);
    expect(host.textContent).toContain('2026-09-14 – 2026-09-20');

    const previous = buttonByText('Önceki');
    expect(previous?.disabled).toBe(false);
    await act(async () => { click(previous!); await flush(); });
    expect(calls).toEqual([OWN_URL, PAGE_2_URL, OWN_URL]);
  });

  // 13
  it('renders the server-provided due date as a calendar day', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    await render(staffUser, 'staff-1');
    expect(host.textContent).toContain('Teslim son tarihi 28.09.2026');
  });

  // 14
  it('omits the deadline label when the report has no due date', async () => {
    handlers[OWN_URL] = () => json(page([item({ dueDate: null })]));
    await render(staffUser, 'staff-1');
    expect(host.textContent).not.toContain('Termin');
  });

  // 15
  it('renders the completion date once the report has been approved', async () => {
    const approvedAt = '2026-09-29T10:00:00.000Z';
    handlers[OWN_URL] = () => json(page([item({ status: 'COMPLETED', completedAt: approvedAt })]));
    await render(staffUser, 'staff-1');
    // Same formatting expression as the component: this proves the `completedAt`
    // field is rendered, not that the browser can format a date.
    expect(host.textContent).toContain(`Tamamlandı ${new Date(approvedAt).toLocaleDateString('tr-TR')}`);
  });

  // 16
  it('omits the completion date while the report is still open', async () => {
    handlers[OWN_URL] = () => json(page([item()]));
    await render(staffUser, 'staff-1');
    expect(host.textContent).not.toContain('Tamamlandı ');
  });
});
