import type { MeetingOutcome } from './jobs-api';

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
};
