import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ApiError } from '../services/api';
import { listStaff, type StaffProfile } from '../services/people-api';
import { ReasonDialog } from '../ui/antd/ReasonDialog';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { SignalGlyph } from '../ui/signal-icons';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';
import { apiFieldError } from './api-field-error';
import {
  buildPatchCommitReceipt,
  filterEligibleTransferStaff,
  plannedIntervalDurationMinutes,
} from './assignment-transfer-helpers';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import { AvailableSlotsNotice } from './AvailableSlotsNotice';
import {
  PastStartAcknowledgementDrawer,
  isPastStartAcknowledgementRequired,
} from './PastStartAcknowledgementDrawer';
import { ScheduleQuickControls } from './ScheduleQuickControls';
import {
  defaultScheduledLocalValue,
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './scheduling';
import {
  pastStartAcknowledgementPayload,
  type JobCard,
  type PastStartAcknowledgement,
  type PatchJobCardInput,
} from './jobs-api';
import { useAvailableSlotSearch } from './useAvailableSlotSearch';

type TransferPanel = 'closed' | 'transfer' | 'reason' | 'acknowledgement';
type StaffLoad = { kind: 'loading' | 'error' } | { kind: 'ready'; staff: StaffProfile[] };
type FieldErrors = { staff?: string; time?: string };

const TRANSFER_LABEL = 'Personeli ve zamanı birlikte değiştir';
const TRANSFER_ERROR = 'Personel ve plan değişikliği kaydedilemedi.';
const REASON_REQUIRED = 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.';
const STALE = 'İş başka bir işlemle güncellendi. Devam etmek için güncel bilgileri inceleyip formu yeniden açın.';

export type CommitAssignmentTransfer = (
  input: PatchJobCardInput, onConfirmed: (patched: JobCard) => string,
) => Promise<void>;
export type RenderAssignmentTransfer = (options: { disabled: boolean; primary: boolean }) => ReactNode;

export function AssignmentTransferAction({
  job, disabled, primary, onTransfer, onRefresh,
}: {
  job: JobCard;
  disabled: boolean;
  primary: boolean;
  onTransfer: CommitAssignmentTransfer;
  onRefresh: () => Promise<boolean>;
}) {
  const [panel, setPanel] = useState<TransferPanel>('closed');
  const [overlayHost, setOverlayHost] = useState<Element | null>(null);
  const [reviewedJob, setReviewedJob] = useState(job);
  const [staffLoad, setStaffLoad] = useState<StaffLoad>({ kind: 'loading' });
  const [staffReloadKey, setStaffReloadKey] = useState(0);
  const [assignedTo, setAssignedTo] = useState('');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [reason, setReason] = useState('');
  const [reasonRequired, setReasonRequired] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState<PastStartAcknowledgement>();
  const [resolveChangeRequest, setResolveChangeRequest] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const staffRef = useRef<HTMLSelectElement>(null);
  const timeRef = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const staffId = id + '-staff';
  const timeId = id + '-time';
  const requestId = id + '-request';
  const currentStart = reviewedJob.scheduledAt ? isoInstantToLocalDateTime(reviewedJob.scheduledAt) : '';
  const intervalType = reviewedJob.type === 'SALES_MEETING' || reviewedJob.type === 'PRODUCT_DELIVERY'
    ? reviewedJob.type : null;
  const duration = plannedIntervalDurationMinutes(reviewedJob);
  const changeRequest = reviewedJob.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST')
    ? reviewedJob.changeRequest : null;
  const stale = job.id !== reviewedJob.id || job.version !== reviewedJob.version;
  const staff = staffLoad.kind === 'ready' ? staffLoad.staff : [];
  const formOpen = panel === 'transfer';
  const active = panel !== 'closed';
  const blocked = stale || refreshRequired;

  useEffect(() => {
    if (!active) return;
    let live = true;
    void listStaff('active').then((profiles) => {
      if (live) setStaffLoad({
        kind: 'ready',
        staff: filterEligibleTransferStaff(profiles, reviewedJob.assignedTo),
      });
    }).catch(() => {
      if (live) setStaffLoad({ kind: 'error' });
    });
    return () => { live = false; };
  }, [active, reviewedJob.assignedTo, staffReloadKey]);

  useEffect(() => {
    if (formOpen && staffLoad.kind === 'ready') staffRef.current?.focus({ preventScroll: true });
  }, [formOpen, staffLoad]);

  useEffect(() => {
    if (formOpen && (submitError || stale)) errorRef.current?.focus();
  }, [formOpen, stale, submitError]);

  const slotSearch = useAvailableSlotSearch({
    type: intervalType ?? 'SALES_MEETING',
    customerId: reviewedJob.customerId,
    assignedTo: assignedTo || null,
    scheduledStartLocal: scheduledLocal,
    jobCardId: reviewedJob.id,
    enabled: formOpen && intervalType !== null && assignedTo !== '' && scheduledLocal !== '' && !blocked,
  });

  function open(trigger: HTMLButtonElement) {
    // Keep fixed overlays outside the action row so its responsive button
    // rules do not reach the drawer or wheel header.
    setOverlayHost(trigger.closest('[data-job-detail="true"]') ?? trigger.closest('section') ?? document.body);
    setReviewedJob(job);
    setScheduledLocal(job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '');
    setStaffLoad({ kind: 'loading' });
    setAssignedTo('');
    setReason('');
    setReasonRequired(false);
    setAcknowledgement(undefined);
    setResolveChangeRequest(false);
    setErrors({});
    setSubmitError('');
    setPanel('transfer');
  }

  function close() {
    if (!pending && !refreshing) setPanel('closed');
  }

  async function refresh() {
    setRefreshing(true);
    try {
      if (await onRefresh()) {
        setRefreshRequired(false);
        setPanel('closed');
      }
    } finally {
      setRefreshing(false);
    }
  }

  function changeTime(value: string) {
    setScheduledLocal(value);
    setAcknowledgement(undefined);
    setReason('');
    setReasonRequired(false);
    setErrors((current) => ({ ...current, time: undefined }));
    setSubmitError('');
  }

  async function save(nextReason = reason, nextAcknowledgement = acknowledgement) {
    if (pending || disabled) return;
    if (blocked) {
      setPanel('transfer');
      return;
    }
    const input: PatchJobCardInput = {
      expectedVersion: reviewedJob.version,
      assignedTo,
      scheduledAt: localDateTimeToIso(scheduledLocal),
      ...pastStartAcknowledgementPayload(nextAcknowledgement),
    };
    if (nextReason) input.deadlineExtensionReason = nextReason;
    if (resolveChangeRequest && changeRequest) {
      input.changeRequestResolution = { changeRequestId: changeRequest.id, resolution: 'RESCHEDULED' };
    }
    setReason(nextReason);
    setAcknowledgement(nextAcknowledgement);
    setPending(true);
    setSubmitError('');
    try {
      await onTransfer(input, (patched) => {
        setPanel('closed');
        return buildPatchCommitReceipt(patched, {
          kind: 'REASSIGN_AND_RESCHEDULE',
          resolvedChangeRequest: input.changeRequestResolution?.resolution ?? null,
        });
      });
      setPanel('closed');
    } catch (caught) {
      if (isPastStartAcknowledgementRequired(caught) && nextAcknowledgement === undefined) {
        setPanel('acknowledgement');
      } else if (caught instanceof ApiError && caught.code === 'DEADLINE_EXTENSION_REASON_REQUIRED') {
        setReasonRequired(true);
        setSubmitError(apiFieldError(caught, 'deadlineExtensionReason', REASON_REQUIRED));
        setPanel('reason');
      } else if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        setRefreshRequired(true);
        setSubmitError(STALE);
        setPanel('transfer');
      } else {
        setSubmitError(assignmentWindowErrorMessage(caught, TRANSFER_ERROR));
        // Only the reason slot owns reason-field errors. Other failures belong
        // beside the transfer controls, or to the visible acknowledgement.
        if (panel === 'reason') setPanel('transfer');
      }
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked || disabled) return;
    const next: FieldErrors = {};
    if (!staff.some((profile) => profile.user.id === assignedTo)) next.staff = 'Yeni sorumlu personel seçin.';
    if (!scheduledLocal) next.time = 'Yeni planlanan zamanı seçin.';
    else if (scheduledLocal === currentStart) next.time = 'Planlanan zamanı değiştirin.';
    setErrors(next);
    setSubmitError('');
    if (next.staff || next.time) {
      (next.staff ? staffRef.current : timeRef.current)?.focus();
      return;
    }
    if (reasonRequired && !reason) setPanel('reason');
    else void save();
  }

  function returnToTransfer() {
    setSubmitError('');
    setPanel('transfer');
  }

  const overlay = (
    <>
      <ResponsiveFormDrawer
        open={formOpen}
        title={TRANSFER_LABEL}
        onDismiss={close}
        returnFocusRef={triggerRef}
        dismissDisabled={pending || refreshing}
      >
        <form className="assignment-transfer-form" data-assignment-transfer-form onSubmit={submit} noValidate>
          <p className="form-help">
            İş yeni personele devredilir ve planlanan zaman güncellenir. Yeni bir atama teklifi açılırsa personelin yanıtı beklenir.
          </p>
          <fieldset className="assignment-transfer-fields" disabled={pending || blocked}>
            <div className="field-group">
              <label htmlFor={staffId}>Yeni sorumlu personel</label>
              {staffLoad.kind === 'loading' && <p className="field-status" role="status">Aktif personel yükleniyor…</p>}
              {staffLoad.kind === 'error' && (
                <>
                  <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>
                  <button className="secondary-button compact-button" type="button" onClick={() => {
                    setStaffLoad({ kind: 'loading' });
                    setStaffReloadKey((value) => value + 1);
                  }}>
                    Tekrar dene
                  </button>
                </>
              )}
              {staffLoad.kind === 'ready' && (
                <>
                  <select
                    ref={staffRef}
                    id={staffId}
                    name="assignedTo"
                    value={assignedTo}
                    required
                    aria-invalid={errors.staff ? true : undefined}
                    aria-describedby={errors.staff ? staffId + '-error' : undefined}
                    onChange={(event) => {
                      setAssignedTo(event.target.value);
                      setErrors((current) => ({ ...current, staff: undefined }));
                      setSubmitError('');
                    }}
                  >
                    <option value="">Personel seçin</option>
                    {staff.map((profile) => (
                      <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>
                    ))}
                  </select>
                  {staff.length === 0 && <p className="form-help">Aktif başka personel bulunmuyor.</p>}
                  {errors.staff && <p className="field-error" id={staffId + '-error'} role="alert">{errors.staff}</p>}
                </>
              )}
            </div>
            <div className="field-group">
              <WheelDateTimeField
                mode="datetime"
                id={timeId}
                name="scheduledAt"
                value={scheduledLocal}
                onChange={changeTime}
                required
                disabled={pending || blocked}
                invalid={Boolean(errors.time)}
                controlRef={timeRef}
                aria-describedby={errors.time ? timeId + '-help ' + timeId + '-error' : timeId + '-help'}
                label="Yeni planlanan zaman"
              />
              <p className="form-help" id={timeId + '-help'}>Planlanan işin süresi korunur.</p>
              <ScheduleQuickControls
                value={scheduledLocal}
                durationMinutes={duration && duration > 0 ? duration : null}
                disabled={pending || blocked}
                onSelect={changeTime}
              />
              {errors.time && <p className="field-error" id={timeId + '-error'} role="alert">{errors.time}</p>}
            </div>
            <AvailableSlotsNotice
              {...slotSearch}
              selectedStartLocal={scheduledLocal}
              onSelect={(slot) => changeTime(isoInstantToLocalDateTime(slot.startsAt))}
              disabled={pending || blocked}
            />
            {changeRequest && (
              <div className="form-checkbox-row">
                <input
                  id={requestId}
                  name="resolveChangeRequest"
                  type="checkbox"
                  checked={resolveChangeRequest}
                  onChange={(event) => setResolveChangeRequest(event.target.checked)}
                />
                <label htmlFor={requestId}>Personel önerisini “Yeniden planlandı” olarak kapat</label>
              </div>
            )}
          </fieldset>
          {(errors.staff || errors.time) && (
            <p className="field-error" role="alert" data-assignment-transfer-error="validation">
              <SignalGlyph name="exclamation" className="detail-feedback-icon" size={16} />
              Devretmeden önce işaretli alanları düzeltin.
            </p>
          )}
          {(submitError || stale) && (
            <p ref={errorRef} className="field-error" role="alert" tabIndex={-1} data-assignment-transfer-error="submit">
              <SignalGlyph name="exclamation" className="detail-feedback-icon" size={16} />
              {stale ? STALE : submitError}
            </p>
          )}
          <div className="review-buttons">
            <button className="secondary-button" type="button" disabled={pending || refreshing} onClick={close}>
              Vazgeç
            </button>
            {blocked ? (
              <button className="primary-button compact-button" type="button" disabled={refreshing} onClick={() => void refresh()}>
                {refreshing ? 'Yükleniyor…' : 'En güncel bilgileri yükle'}
              </button>
            ) : (
              <button className="primary-button compact-button" type="submit" disabled={pending || disabled || staff.length === 0}>
                {pending && <SignalGlyph name="clock" className="detail-feedback-icon" size={16} />}
                {pending ? 'Kaydediliyor…' : 'Devret ve planla'}
              </button>
            )}
          </div>
        </form>
      </ResponsiveFormDrawer>
      <ReasonDialog
        open={panel === 'reason'}
        title="Tarih değişikliği gerekçesi"
        description="Yeni plan açık gecikmeyi sonlandırıyor. Kayda eklenecek gerekçeyi yazın."
        reasonLabel="Gerekçe"
        requiredMessage={REASON_REQUIRED}
        confirmLabel="Devret ve planla"
        cancelLabel="Plana dön"
        maxLength={500}
        required
        pending={pending}
        pendingLabel="Kaydediliyor…"
        externalError={submitError}
        returnFocusRef={triggerRef}
        onCancel={returnToTransfer}
        onConfirm={(nextReason) => { void save(nextReason); }}
      />
      <PastStartAcknowledgementDrawer
        open={panel === 'acknowledgement'}
        description="Planlanan başlangıç saati geçti. Personel ve zaman değişikliğini kaydetmek için müşterinin güncel durumunu onaylayın."
        pending={pending}
        error={submitError}
        onShiftToFuture={() => {
          changeTime(defaultScheduledLocalValue(new Date()));
          returnToTransfer();
        }}
        shiftToFutureLabel="Saati şimdiye / geleceğe al"
        returnFocusRef={triggerRef}
        onDismiss={() => {
          setAcknowledgement(undefined);
          returnToTransfer();
        }}
        onConfirm={(next) => { void save(reason, next); }}
      />
    </>
  );
  return (
    <>
      <button
        ref={triggerRef}
        className={primary ? 'primary-button compact-button' : 'secondary-button compact-button'}
        type="button"
        disabled={disabled}
        aria-expanded={active}
        data-assignment-offer-action="transfer-and-reschedule"
        onClick={(event) => open(event.currentTarget)}
      >
        {TRANSFER_LABEL}
      </button>
      {active && overlayHost && createPortal(overlay, overlayHost)}
    </>
  );
}
