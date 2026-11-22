import type { NotificationEntityType, NotificationKind, NotificationRecord } from './types.js';

export type PublicNotification = Readonly<{
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity: Readonly<{ type: NotificationEntityType; id: string }>;
  createdAt: string;
  readAt: string | null;
}>;

export const NOTIFICATION_MESSAGES: Record<NotificationKind, Readonly<{ title: string; body: string }>> = {
  'job.assigned': { title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.' },
  'job.reassigned': { title: 'İş atandı', body: 'Size bir iş atandı.' },
  'job.awaiting_approval': { title: 'İş yönetici kontrolünde', body: 'Bir iş yönetici kontrolüne gönderildi.' },
  'job.approved': { title: 'İş onaylandı', body: 'İşiniz onaylandı.' },
  'job.revision_requested': { title: 'Düzeltme istendi', body: 'İşiniz düzeltme için geri gönderildi.' },
  'job.cancelled': { title: 'İş iptal edildi', body: 'İşiniz iptal edildi.' },
  'job.invalidated': { title: 'İş geçersiz kılındı', body: 'Bir iş kaydı geçersiz kılındı.' },
  'job.note_added': { title: 'Operasyon notu', body: 'Operasyon notu eklendi.' },
  'job.submission_reminder': {
    title: 'Onaya gönderme hatırlatması',
    body: 'Yöneticiniz işi onaya göndermenizi bekliyor. Lütfen işi tamamlayıp yönetici onayına gönderin.',
  },
  'job.submission_auto_reminder': {
    title: 'Onaya gönderme süresi geçti',
    body: 'Bu işin onaya gönderme süresi geçti. Lütfen işi tamamlayıp yönetici onayına gönderin.',
  },
  'job.submission_auto_escalation': {
    title: 'Onaya gönderilmeyen iş',
    body: 'Personelin başlattığı iş yönetici onayına gönderilmedi. Lütfen takip edin.',
  },
  'job.change_requested': {
    title: 'Personel önerisi',
    body: 'Atanan personel iş için düzenleme veya sonlandırma önerisi gönderdi. Lütfen karar verin.',
  },
  'job.change_request_resolved': {
    title: 'Öneriniz yanıtlandı',
    body: 'İş için gönderdiğiniz düzenleme veya sonlandırma önerisi yönetici tarafından yanıtlandı.',
  },
  'job.acceptance_reminder': {
    title: 'Görev kabul süresi yaklaşıyor',
    body: 'Size atanan iş için kabul süresi doluyor. Lütfen işi kabul edin veya reddedin.',
  },
  'job.assignment_declined': {
    title: 'Görev kabul edilmedi',
    body: 'Personel atanan işi kabul etmedi veya geri bıraktı. Lütfen yeni bir personel atayın ya da işi yeniden planlayın.',
  },
  'job.acceptance_expired': {
    title: 'Görev kabul süresi doldu',
    body: 'Atanan iş için kabul süresi yanıtlanmadan doldu. İş iptal edilmedi; lütfen atamayı yenileyin veya işi yeniden planlayın.',
  },
  // OVR-6 static copy (contract §4.4, §5.3, §6.3). These are operational
  // facts, never blame: the start reminder is not lateness, the approval-wait
  // alert is a management delay and the unaccepted-job alert is a management
  // list entry.
  'job.start_reminder': {
    title: 'Planlanan başlangıç geçti',
    body: 'Planlanan başlangıç saati geçti. İşi başlatın ya da değişiklik talebi gönderin.',
  },
  'job.approval_wait_alert': {
    title: 'Onay bekleyen iş 24 saati aştı',
    body: 'Bir işin yönetici onayı 24 saati aştı.',
  },
  'job.pending_acceptance_alert': {
    title: 'Kabul edilmemiş iş',
    body: 'Bir işin planlanan saati geçti ve henüz kabul edilmedi.',
  },
  'calendar.assigned': {
    title: 'Yeni takvim planı',
    body: 'Takviminize yeni bir plan eklendi.',
  },
  'calendar.rescheduled': {
    title: 'Plan zamanı güncellendi',
    body: 'Planlanan çalışma zamanı güncellendi.',
  },
  'calendar.cancelled': {
    title: 'Takvim planı iptal edildi',
    body: 'Takvim planınız iptal edildi.',
  },
  'calendar.reminder': {
    title: 'Yaklaşan plan',
    body: 'Yaklaşan planınız bulunuyor.',
  },
  'message.received': {
    title: 'Yeni operasyon mesajı',
    body: 'Yeni bir operasyon mesajı aldınız.',
  },
};

export function presentNotification(record: NotificationRecord): PublicNotification {
  const message = NOTIFICATION_MESSAGES[record.kind];
  return {
    id: record.id,
    kind: record.kind,
    title: message.title,
    body: message.body,
    entity: { type: record.entityType, id: record.entityId },
    createdAt: record.createdAt.toISOString(),
    readAt: record.readAt?.toISOString() ?? null,
  };
}
