import { useEffect, useState, type FormEvent } from 'react';

import {
  ApiError,
  approveJobCard,
  getJobCard,
  listActivity,
  listDeliveryItems,
  requestJobCardRevision,
  startJobCard,
  submitJobCardForApproval,
  type Activity,
  type CurrentUser,
  type DeliveryItem,
  type JobCard,
} from './services/api';

type StaffCommand = 'start' | 'submit';
type CommandDependencies = {
  start: typeof startJobCard;
  submit: typeof submitJobCardForApproval;
  refresh: typeof getJobCard;
  createActionId: () => string;
};
const commandDependencies: CommandDependencies = {
  start: startJobCard, submit: submitJobCardForApproval, refresh: getJobCard,
  createActionId: () => crypto.randomUUID(),
};

export async function runStaffJobCommand(job: JobCard, command: StaffCommand, dependencies: CommandDependencies = commandDependencies) {
  const input = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'start'
      ? await dependencies.start(job.id, input)
      : await dependencies.submit(job.id, input);
    return { kind: 'success' as const, job: updated };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict' as const, job: await dependencies.refresh(job.id) };
    }
    throw error;
  }
}

type ManagerCommand = 'approve' | 'revise';
type ManagerCommandDependencies = {
  approve: typeof approveJobCard;
  revise: typeof requestJobCardRevision;
  refresh: typeof getJobCard;
  createActionId: () => string;
};
const managerCommandDependencies: ManagerCommandDependencies = {
  approve: approveJobCard, revise: requestJobCardRevision, refresh: getJobCard,
  createActionId: () => crypto.randomUUID(),
};

export async function runManagerJobCommand(job: JobCard, command: ManagerCommand, revisionReason: string, dependencies: ManagerCommandDependencies = managerCommandDependencies) {
  const base = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'approve'
      ? await dependencies.approve(job.id, base)
      : await dependencies.revise(job.id, { ...base, revisionReason: revisionReason.trim() });
    return { kind: 'success' as const, job: updated };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict' as const, job: await dependencies.refresh(job.id) };
    }
    throw error;
  }
}

const purposeLabels = { SALE: 'Satış', SAMPLE: 'Numune', CONSIGNMENT: 'Konsinye', RETURN: 'İade', OTHER: 'Diğer' } as const;
const statusLabels = { NEW: 'Yeni', PLANNED: 'Planlandı', IN_PROGRESS: 'Devam ediyor', WAITING_APPROVAL: 'Onay bekliyor', REVISION_REQUESTED: 'Düzeltme istendi', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal edildi' } as const;
const activityLabels: Record<string, string> = {
  JOB_CREATED: 'İş oluşturuldu', DELIVERY_ITEM_ADDED: 'Teslim ürünü eklendi', JOB_STARTED: 'İş başlatıldı',
  JOB_SUBMITTED_FOR_APPROVAL: 'Onaya gönderildi', JOB_APPROVED: 'Yönetici onayladı', JOB_REVISION_REQUESTED: 'Düzeltme istendi',
};

export function ManagerReviewActions({ activities, pending, revisionOpen, onApprove, onOpenRevision, onCancelRevision, onRequestRevision }: {
  activities: Activity[]; pending: boolean; revisionOpen: boolean;
  onApprove: () => void; onOpenRevision: () => void; onCancelRevision: () => void; onRequestRevision: (reason: string) => void;
}) {
  function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('revisionReason') ?? '');
    onRequestRevision(reason);
  }
  return <>
    <section className="activity-timeline" aria-labelledby="activity-title"><h2 id="activity-title">İşlem geçmişi</h2>
      <ol>{activities.map((activity) => <li key={activity.id}><span>{activityLabels[activity.eventType] ?? activity.eventType}</span>
        <time dateTime={activity.createdAt}>{new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(activity.createdAt))}</time></li>)}</ol></section>
    <section className="manager-review" aria-labelledby="review-title"><h2 id="review-title">Yönetici kararı</h2>
      {!revisionOpen ? <div className="review-buttons"><button className="secondary-button" type="button" disabled={pending} onClick={onOpenRevision}>Düzeltme iste</button>
        <button className="primary-button compact-button" type="button" disabled={pending} onClick={onApprove}>{pending ? 'İşleniyor…' : 'Onayla'}</button></div>
        : <form className="revision-form" onSubmit={submitRevision}><div className="field-group"><label htmlFor="revision-reason">Düzeltme nedeni</label>
          <textarea id="revision-reason" name="revisionReason" rows={3} required disabled={pending} aria-describedby="revision-help" /></div>
          <p className="form-help" id="revision-help">Personelin neyi düzeltmesi gerektiğini açıkça belirtin.</p>
          <div className="review-buttons"><button className="secondary-button" type="button" onClick={onCancelRevision} disabled={pending}>Vazgeç</button>
            <button className="primary-button compact-button" type="submit" disabled={pending}>{pending ? 'Gönderiliyor…' : 'Düzeltme talebini gönder'}</button></div></form>}
    </section>
  </>;
}

