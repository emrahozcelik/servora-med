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

const openItems: OpenSubmissionLateItem[] = Array.from({ length: empty ? 0 : 13 }, (_, i) => ({
  jobCardId: `visual-job-${i + 1}`,
  jobTitle: i === 0
    ? 'Ataşehir bölgesi klinik ziyaret turu ve ürün tanıtım planı hazırlığı çalışması'
    : `Dental Klinik ${i + 1} — geciken iş`,
  episodeNo: i + 1,
  deadlineAt: '2026-11-05T08:00:00.000Z',
  breachedAt: '2026-11-05T08:00:00.000Z',
  elapsedSeconds: 86400 * (i + 1),
  staff: { id: 'visual-staff', name: 'Örnek Personel' },
  customer: { id: 'visual-customer', name: 'Örnek Ağız ve Diş Sağlığı Merkezi' },
  jobPath: `/jobs/visual-job-${i + 1}`,
}));

const historyItems: OverdueIncidentHistoryItem[] = Array.from({ length: empty ? 0 : 13 }, (_, i) => ({
  id: `incident-${i + 1}`,
  delayType: (['LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT'] as const)[i % 3],
  episodeNo: i + 1,
  scheduleRevisionNo: 1,
  deadlineAt: '2026-11-05T08:00:00.000Z',
  breachedAt: '2026-11-05T08:00:00.000Z',
  accountableRole: 'STAFF',
  accountableSource: 'ASSIGNMENT_AT_BREACH',
  accountableUser: { id: 'visual-staff', name: 'Örnek Personel' },
  source: 'SCANNER',
  recordedAt: '2026-11-05T08:01:00.000Z',
  recoveredAt: i % 2 === 0 ? '2026-11-06T08:00:00.000Z' : null,
  recoveryActor: null,
  totalDelaySeconds: i % 2 === 0 ? 86400 : null,
  manualReminderSentAt: null,
  manualReminderCount: 0,
  postReminderDelaySeconds: null,
}));

const loadOpen: typeof import('../src/jobs/jobs-api').listOpenSubmissionLate = async (page = {}) => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 6;
  document.documentElement.dataset.overdueLimit = String(limit);
  document.documentElement.dataset.overdueOffset = String(offset);
  if (scenario === 'open-retry' && openLoads++ === 0) throw new Error('Sentetik bağlantı hatası');
  return { items: openItems.slice(offset, offset + limit), total: openItems.length, limit, offset };
};
const loadHistory: typeof import('../src/jobs/jobs-api').listOverdueIncidents = async (_jobId, page = {}) => {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 6;
  document.documentElement.dataset.overdueLimit = String(limit);
  document.documentElement.dataset.overdueOffset = String(offset);
  if (scenario === 'history-retry' && historyLoads++ === 0) throw new Error('Sentetik bağlantı hatası');
  return { items: historyItems.slice(offset, offset + limit), total: historyItems.length, limit, offset };
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
