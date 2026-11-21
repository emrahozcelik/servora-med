import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { OpenSubmissionLateSection, OverdueIncidentHistorySection } from '../src/jobs/SubmissionLateness';
import type { OpenSubmissionLateItem, OverdueIncidentHistoryItem } from '../src/jobs/jobs-api';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import '../src/styles.css';

// Synthetic presentation fixture for the real React components and production CSS.
// No production API, authentication or business mutation is exercised here.
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
const scenario = new URLSearchParams(location.search).get('kind') ?? 'open';
let openLoads = 0;
let historyLoads = 0;
const empty = scenario.endsWith('-empty');
const delayed = new URLSearchParams(location.search).get('delay') === '120';
// Explicit paging stress response; no backend or persisted history is mutated.
const shrinkOnLastPage = new URLSearchParams(location.search).get('shrink') === '7';
let shrunk = false;
const fixedTime = Date.parse('2026-11-17T09:00:00.000Z');
const daySeconds = 86400;
const instant = (milliseconds: number) => new Date(milliseconds).toISOString();

const openItems: OpenSubmissionLateItem[] = Array.from({ length: empty ? 0 : 13 }, (_, i) => ({
  jobCardId: `visual-job-${i + 1}`,
  jobTitle: i === 0
    ? 'Ataşehir bölgesi klinik ziyaret turu ve ürün tanıtım planı hazırlığı çalışması'
    : `Dental Klinik ${i + 1} — geciken iş`,
  episodeNo: i + 1,
  // Open-late API sorts by longest overdue first; durations agree with the fixed clock.
  deadlineAt: instant(fixedTime - daySeconds * (13 - i) * 1000),
  breachedAt: instant(fixedTime - daySeconds * (13 - i) * 1000),
  elapsedSeconds: daySeconds * (13 - i),
  staff: { id: 'visual-staff', name: 'Örnek Personel' },
  customer: { id: 'visual-customer', name: 'Örnek Ağız ve Diş Sağlığı Merkezi' },
  jobPath: `/jobs/visual-job-${i + 1}`,
}));

const historyItems: OverdueIncidentHistoryItem[] = Array.from({ length: empty ? 0 : 13 }, (_, i) => ({
  id: `incident-${i + 1}`,
  delayType: (['LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT'] as const)[i % 3]!,
  episodeNo: i + 1,
  scheduleRevisionNo: 1,
  deadlineAt: instant(fixedTime - daySeconds * (26 - 2 * i) * 1000),
  breachedAt: instant(fixedTime - daySeconds * (26 - 2 * i) * 1000),
  accountableRole: i % 3 === 2 ? 'MANAGEMENT' : 'STAFF',
  accountableSource: i % 3 === 2 ? 'ROLE_POLICY' : 'ASSIGNMENT_AT_BREACH',
  accountableUser: i % 3 === 2 ? null : { id: 'visual-staff', name: 'Örnek Personel' },
  source: 'SCANNER',
  recordedAt: instant(fixedTime - daySeconds * (26 - 2 * i) * 1000 + 60000),
  recoveredAt: i % 2 === 0 ? instant(fixedTime - daySeconds * (25 - 2 * i) * 1000) : null,
  recoveryActor: null,
  endedAt: null,
  endedBy: null,
  endReason: null,
  endNote: null,
  endedByScheduleRevisionNo: null,
  endedDurationSeconds: null,
  totalDelaySeconds: i % 2 === 0 ? daySeconds : null,
  manualReminderSentAt: null,
  manualReminderCount: 0,
  postReminderDelaySeconds: null,
}));
// Match the history API's breached_at DESC ordering before selecting a page.
historyItems.reverse();
document.documentElement.dataset.overdueHistoryBreaches = JSON.stringify(historyItems.map(item => item.breachedAt));

const loadOpen: typeof import('../src/jobs/jobs-api').listOpenSubmissionLate = async (page = {}) => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 6;
  document.documentElement.dataset.overdueLimit = String(limit);
  document.documentElement.dataset.overdueOffset = String(offset);
  if (scenario === 'open-retry' && openLoads++ === 0) throw new Error('Sentetik bağlantı hatası');
  if (delayed) await new Promise(resolve => setTimeout(resolve, 120));
  if (shrinkOnLastPage && offset === 12) shrunk = true;
  const items = shrunk ? openItems.slice(0, 7) : openItems;
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
};
const loadHistory: typeof import('../src/jobs/jobs-api').listOverdueIncidents = async (_jobId, page = {}) => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 6;
  document.documentElement.dataset.overdueLimit = String(limit);
  document.documentElement.dataset.overdueOffset = String(offset);
  if (scenario === 'history-retry' && historyLoads++ === 0) throw new Error('Sentetik bağlantı hatası');
  if (delayed) await new Promise(resolve => setTimeout(resolve, 120));
  if (shrinkOnLastPage && offset === 12) shrunk = true;
  const items = shrunk ? historyItems.slice(0, 7) : historyItems;
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
};

createRoot(document.getElementById('root')!).render(
  <ServoraAntProvider>
    <MemoryRouter>
      <RealtimeProvider>
        <main className="app-main" style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
          <h1>Gecikme görünümü — sentetik test</h1>
          {scenario.startsWith('history')
            ? <OverdueIncidentHistorySection jobId="visual-job" load={loadHistory} />
            : <OpenSubmissionLateSection load={loadOpen} />}
        </main>
      </RealtimeProvider>
    </MemoryRouter>
  </ServoraAntProvider>,
);