export function JobDetailPanel({ job, items, activities = [], viewerRole = 'STAFF', pending, message, messageIsError = false, revisionOpen = false,
  onBack, onCommand, onApprove = () => {}, onOpenRevision = () => {}, onCancelRevision = () => {}, onRequestRevision = () => {} }: {
  job: JobCard; items: DeliveryItem[]; pending: boolean; message: string; messageIsError?: boolean;
  activities?: Activity[]; viewerRole?: CurrentUser['role']; revisionOpen?: boolean;
  onBack: () => void; onCommand: (command: StaffCommand) => void; onApprove?: () => void;
  onOpenRevision?: () => void; onCancelRevision?: () => void; onRequestRevision?: (reason: string) => void;
}) {
  const command = viewerRole === 'STAFF' ? (job.status === 'NEW' || job.status === 'PLANNED' ? 'start' : job.status === 'IN_PROGRESS' ? 'submit' : null) : null;
  return <main className="job-detail">
    <div className="detail-heading"><div><p className="eyebrow">Ürün teslimi</p><h1>{job.title}</h1></div>
      <button className="secondary-button" type="button" onClick={onBack} disabled={pending}>Listeye dön</button></div>
    {message && <div className={`detail-feedback${messageIsError ? ' detail-feedback-error' : ''}`} role={messageIsError ? 'alert' : 'status'}>{message}</div>}
    <dl className="detail-summary"><div><dt>Durum</dt><dd>{statusLabels[job.status]}</dd></div><div><dt>Kayıt sürümü</dt><dd>Sürüm {job.version}</dd></div></dl>
    <section className="delivery-lines" aria-labelledby="delivery-lines-title"><h2 id="delivery-lines-title">Teslim bilgileri</h2>
      <ul>{items.map((item) => <li key={item.id}><div><strong>{item.productNameSnapshot}</strong><span>{item.productSkuSnapshot ?? 'SKU belirtilmedi'}</span></div>
        <dl><div><dt>Amaç</dt><dd>{purposeLabels[item.deliveryPurpose]}</dd></div><div><dt>Miktar</dt><dd>{item.quantity} {item.unit}</dd></div>
          <div><dt>Teslim zamanı</dt><dd>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.deliveredAt))}</dd></div></dl></li>)}</ul>
    </section>
    {command && <div className="detail-action"><p>{command === 'start' ? 'Teslim çalışmasına başladığınızda kart devam ediyor durumuna geçer.' : 'Bilgileri kontrol edin. Gönderimden sonra ticari alanlar yönetici incelemesi boyunca kilitlenir.'}</p>
      <button className="primary-button compact-button" type="button" disabled={pending} onClick={() => onCommand(command)}>
        {pending ? 'İşleniyor…' : command === 'start' ? 'İşi başlat' : 'Onaya gönder'}</button></div>}
    {job.status === 'WAITING_APPROVAL' && viewerRole === 'STAFF' && <div className="workspace-message" role="status"><h2>Yönetici onayı bekleniyor</h2><p>Teslim bilgileri inceleme tamamlanana kadar değiştirilemez.</p></div>}
    {job.status === 'WAITING_APPROVAL' && viewerRole !== 'STAFF' && <ManagerReviewActions activities={activities} pending={pending} revisionOpen={revisionOpen}
      onApprove={onApprove} onOpenRevision={onOpenRevision} onCancelRevision={onCancelRevision} onRequestRevision={onRequestRevision} />}
  </main>;
}

type DetailState = { kind: 'loading' } | { kind: 'ready'; job: JobCard; items: DeliveryItem[]; activities: Activity[] } | { kind: 'error'; message: string; retryable: boolean };

export function JobDetailScreen({ jobId, user, onBack, onChanged }: { jobId: string; user: CurrentUser; onBack: () => void; onChanged: () => void }) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [revisionOpen, setRevisionOpen] = useState(false);
  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    Promise.all([getJobCard(jobId), listDeliveryItems(jobId), listActivity(jobId)])
      .then(([job, items, activities]) => { if (active) setState({ kind: 'ready', job, items, activities }); })
      .catch((error) => { if (active) setState({ kind: 'error', message: error instanceof Error ? error.message : 'İş yüklenemedi.', retryable: error instanceof ApiError ? error.retryable : true }); });
    return () => { active = false; };
  }, [jobId, reloadKey]);
  if (state.kind === 'loading') return <main className="job-detail" aria-busy="true"><p>İş detayları yükleniyor</p></main>;
  if (state.kind === 'error') return <main className="job-detail"><div className="workspace-message" role="alert"><h1>İş yüklenemedi</h1><p>{state.message}</p>
    {state.retryable && <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button>}</div></main>;
  async function command(commandName: StaffCommand) {
    if (state.kind !== 'ready') return;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      const result = await runStaffJobCommand(state.job, commandName);
      setState({ ...state, job: result.job });
      setMessage(result.kind === 'conflict' ? 'Bu iş başka bir cihazda güncellendi. En güncel durum gösteriliyor.' : commandName === 'start' ? 'İş başlatıldı.' : 'İş yönetici onayına gönderildi.');
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'İşlem tamamlanamadı.'); setMessageIsError(true); }
    finally { setPending(false); }
  }
  async function managerCommand(commandName: ManagerCommand, reason = '') {
    if (state.kind !== 'ready') return;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      const result = await runManagerJobCommand(state.job, commandName, reason);
      const activities = result.kind === 'success' ? await listActivity(jobId) : state.activities;
      setState({ ...state, job: result.job, activities });
      setRevisionOpen(false);
      setMessage(result.kind === 'conflict' ? 'Bu iş başka bir cihazda güncellendi. En güncel durum gösteriliyor.' : commandName === 'approve' ? 'İş onaylandı.' : 'İş düzeltme için personele gönderildi.');
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'İşlem tamamlanamadı.'); setMessageIsError(true); }
    finally { setPending(false); }
  }
  return <JobDetailPanel job={state.job} items={state.items} activities={state.activities} viewerRole={user.role} pending={pending}
    message={message} messageIsError={messageIsError} revisionOpen={revisionOpen} onBack={onBack} onCommand={(value) => void command(value)}
    onApprove={() => void managerCommand('approve')} onOpenRevision={() => setRevisionOpen(true)} onCancelRevision={() => setRevisionOpen(false)}
    onRequestRevision={(reason) => void managerCommand('revise', reason)} />;
}
