import { createRoot } from 'react-dom/client';
import { WeeklyReportDetail } from '../src/jobs/WeeklyReportDetail';
import { ServoraAntProvider } from '../src/ui/antd';
import { workflowContext } from '../tests/fixtures/job-workflow';
import type { CurrentUser } from '../src/services/api';
import '../src/styles.css';

// Synthetic transport only: no login, production data, writes or realtime socket.
const query = new URLSearchParams(location.search);
const baseline = query.has('baseline');
const role = query.get('role') === 'STAFF' ? 'STAFF' : query.get('role') === 'MANAGER' ? 'MANAGER' : 'ADMIN';
const cancelled = query.get('state') === 'CANCELLED';
const stamp = '2026-11-07T09:00:00.000Z';
const id = '22222222-2222-4222-8222-222222222222';
const reportId = '33333333-3333-4333-8333-333333333333';
const staff = { id: '44444444-4444-4444-8444-444444444444', name: 'Ayşe Örnek' };
const admin = { id: '55555555-5555-4555-8555-555555555555', name: 'Deniz Yönetici' };
const user: CurrentUser = { ...admin, organizationId: 'org-fixture', email: 'admin@example.test',
  role, mustChangePassword: false, isActive: true, version: 1 };
const body = { summary: 'Diş klinikleriyle ürün tanıtım görüşmeleri yapıldı.', nextWeekPlan: 'Klinik takip görüşmeleri planlandı.',
  blockers: null, highlights: 'Ürün katalogları güncellendi.', fieldObservations: null, supportNeeded: null };
const sourceWork = [{ jobCardId: 'source-work-1',type: 'GENERAL_TASK',title: 'Dental ürün katalog takip görevi',
  customerName: null,staffCompletedAt: stamp,statusAtSnapshot: 'COMPLETED' }];
const submissions = cancelled ? [] : [{ id: 'submission-1',organizationId: user.organizationId,
  weeklyReportId: reportId,jobCardId: id,seqNo: 1,submittedBy: staff.id,submittedAt: stamp,
  periodStart: '2026-11-02',periodEnd: '2026-11-08',body,questions: [],answers: [],sourceWork,
  jobVersion: 3,sourceActivityId: 'submit-activity',createdAt: stamp }];
let removed = query.has('removed');
let mutations = 0;
const requests: unknown[] = [];
const unexpected: string[] = [];
Object.assign(window,{ weeklyRemovalRequests: requests,weeklyRemovalUnexpected: unexpected });
const status = () => removed ? 'INVALIDATED' : cancelled ? 'CANCELLED' : 'COMPLETED';
const jobVersion = () => (cancelled ? 2 : 4) + (removed ? 1 : 0);
const reportVersion = () => (cancelled ? 1 : 3) + (removed ? 1 : 0);
const removal = () => removed ? { removedAt: stamp,removedBy: admin.id,reason: 'Yanlış raporlama haftası seçildi.' } : null;
const job = () => ({ id,organizationId: user.organizationId,type: 'WEEKLY_REPORT',status: status(),version: jobVersion(),
  title: 'Haftalık Rapor (2026-11-02 – 2026-11-08)',description: null,customerId: null,contactId: null,
  assignedTo: staff.id,createdBy: staff.id,priority: 'normal',dueDate: '2026-11-09',scheduledAt: null,
  scheduledEndsAt: null,engagementKind: null,assignee: staff,customer: null,contact: null,
  followUpContext: null,followUpProposal: null,submitLocationComparison: null,
  workflowContext: { ...workflowContext,allowedCommands: [],allowedActions: ['VIEW_NOTES'],submissionReadiness: null,
    lifecycle: { ...workflowContext.lifecycle,createdAt: stamp,acceptedAt: stamp,acceptedBy: staff,startedAt: stamp,
      submittedAt: cancelled ? null : stamp,submittedBy: cancelled ? null : staff,
      approvedAt: cancelled ? null : stamp,approvedBy: cancelled ? null : admin,
      cancelledAt: cancelled ? stamp : null,cancelledBy: cancelled ? admin : null,
      cancelledFromStatus: cancelled ? 'ACCEPTED' : null,cancelReason: cancelled ? 'Yanlış hafta.' : null,
      invalidatedAt: removed ? stamp : null,invalidatedBy: removed ? admin : null,
      invalidationReasonCode: removed ? 'CREATED_BY_MISTAKE' : null,
      invalidatedFromStatus: removed ? cancelled ? 'CANCELLED' : 'COMPLETED' : null } } });
const report = () => ({ id: reportId,organizationId: user.organizationId,staffUserId: staff.id,jobCardId: id,
  periodStart: '2026-11-02',periodEnd: '2026-11-08',draft: body,questions: [],answers: [],
  version: reportVersion(),jobVersion: jobVersion(),jobStatus: status(),dueDate: '2026-11-09',assignedTo: staff.id,
  instructions: null,liveSourceWork: [],submissionSummaries: submissions.map(s => ({ seqNo: s.seqNo,submittedAt: s.submittedAt,submittedBy: s.submittedBy })),
  createdAt: stamp,updatedAt: stamp,...(baseline ? {} : { canRemove: role==='ADMIN' && !removed,removal: removal() }) });
window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
  const url = new URL(typeof input==='string' ? input : input instanceof URL ? input.href : input.url,location.origin);
  const path = url.pathname;
  const method = options?.method ?? 'GET';
  const respond = (value: unknown,code = 200) => new Response(JSON.stringify(value),{ status: code,headers: { 'content-type':'application/json' } });
  if (path===`/api/job-cards/${id}/weekly-report/remove` && method==='POST') {
    const request = JSON.parse(String(options?.body));requests.push(request);mutations++;
    if (role!=='ADMIN') return respond({ code:'FORBIDDEN',error:'Bu işlem için yetkiniz bulunmuyor.' },403);
    if (query.get('scenario')==='pending') await new Promise<void>(resolve => {
      Object.assign(window,{ releaseWeeklyRemoval: resolve });
    });
    if (query.get('scenario')==='uncertain' && mutations===1) {
      removed = true;throw new TypeError('Synthetic committed response interruption');
    }
    removed = true;
    return respond(report());
  }
  if (method==='GET' && path===`/api/job-cards/${id}/weekly-report/removal-preview`) return respond({
    jobCardId: id,reportId,staffUserId: staff.id,staffName: staff.name,periodStart: '2026-11-02',periodEnd: '2026-11-08',
    status: status(),expectedVersion: jobVersion(),expectedReportVersion: reportVersion(),submissionCount: submissions.length,
    canRemove: role==='ADMIN' && !removed,removalBlocker:null,removal: removal(),
  });
  if (method==='GET' && path===`/api/job-cards/${id}`) return respond(job());
  if (method==='GET' && path===`/api/job-cards/${id}/weekly-report`) return respond(report());
  if (method==='GET' && path===`/api/job-cards/${id}/weekly-report/submissions`) return respond(submissions);
  if (method==='GET' && path===`/api/job-cards/${id}/activity`) return respond({ items: [],total: 0,limit: 50,offset: 0 });
  unexpected.push(`${method} ${path}`);
  throw new Error(`Unexpected synthetic API request: ${method} ${path}`);
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(<ServoraAntProvider>
  <WeeklyReportDetail jobCardId={id} user={role==='STAFF' ? { ...user,...staff } : user} />
</ServoraAntProvider>);
