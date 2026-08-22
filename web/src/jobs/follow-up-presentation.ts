import type { JobCardType, MeetingOutcome } from './jobs-api';

export const FOLLOW_UP_BADGE_LABEL = 'Takip';
export const FOLLOW_UP_SOURCE_TITLE = 'Önceki iş bağlamı';
export const FOLLOW_UP_CHILDREN_TITLE = 'Takip işleri';
export const FOLLOW_UP_DATE_LABELS = {
  planned: 'Planlanan tarih',
  occurred: 'Gerçekleşme tarihi',
  completed: 'Tamamlanma tarihi',
} as const;
export const CUSTOMERLESS_FOLLOW_UP_EXPLANATION =
  'Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir.';

export const FOLLOW_UP_OUTCOME_LABELS: Record<MeetingOutcome, string> = {
  POSITIVE: 'Olumlu',
  FOLLOW_UP_REQUIRED: 'Takip gerekli',
  NO_DECISION: 'Karar verilmedi',
  NOT_INTERESTED: 'İlgilenmiyor',
};

export const FOLLOW_UP_ERROR_MESSAGES: Record<string, string> = {
  FOLLOW_UP_INSTRUCTIONS_REQUIRED: 'Yeni takip işinin kapsamını yazın.',
  FOLLOW_UP_SOURCE_NOT_COMPLETED: 'Kaynak iş artık tamamlanmış durumda değil. Takip işi oluşturulamaz.',
  FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED: CUSTOMERLESS_FOLLOW_UP_EXPLANATION,
  FOLLOW_UP_CONTACT_REQUIRES_CUSTOMER: 'Müşteri bağlantısı olmayan takip işinde ilgili kişi seçilemez.',
  FOLLOW_UP_MAX_DEPTH_REACHED: 'Bu takip zincirinde en fazla 10 seviye kullanılabilir. Yeni takip işi eklenemez.',
  CUSTOMER_INACTIVE: 'Kaynak işin müşterisi artık aktif değil.',
  CONTACT_INACTIVE: 'Seçilen ilgili kişi artık aktif değil.',
  CONTACT_NOT_IN_CUSTOMER: 'Seçilen ilgili kişi kaynak işin müşterisine bağlı değil.',
  ACTION_IN_PROGRESS: 'Bu takip işi oluşturuluyor olabilir. Kısa bir süre bekleyip aynı bilgilerle tekrar deneyin.',
  FOLLOW_UP_CUSTOMER_CONFLICT: 'Aynı müşteriye aynı gün başka bir saha işi planlanmış. Farklı bir gün seçin.',
  FOLLOW_UP_OVERRIDE_REASON_REQUIRED: 'Bu müşteri için ziyaret sıklığı sınırı aşılıyor. Planlamak için neden belirtin.',
};

const FOLLOW_UP_TYPE_DEFAULTS: Record<JobCardType, JobCardType> = {
  SALES_MEETING: 'SALES_MEETING',
  PRODUCT_DELIVERY: 'SALES_MEETING',
  GENERAL_TASK: 'GENERAL_TASK',
};

/** Canonical follow-up child type for a completed source, mirroring the server
 *  `defaultFollowUpType` contract (no server round-trip needed). */
export function defaultFollowUpType(sourceType: JobCardType): JobCardType {
  return FOLLOW_UP_TYPE_DEFAULTS[sourceType];
}

export const FOLLOW_UP_TITLE_PREFIX = 'Takip: ';

/** Editable default title for a direct follow-up. Capped to the JobCard title
 *  domain limit (255 code points) so the generated default is never invalid. */
export function defaultFollowUpTitle(sourceTitle: string): string {
  const title = sourceTitle.trim();
  return Array.from(`${FOLLOW_UP_TITLE_PREFIX}${title}`).slice(0, 255).join('');
}
