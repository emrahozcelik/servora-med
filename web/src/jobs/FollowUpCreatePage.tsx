import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import { listStaff, type StaffProfile } from '../services/people-api';
import { LoadingSkeleton, RecordDescriptions, ResultState } from '../ui/antd';
import { counterState } from '../ui/counter-policy';
import { ProgressiveCounter } from '../ui/ProgressiveCounter';
import { JOB_CARD_ENGAGEMENT_LABELS, jobTypeLabels } from './job-labels';
import {
  createFollowUp,
  getJobCard,
  getMeetingDetails,
  JOB_CARD_ENGAGEMENT_KINDS,
  type AvailableSlot,
  type FollowUpCreateInput,
  type JobCard,
  type JobCardEngagementKind,
  type JobCardPriority,
  type JobCardType,
} from './jobs-api';
import {
  CUSTOMERLESS_FOLLOW_UP_EXPLANATION,
  defaultFollowUpTitle,
  defaultFollowUpType,
  FOLLOW_UP_ERROR_MESSAGES,
} from './follow-up-presentation';
import { AvailableSlotsNotice } from './AvailableSlotsNotice';
import {
  defaultScheduledLocalValue,
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './scheduling';
import { CustomerScheduleNotice } from './CustomerScheduleNotice';
import { useAvailableSlotSearch } from './useAvailableSlotSearch';
import { useCustomerSchedulePreview } from './useCustomerSchedulePreview';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; source: JobCard; staff: StaffProfile[] }
  | { kind: 'error'; status: '403' | '404' | 'error'; message: string };

type FieldErrors = Partial<Record<
  'title' | 'followUpInstructions' | 'assignedTo' | 'scheduledAt' | 'type' | 'engagementKind',
  string
>>;

type Attempt = { id: string; fingerprint: string };

function formatDate(value: string | null) {
  if (!value) return 'Belirtilmedi';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function sourceLoadError(error: unknown): Extract<LoadState, { kind: 'error' }> {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return {
      kind: 'error',
      status: String(error.status) as '403' | '404',
      message: error.status === 404
        ? 'Kaynak iş bulunamadı veya bu işe erişiminiz yok.'
        : 'Bu takip işini oluşturma yetkiniz yok.',
    };
  }
  return {
    kind: 'error', status: 'error',
    message: error instanceof Error ? error.message : 'Kaynak iş yüklenemedi.',
  };
}

function errorMessage(error: ApiError) {
  return FOLLOW_UP_ERROR_MESSAGES[error.code] ?? error.message;
}

function payloadFingerprint(input: object) {
  return JSON.stringify(input);
}

