import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { paths } from '../paths';
import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import { RecordDescriptions } from '../ui/antd/RecordDescriptions';
import { jobCardStatusLabel } from './job-labels';
import { isDefinitiveMutationError } from './mutation-attempt-error';
import {
  getWeeklyReportRemovalPreview, removeWeeklyReport,
  type WeeklyReportDetail, type WeeklyReportRemovalInput, type WeeklyReportRemovalPreview,
} from './weekly-report-api';

export function WeeklyReportRemovalAction({ report, disabled, onRemoved, onBusyChange }: {
  report: WeeklyReportDetail; disabled: boolean; onRemoved: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [open,setOpen] = useState(false);
  const [preview,setPreview] = useState<WeeklyReportRemovalPreview | null>(null);
  const [reason,setReason] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [confirm,setConfirm] = useState(false);
  const [stale,setStale] = useState(false);
  const [attempt,setAttempt] = useState<WeeklyReportRemovalInput | null>(null);
  const inFlight = useRef(false);
  const session = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);
  const reasonId = useId();
  const helpId = useId();
  useEffect(() => { session.current = true;return () => { session.current = false; }; },[]);
  useEffect(() => { onBusyChange(busy || attempt!==null); },[busy,attempt,onBusyChange]);
  useEffect(() => {
    if (!open && wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  },[open]);
  useEffect(() => {
    if (open && preview && !busy && !attempt) reasonField.current?.focus();
  },[open,preview,busy,attempt]);

  async function loadPreview() {
    if (inFlight.current || disabled || attempt) return;
    inFlight.current = true;setBusy(true);setOpen(true);setError('');
    try {
      const next = await getWeeklyReportRemovalPreview(report.jobCardId);
      if (!session.current) return;
      if (next.jobCardId!==report.jobCardId || next.reportId!==report.id) throw new Error('Rapor kimliği doğrulanamadı.');
      setPreview(next);setStale(false);
      if (!next.canRemove) setError(next.removalBlocker === 'ACTIVE_FOLLOW_UPS'
        ? 'Aktif takip işleri bulunan rapor kaldırılamaz. Önce takip işlerini sonuçlandırın.'
        : 'Raporun kaldırma koşulları değişti. Güncel raporu inceleyin.');
    } catch (caught) {
      if (session.current) setError(caught instanceof Error ? caught.message : 'Rapor bilgileri yüklenemedi.');
    } finally {
      inFlight.current = false;if (session.current) setBusy(false);
    }
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || attempt || !preview?.canRemove || stale) return;
    if (!reason.trim() || Array.from(reason.trim()).length>2000) {
      setError('Kaldırma gerekçesi 1–2000 karakter olmalıdır.');return;
    }
    setError('');setConfirm(true);
  }

  async function execute(original?: WeeklyReportRemovalInput) {
    if (inFlight.current || !session.current || !preview) return;
    if (!original && (disabled || stale || !preview.canRemove)) return;
    const input = original ?? { clientActionId: crypto.randomUUID(),
      expectedVersion: preview.expectedVersion,expectedReportVersion: preview.expectedReportVersion,reason: reason.trim() };
    inFlight.current = true;setAttempt(input);setBusy(true);setError('');
    try {
      await removeWeeklyReport(report.jobCardId,input);
      if (!session.current) return;
      setAttempt(null);setConfirm(false);setOpen(false);
      await onRemoved();
    } catch (caught) {
      if (!session.current) return;
      setConfirm(false);
      if (isDefinitiveMutationError(caught)) {
        setAttempt(null);setStale(true);
        setError(caught instanceof Error ? caught.message : 'Rapor kaldırılamadı.');
      } else {
        // A lost response may follow a committed removal. Only this exact
        // original identity/payload may be replayed, including after a replacement.
        setError('İşlemin sonucu doğrulanamadı. Yeni işlem başlatmadan özgün işlemi tekrar deneyin.');
      }
    } finally {
      inFlight.current = false;if (session.current) setBusy(false);
    }
  }

  if (report.removal!==null && attempt===null) return <section className="surface weekly-report-removal-history" aria-label="Kaldırılmış rapor">
    <h2>Bu rapor kaldırıldı.</h2>
    <p>Bu kayıt geçmiş için korunuyor. Rapor haftası yeniden kullanılabilir.</p>
    <p><strong>Gerekçe:</strong> {report.removal.reason}</p>
    <p className="text-muted">{new Intl.DateTimeFormat('tr-TR',{ dateStyle:'medium',timeStyle:'short' }).format(new Date(report.removal.removedAt))}</p>
    <a className="secondary-button" href={`${paths.newWeeklyReport}?${new URLSearchParams({ periodStart:report.periodStart,staffUserId:report.staffUserId })}`}>Aynı hafta için yeni rapor oluştur</a>
  </section>;
  if (!report.canRemove && !attempt) return null;
  return <section className="weekly-report-removal" aria-label="Rapor yönetimi" data-weekly-report-removal>
    <h2 className="job-detail-rail-heading">Rapor yönetimi</h2>
    {!open && !attempt && <button ref={trigger} type="button" className="destructive-button"
      disabled={disabled || busy} onClick={() => void loadPreview()}>Raporu kaldır</button>}
    {open && <>
      {busy && !preview && <p role="status">Rapor bilgileri yükleniyor…</p>}
      {preview && <RecordDescriptions ariaLabel="Kaldırılacak rapor" maxColumns={1} items={[
        { key:'staff',label:'Personel',content:preview.staffName },
        { key:'period',label:'Rapor haftası',content:`${preview.periodStart} – ${preview.periodEnd}` },
        { key:'status',label:'Durum',content:jobCardStatusLabel(preview.status) },
        { key:'submissions',label:'Gönderim',content:preview.submissionCount===0 ? 'Henüz gönderilmedi' : `${preview.submissionCount} gönderim korunacak` },
      ]} />}
      <p id={helpId} className="form-help">Rapor ve gönderimleri geçmişte kalır. Personelin yaptığı işler korunur. Aynı hafta için yeni rapor oluşturulabilir.</p>
      <form onSubmit={review}>
        <div className="field-group"><label htmlFor={reasonId}>Kaldırma gerekçesi</label>
          <textarea ref={reasonField} id={reasonId} rows={3} value={reason} required aria-describedby={helpId}
            disabled={busy || attempt!==null} onChange={event=>setReason(event.target.value)} />
        </div>
        {!attempt && <div className="form-actions">
          <button ref={continueButton} type="submit" className="secondary-button" disabled={disabled || busy || !preview?.canRemove || stale}>Devam et</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={()=>{setOpen(false);setError('');}}>Vazgeç</button>
        </div>}
      </form>
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {stale && !attempt && <button type="button" className="secondary-button" disabled={busy} onClick={()=>void loadPreview()}>Güncel bilgileri yükle</button>}
    {attempt && !busy && <button type="button" className="secondary-button" onClick={()=>void execute(attempt)}>Özgün işlemi tekrar dene</button>}
    {!preview && error && !attempt && <button type="button" className="secondary-button" disabled={busy} onClick={()=>void loadPreview()}>Tekrar dene</button>}
    <ConfirmationAction open={confirm} title="Rapor kaldırılsın mı?" destructive
      description={preview ? `${preview.staffName} · ${preview.periodStart} – ${preview.periodEnd}` : ''}
      details={['Rapor, gönderimleri ve işlem geçmişi korunacak.','Personelin yaptığı işler değişmeyecek.','Aynı hafta için yeni bir rapor oluşturulabilecek.',`Gerekçe: ${reason.trim()}`]}
      confirmLabel="Raporu kaldır ve haftayı aç" pendingLabel="Rapor kaldırılıyor…" pending={busy}
      confirmDisabled={disabled || stale || !preview?.canRemove}
      onConfirm={()=>void execute()} onCancel={()=>setConfirm(false)} returnFocusRef={continueButton} fallbackFocusRef={trigger} />
  </section>;
}
