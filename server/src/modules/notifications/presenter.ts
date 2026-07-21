import type { NotificationKind, NotificationRecord } from './types.js';

export type PublicNotification = Readonly<{
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity: Readonly<{ type: 'job-card'; id: string }>;
  createdAt: string;
  readAt: string | null;
}>;

const MESSAGES: Record<NotificationKind, Readonly<{ title: string; body: string }>> = {
  'job.assigned': { title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.' },
  'job.reassigned': { title: 'İş atandı', body: 'Size bir iş atandı.' },
  'job.awaiting_approval': { title: 'İş yönetici kontrolünde', body: 'Bir iş yönetici kontrolüne gönderildi.' },
  'job.approved': { title: 'İş onaylandı', body: 'İşiniz onaylandı.' },
  'job.revision_requested': { title: 'Düzeltme istendi', body: 'İşiniz düzeltme için geri gönderildi.' },
  'job.cancelled': { title: 'İş iptal edildi', body: 'İşiniz iptal edildi.' },
};

export function presentNotification(record: NotificationRecord): PublicNotification {
  const message = MESSAGES[record.kind];
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
