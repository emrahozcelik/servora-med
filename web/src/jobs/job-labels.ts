import type { JobCardStatus, JobCardType } from './jobs-api';

export const jobTypeLabels: Record<JobCardType, string> = {
  PRODUCT_DELIVERY: 'Ürün teslimi',
  GENERAL_TASK: 'Genel görev',
  SALES_MEETING: 'Satış görüşmesi',
};

export const jobStatusLabels: Record<JobCardStatus, string> = {
  NEW: 'Oluşturuldu',
  PLANNED: 'Planlandı',
  IN_PROGRESS: 'Uygulanıyor',
  WAITING_APPROVAL: 'Yönetici kontrolünde',
  REVISION_REQUESTED: 'Düzeltme gerekiyor',
  COMPLETED: 'Tamamlandı',
  CANCELLED: 'İptal edildi',
};

export const JOB_CARD_ACTIVITY_EVENTS = [
  'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
  'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED',
  'JOB_APPROVAL_WITHDRAWN',
] as const;

export type KnownJobCardActivityEvent = (typeof JOB_CARD_ACTIVITY_EVENTS)[number];

const LABELS: Record<KnownJobCardActivityEvent, string> = {
  JOB_CREATED: 'İş oluşturuldu',
  JOB_ASSIGNED: 'Atanan personel değiştirildi',
  JOB_PLANNED: 'İş planlandı',
  JOB_STARTED: 'İş başlatıldı',
  JOB_SUBMITTED_FOR_APPROVAL: 'Kontrole gönderildi',
  JOB_APPROVED: 'Kontrol tamamlandı',
  JOB_REVISION_REQUESTED: 'Düzeltme için geri gönderildi',
  JOB_RESUMED: 'İş yeniden başlatıldı',
  JOB_CANCELLED: 'İş iptal edildi',
  JOB_FIELDS_UPDATED: 'İş bilgileri güncellendi',
  DELIVERY_ITEM_ADDED: 'Teslim ürünü eklendi',
  DELIVERY_ITEM_UPDATED: 'Teslim ürünü güncellendi',
  DELIVERY_ITEM_REMOVED: 'Teslim ürünü kaldırıldı',
  NOTE_ADDED: 'Operasyon notu eklendi',
  MEETING_DETAILS_UPDATED: 'Görüşme sonucu güncellendi',
  JOB_APPROVAL_WITHDRAWN: 'Kontrolden geri çekildi',
};

export function isKnownJobCardActivityEvent(value: string): value is KnownJobCardActivityEvent {
  return JOB_CARD_ACTIVITY_EVENTS.includes(value as KnownJobCardActivityEvent);
}

export function jobActivityLabel(eventType: string) {
  return isKnownJobCardActivityEvent(eventType)
    ? LABELS[eventType]
    : 'İş kaydında bir işlem yapıldı';
}