export function FollowUpCreatePage({ sourceId, user, onCancel, onCreated }: {
  sourceId: string;
  user: CurrentUser;
  onCancel: () => void;
  onCreated: (jobCardId: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [type, setType] = useState<JobCardType>('GENERAL_TASK');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [priority, setPriority] = useState<JobCardPriority>('normal');
  const [engagementKind, setEngagementKind] = useState<JobCardEngagementKind>('FOLLOW_UP');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [fatalError, setFatalError] = useState<{ status: '403' | '404' | 'error'; message: string } | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const pendingRef = useRef(false);
  const sourceRef = useRef(sourceId);
  const titleInitializedSourceRef = useRef<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sourceRef.current = sourceId;
    setType('GENERAL_TASK');
    setTitle('');
    titleInitializedSourceRef.current = null;
    setInstructions('');
    setScheduledLocal('');
    setDueDate('');
    setAssignedTo('');
    setPriority('normal');
    setEngagementKind('FOLLOW_UP');
    setPending(false);
    setSubmitError('');
    setFieldErrors({});
    setOverrideReason('');
    setFatalError(null);
    attempt.current = null;
    pendingRef.current = false;
  }, [sourceId]);

  useEffect(() => {
    if (user.role === 'STAFF') return;
    let active = true;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const source = await getJobCard(sourceId);
        const [staff, meeting] = await Promise.all([
          listStaff('active'),
          source.type === 'SALES_MEETING'
            ? getMeetingDetails(sourceId).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!active) return;
        const customerless = source.customer === null;
        const initialType = customerless ? 'GENERAL_TASK' : defaultFollowUpType(source.type);
        setType(initialType);
        if (titleInitializedSourceRef.current !== source.id) {
          setTitle(defaultFollowUpTitle(source.title));
          titleInitializedSourceRef.current = source.id;
        }
        setEngagementKind(source.type === 'SALES_MEETING'
          ? source.engagementKind ?? 'FOLLOW_UP' : 'FOLLOW_UP');
        setScheduledLocal(meeting?.nextFollowUpAt
          ? isoInstantToLocalDateTime(meeting.nextFollowUpAt)
          : defaultScheduledLocalValue(new Date()));
        setState({
          kind: 'ready', source,
          staff: staff.filter((profile) => profile.user.isActive),
        });
      } catch (error) {
        if (active) setState(sourceLoadError(error));
      }
    })();
    return () => { active = false; };
  }, [reloadKey, sourceId, user.role]);

  useEffect(() => { if (submitError) errorRef.current?.focus(); }, [submitError]);

  const readySource = state.kind === 'ready' ? state.source : null;
  const { evaluation, previewing } = useCustomerSchedulePreview({
    type,
    customerId: readySource?.customerId ?? null,
    scheduledLocal,
    enabled: state.kind === 'ready' && type !== 'GENERAL_TASK' && readySource?.customerId != null,
  });
  const availableSlotType = type === 'SALES_MEETING' || type === 'PRODUCT_DELIVERY' ? type : null;
  const availableSlotSearch = useAvailableSlotSearch({
    type: availableSlotType ?? 'SALES_MEETING',
    customerId: readySource?.customerId ?? null,
    assignedTo: assignedTo || null,
    scheduledStartLocal: scheduledLocal,
    jobCardId: null,
    enabled: user.capabilities?.calendar === true
      && state.kind === 'ready' && availableSlotType !== null && readySource?.customerId != null,
  });

  function useSuggestedAlternative() {
    if (!evaluation?.suggestedAlternativeAt) return;
    setScheduledLocal(isoInstantToLocalDateTime(evaluation.suggestedAlternativeAt));
  }

  function useAvailableSlot(slot: AvailableSlot) {
    setScheduledLocal(isoInstantToLocalDateTime(slot.startsAt));
  }

  if (user.role === 'STAFF') {
    return <main className="workspace"><ResultState status="403" title="Erişim yetkiniz yok"
      description="Takip işlerini yalnız yöneticiler oluşturabilir." /></main>;
  }
  if (state.kind === 'loading') {
    return <main className="task-create" aria-busy="true"><LoadingSkeleton
      title="Takip işi hazırlanıyor" headingLevel={1} rows={6} /></main>;
  }
  if (state.kind === 'error') {
    return <main className="task-create"><ResultState status={state.status}
      title={state.status === '404' ? 'Kaynak iş bulunamadı' : state.status === '403' ? 'Erişim yetkiniz yok' : 'Takip işi hazırlanamadı'}
      description={state.message}
      action={state.status === 'error'
        ? <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button>
        : <button className="secondary-button" type="button" onClick={onCancel}>İşe dön</button>} />
    </main>;
  }
  if (fatalError) {
    return <main className="task-create"><ResultState status={fatalError.status}
      title={fatalError.status === '403' ? 'Erişim yetkiniz yok' : fatalError.status === '404' ? 'Kaynak iş kullanılamıyor' : 'Takip işi oluşturulamadı'}
      description={fatalError.message}
      action={<button className="secondary-button" type="button" onClick={onCancel}>Kaynak işe dön</button>} />
    </main>;
  }

  const { source, staff } = state;
  if (source.status !== 'COMPLETED') {
    return <main className="task-create"><ResultState status="error"
      title="Takip işi oluşturulamaz"
      description="Yalnız tamamlanmış bir işten yeni takip işi oluşturulabilir."
      action={<button className="secondary-button" type="button" onClick={onCancel}>Kaynak işe dön</button>} />
    </main>;
  }

  const customerless = source.customer === null;
  const instructionCount = codePointLength(instructions);

  function changeType(nextType: JobCardType) {
    if (customerless && nextType !== 'GENERAL_TASK') return;
    setType(nextType);
    setFieldErrors((current) => ({ ...current, type: undefined, scheduledAt: undefined, engagementKind: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    const nextErrors: FieldErrors = {};
    if (!title.trim()) nextErrors.title = 'Başlık zorunludur.';
    if (!instructions.trim()) nextErrors.followUpInstructions = 'Yeni takip işinin kapsamını yazın.';
    else if (instructionCount > 4_000) nextErrors.followUpInstructions = 'Takip kapsamı en fazla 4000 karakter olabilir.';
    if (!assignedTo) nextErrors.assignedTo = 'Sorumlu personel seçin.';
    if (type !== 'GENERAL_TASK' && !scheduledLocal) nextErrors.scheduledAt = 'Planlanan zamanı seçin.';
    if (type === 'SALES_MEETING' && !engagementKind) nextErrors.engagementKind = 'Görüşme türünü seçin.';
    if (customerless && type !== 'GENERAL_TASK') nextErrors.type = CUSTOMERLESS_FOLLOW_UP_EXPLANATION;
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setSubmitError('Formdaki işaretli alanları kontrol edin.');
      return;
    }

    const base = {
      type,
      title: title.trim(),
      followUpInstructions: instructions.trim(),
      scheduledAt: scheduledLocal ? localDateTimeToIso(scheduledLocal) : null,
      assignedTo,
      priority,
      dueDate: type === 'SALES_MEETING' ? null : dueDate || null,
      contactId: null,
      ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
      ...(type === 'SALES_MEETING' ? { engagementKind } : {}),
    };
    const fingerprint = payloadFingerprint(base);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { id: crypto.randomUUID(), fingerprint };
    }
    pendingRef.current = true;
    setPending(true);
    setFieldErrors({});
    setSubmitError('');
    try {
      const requestSourceId = sourceId;
      const input: FollowUpCreateInput = type === 'SALES_MEETING'
        ? { ...base, type, engagementKind, clientActionId: attempt.current.id }
        : { ...base, type, clientActionId: attempt.current.id };
      const created = await createFollowUp(requestSourceId, input);
      if (sourceRef.current !== requestSourceId) return;
      attempt.current = null;
      onCreated(created.id);
    } catch (error) {
      if (sourceRef.current !== sourceId) return;
      const apiError = error instanceof ApiError ? error : null;
      const preserveAttempt = apiError?.status === 0
        || apiError?.retryable
        || apiError?.code === 'ACTION_IN_PROGRESS';
      if (!preserveAttempt) attempt.current = null;
      if (apiError?.status === 403 || apiError?.code === 'FORBIDDEN') {
        setFatalError({ status: '403', message: 'Takip işi oluşturma yetkiniz artık bulunmuyor.' });
      } else if (apiError?.code === 'JOB_CARD_NOT_FOUND') {
        setFatalError({ status: '404', message: 'Kaynak iş artık kullanılamıyor.' });
      } else if (apiError?.code === 'CUSTOMER_NOT_FOUND') {
        setFatalError({ status: 'error', message: 'Kaynak işin müşteri kaydı artık kullanılamıyor.' });
      } else if (apiError?.code === 'FOLLOW_UP_SOURCE_NOT_COMPLETED'
        || apiError?.code === 'FOLLOW_UP_MAX_DEPTH_REACHED') {
        setFatalError({ status: 'error', message: errorMessage(apiError) });
      } else if (apiError?.code === 'FOLLOW_UP_INSTRUCTIONS_REQUIRED') {
        setFieldErrors({ followUpInstructions: errorMessage(apiError) });
        setSubmitError('Takip kapsamını kontrol edin.');
      } else if (apiError?.code === 'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED') {
        setType('GENERAL_TASK');
        setFieldErrors({ type: CUSTOMERLESS_FOLLOW_UP_EXPLANATION });
        setSubmitError(CUSTOMERLESS_FOLLOW_UP_EXPLANATION);
      } else if (apiError?.code === 'ASSIGNEE_NOT_FOUND') {
        setFieldErrors({ assignedTo: 'Seçilen personel artık kullanılamıyor.' });
        setSubmitError('Sorumlu personeli kontrol edin.');
      } else {
        setSubmitError(apiError ? errorMessage(apiError) : 'Takip işi oluşturulamadı. Tekrar deneyin.');
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return <main className="task-create follow-up-create" data-follow-up-create="true">
    <div className="create-heading"><div><p className="eyebrow">Yeni kayıt</p><h1>Takip işi oluştur</h1></div></div>
    <section className="follow-up-source-summary follow-up-create-source-summary" aria-labelledby="follow-up-create-source-title">
      <h2 id="follow-up-create-source-title" className="follow-up-create-source-heading">Kaynak iş</h2>
      <p className="follow-up-create-source-job-title">{source.title}</p>
      <RecordDescriptions ariaLabel="Kaynak iş özeti" items={[
        { key: 'type', label: 'İş türü', content: jobTypeLabels[source.type] },
        { key: 'customer', label: 'Müşteri', content: source.customer?.name ?? 'Müşteri bağlantısı yok' },
        { key: 'assignee', label: 'Sorumlu personel', content: source.assignee?.name ?? 'Belirtilmedi' },
        { key: 'completed', label: 'Tamamlanma tarihi', content: formatDate(source.workflowContext.lifecycle.approvedAt) },
      ]} />
    </section>
    {submitError && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{submitError}</div>}
    <form className="task-form follow-up-form" onSubmit={submit} noValidate>
      <fieldset disabled={pending}>
        <section className="follow-up-form-section" data-follow-up-section="task" aria-labelledby="follow-up-task-heading">
          <div className="follow-up-form-section-heading">
            <h2 id="follow-up-task-heading">Takip işi</h2>
            <p>Yeni işin amacını, başlığını ve kapsamını tanımlayın.</p>
          </div>
          <div className="field-group"><label htmlFor="follow-up-type">İş türü</label>
            <select id="follow-up-type" value={type} aria-invalid={fieldErrors.type ? true : undefined}
              aria-describedby={customerless ? 'follow-up-type-help' : fieldErrors.type ? 'follow-up-type-error' : undefined}
              onChange={(event) => changeType(event.target.value as JobCardType)}>
              <option value="GENERAL_TASK">Genel görev</option>
              <option value="PRODUCT_DELIVERY" disabled={customerless}>Ürün teslimi</option>
              <option value="SALES_MEETING" disabled={customerless}>Satış görüşmesi</option>
            </select>
            {customerless && <p id="follow-up-type-help" className="form-help">{CUSTOMERLESS_FOLLOW_UP_EXPLANATION}</p>}
            {fieldErrors.type && !customerless && <span id="follow-up-type-error" className="field-error">{fieldErrors.type}</span>}
          </div>
          <div className="field-group"><label htmlFor="follow-up-title">Başlık</label>
            <input id="follow-up-title" required maxLength={255} value={title}
              aria-invalid={fieldErrors.title ? true : undefined}
              aria-describedby={fieldErrors.title ? 'follow-up-title-error' : undefined}
              onChange={(event) => setTitle(event.target.value)} />
            {fieldErrors.title && <span id="follow-up-title-error" className="field-error">{fieldErrors.title}</span>}
          </div>
          <div className="field-group"><label htmlFor="follow-up-instructions">Yeni takip işinin kapsamı / talimatları <span aria-hidden="true">*</span></label>
            <textarea id="follow-up-instructions" required rows={6} value={instructions}
              aria-invalid={fieldErrors.followUpInstructions ? true : undefined}
              aria-describedby={[
                'follow-up-instructions-help',
                counterState(4000 - instructionCount) !== 'hidden' ? 'follow-up-instructions-count' : null,
                fieldErrors.followUpInstructions ? 'follow-up-instructions-error' : null,
              ].filter(Boolean).join(' ')}
              onChange={(event) => setInstructions(event.target.value)} />
            <p id="follow-up-instructions-help" className="form-help">Bu alan yeni görevin kapsamıdır. Önceki işin operasyon notları otomatik olarak kopyalanmaz.</p>
            <ProgressiveCounter
              remaining={4000 - instructionCount}
              dataCounter="follow-up-instructions"
            >{instructionCount}/4000 karakter</ProgressiveCounter>
            {fieldErrors.followUpInstructions && <span id="follow-up-instructions-error" className="field-error">{fieldErrors.followUpInstructions}</span>}
          </div>
        </section>
        <section className="follow-up-form-section" data-follow-up-section="assignment" aria-labelledby="follow-up-assignment-heading">
          <div className="follow-up-form-section-heading">
            <h2 id="follow-up-assignment-heading">Atama</h2>
            <p>Kaynak işten gelen müşteri bağlamını koruyup sorumlu kişiyi belirleyin.</p>
          </div>
          <div className="follow-up-customer-context" data-follow-up-customer-readonly>
            <span className="field-label">Müşteri</span>
            <p className="fixed-field-value">{source.customer?.name ?? 'Müşteri bağlantısı yok'}</p>
            <p className="form-help">Müşteri kaynak işten alınır ve bu sayfada değiştirilemez.</p>
          </div>
          <div className="task-field-pair">
            <div className="field-group"><label htmlFor="follow-up-assignee">Sorumlu personel</label>
              <select id="follow-up-assignee" required value={assignedTo}
                aria-invalid={fieldErrors.assignedTo ? true : undefined}
                aria-describedby={fieldErrors.assignedTo ? 'follow-up-assignee-error' : undefined}
                onChange={(event) => setAssignedTo(event.target.value)}>
                <option value="">Seçin</option>{staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
              </select>
              {fieldErrors.assignedTo && <span id="follow-up-assignee-error" className="field-error">{fieldErrors.assignedTo}</span>}
            </div>
            <div className="field-group"><label htmlFor="follow-up-priority">Öncelik</label>
              <select id="follow-up-priority" value={priority} onChange={(event) => setPriority(event.target.value as JobCardPriority)}>
                <option value="low">Düşük</option><option value="normal">Normal</option><option value="high">Yüksek</option><option value="urgent">Acil</option>
              </select>
            </div>
          </div>
          {type === 'SALES_MEETING' && <div className="field-group"><label htmlFor="follow-up-engagement-kind">Görüşme / ziyaret türü</label>
            <select id="follow-up-engagement-kind" required value={engagementKind}
              aria-invalid={fieldErrors.engagementKind ? true : undefined}
              onChange={(event) => setEngagementKind(event.target.value as JobCardEngagementKind)}>
              {JOB_CARD_ENGAGEMENT_KINDS.map((kind) => <option key={kind} value={kind}>{JOB_CARD_ENGAGEMENT_LABELS[kind]}</option>)}
            </select>
            {fieldErrors.engagementKind && <span className="field-error">{fieldErrors.engagementKind}</span>}
          </div>}
        </section>
        <section className="follow-up-form-section" data-follow-up-section="planning" aria-labelledby="follow-up-planning-heading">
          <div className="follow-up-form-section-heading">
            <h2 id="follow-up-planning-heading">Planlama</h2>
            <p>Zamanı belirleyin ve müşteri-personel ortak uygunluğunu gözden geçirin.</p>
          </div>
          <div className="task-field-pair">
            <div className="field-group"><label htmlFor="follow-up-scheduled-at">Planlanan zaman{type === 'GENERAL_TASK' ? ' (isteğe bağlı)' : ''}</label>
              <input id="follow-up-scheduled-at" type="datetime-local" required={type !== 'GENERAL_TASK'} value={scheduledLocal}
                aria-invalid={fieldErrors.scheduledAt ? true : undefined}
                aria-describedby={fieldErrors.scheduledAt ? 'follow-up-scheduled-at-error' : undefined}
                onChange={(event) => setScheduledLocal(event.target.value)} />
              {fieldErrors.scheduledAt && <span id="follow-up-scheduled-at-error" className="field-error">{fieldErrors.scheduledAt}</span>}
            </div>
            {type !== 'SALES_MEETING' && <div className="field-group"><label htmlFor="follow-up-due-date">Son tarih (isteğe bağlı)</label>
              <input id="follow-up-due-date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </div>}
          </div>
          <CustomerScheduleNotice
            evaluation={evaluation}
            mode="manager"
            overrideReason={overrideReason}
            onOverrideReasonChange={setOverrideReason}
            onUseSuggestedAlternative={useSuggestedAlternative}
          />
          {previewing && <p className="field-status" role="status">Müşteri planı kontrol ediliyor…</p>}
          <AvailableSlotsNotice
            {...availableSlotSearch}
            onSelect={useAvailableSlot}
          />
        </section>
      </fieldset>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
        <button className="primary-button" type="submit" disabled={pending}>{pending ? 'Oluşturuluyor…' : 'Takip işini oluştur'}</button>
      </div>
    </form>
  </main>;
}
