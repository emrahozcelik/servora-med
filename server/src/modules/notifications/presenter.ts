import type { NotificationKind, NotificationRecord } from './types.js';

export type PublicNotification = Readonly<{
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity: Readonly<{ type: 'job-card' | 'calendar-event' | 'conversation'; id: string }>;
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
  'job.note_added': { title: 'Operasyon notu', body: 'Operasyon notu eklendi.' },
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
