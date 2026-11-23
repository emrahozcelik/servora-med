import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { WeeklyReportCreateScreen } from '../src/WeeklyReportCreate';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * Visual/layout fixture for the Weekly Report manager create screen (WR-WEEK).
 *
 * Renders the REAL `WeeklyReportCreateScreen` inside `ServoraAntProvider` against
 * a deterministic synthetic transport so Chromium measures the production form,
 * week selector, deadline preview, single-existing notice, and bulk outcome
 * screen under a fixed `Europe/Istanbul` reference calendar.
 */

const params = new URLSearchParams(window.location.search);
const refMode = params.get('ref') === 'tuesday' ? 'tuesday' : 'friday';
const initialStaff = params.get('initialStaff') === '1';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-20T07:00:00.000Z';

const MANAGER_USER: CurrentUser = {
  id: MANAGER_ID,
  organizationId: ORG_ID,
  name: 'Murat Yönetici',
  email: 'murat.yonetici@servora.test',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: {
    overviewDashboard: true,
    calendar: true,
    messaging: true,
  },
  support: {
    displayLabel: 'Sistem yöneticiniz',
    email: null,
    helpUrl: null,
  },
};

function makeStaffProfile(
  id: string,
  name: string,
  email: string,
  title: string,
  region: string,
) {
  return {
    id: `profile-${id}`,
    user: {
      id,
      organizationId: ORG_ID,
      name,
      email,
      role: 'STAFF' as const,
      mustChangePassword: false,
      isActive: true,
      version: 1,
      lastLoginAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    title,
    phone: '+90 555 000 00 00',
    region,
    managerUserId: MANAGER_ID,
    managerName: MANAGER_USER.name,
    version: 1,
    counters: {
      open: 2,
      waitingApproval: 1,
      revisionRequested: 0,
      completedThisMonth: 4,
      overdue: 0,
    },
  };
}

const STAFF_PROFILES = [
  makeStaffProfile(
    '33333333-3333-4333-8333-333333333301',
    'Ayşe Demir',
    'ayse.demir@servora.test',
    'Kıdemli Dental Saha Uzmanı',
    'Marmara',
  ),
  makeStaffProfile(
    '33333333-3333-4333-8333-333333333302',
    'Mehmet Kaya',
    'mehmet.kaya@servora.test',
    'Medikal Ürün Temsilcisi',
    'Ege',
  ),
  makeStaffProfile(
    '33333333-3333-4333-8333-333333333303',
    'Zeynep Yılmaz',
    'zeynep.yilmaz@servora.test',
    'Klinik Satış Uzmanı',
    'İç Anadolu',
  ),
];

const REFERENCE = refMode === 'tuesday'
  ? {
      timezone: 'Europe/Istanbul',
      today: '2026-11-24',
      periodStart: '2026-11-23',
      periodEnd: '2026-11-28',
      dueDate: '2026-11-30',
    }
  : {
      timezone: 'Europe/Istanbul',
      today: '2026-11-20',
      periodStart: '2026-11-16',
      periodEnd: '2026-11-21',
      dueDate: '2026-11-23',
    };

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

const unexpectedRequests: string[] = [];
const bulkPayloads: unknown[] = [];

Object.assign(window, {
  weeklyCreateUnexpected: unexpectedRequests,
  weeklyCreateBulkPayloads: bulkPayloads,
  weeklyCreateNavigated: null as string | null,
  weeklyCreateCancelled: false,
});

function installTransport() {
  window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (options?.method ?? 'GET').toUpperCase();
    const respond = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });

    if (method === 'GET' && url.pathname === '/api/job-cards/weekly-reports/reference') {
      return respond(REFERENCE);
    }

    if (method === 'GET' && url.pathname === '/api/staff' && url.searchParams.get('status') === 'active') {
      return respond(STAFF_PROFILES);
    }

    if (method === 'POST' && url.pathname === '/api/job-cards/weekly-reports/bulk-request') {
      const body = JSON.parse(String(options?.body ?? '{}')) as {
        periodStart: string;
        staffUserIds: string[];
      };
      bulkPayloads.push(body);
      const periodStart = body.periodStart;
      const periodEnd = addDays(periodStart, 5);
      const mondayDeadline = addDays(periodStart, 7);
      const dueDate = mondayDeadline < REFERENCE.today ? REFERENCE.today : mondayDeadline;

      // Single-target requests model the D8 `existing` outcome; multi-target
      // requests model a mixed created + existing bulk summary.
      const items = body.staffUserIds.length === 1
        ? [{
            staffUserId: body.staffUserIds[0]!,
            jobCardId: '44444444-4444-4444-8444-444444444401',
            reportId: '55555555-5555-4555-8555-555555555501',
            outcome: 'existing' as const,
          }]
        : body.staffUserIds.map((staffUserId, index) => ({
            staffUserId,
            jobCardId: `44444444-4444-4444-8444-44444444441${index + 1}`,
            reportId: `55555555-5555-4555-8555-55555555551${index + 1}`,
            outcome: index < body.staffUserIds.length - 1 ? 'created' as const : 'existing' as const,
          }));

      return respond({
        periodStart,
        periodEnd,
        dueDate,
        items,
      });
    }

    unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
    return respond({ error: `Unexpected fixture request: ${method} ${url.pathname}` }, 404);
  }) as typeof window.fetch;
}

function ReadySignal() {
  useEffect(() => {
    document.documentElement.dataset.weeklyCreateReady = 'true';
  }, []);
  return null;
}

installTransport();

const rootNode = document.getElementById('weekly-create-root');
if (rootNode) {
  createRoot(rootNode).render(
    <ServoraAntProvider>
      <WeeklyReportCreateScreen
        user={MANAGER_USER}
        initialStaffUserId={initialStaff ? STAFF_PROFILES[0]!.user.id : undefined}
        onCancel={() => {
          Object.assign(window, { weeklyCreateCancelled: true });
        }}
        onCreated={(jobCardId) => {
          Object.assign(window, { weeklyCreateNavigated: jobCardId });
        }}
      />
      <ReadySignal />
    </ServoraAntProvider>,
  );
}
