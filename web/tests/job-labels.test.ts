import { describe, expect, it } from 'vitest';

import {
  changeRequestReasonLabel,
  changeRequestReasonLabels,
  changeRequestResolutionLabel,
  changeRequestResolutionLabels,
  jobActivityLabel,
  jobTypeLabel,
  jobTypeLabels,
} from '../src/jobs/job-labels';
import { CHANGE_REQUEST_REASON_CODES } from '../src/jobs/jobs-api';

describe('jobTypeLabel SSOT (overview/report labels)', () => {
  it('maps every known JobCard type to its canonical Turkish label', () => {
    expect(jobTypeLabels).toEqual({
      PRODUCT_DELIVERY: 'Ürün teslimi',
      GENERAL_TASK: 'Genel görev',
      SALES_MEETING: 'Satış görüşmesi',
      WEEKLY_REPORT: 'Haftalık rapor',
      SALE: 'Satış kaydı',
    });
  });

  it('resolves WEEKLY_REPORT without leaking the raw enum', () => {
    expect(jobTypeLabel('WEEKLY_REPORT')).toBe('Haftalık rapor');
  });

  it('degrades an unknown future type code to a neutral label', () => {
    expect(jobTypeLabel('UNKNOWN_FUTURE_TYPE')).toBe('Diğer');
  });
});

describe('JOB-010 release 2a change-request copy', () => {
  it('labels every reason code with Turkish copy', () => {
    expect(Object.keys(changeRequestReasonLabels).sort()).toEqual([...CHANGE_REQUEST_REASON_CODES].sort());
    expect(changeRequestReasonLabel('CUSTOMER_POSTPONED')).toBe('Müşteri erteledi');
    expect(changeRequestReasonLabel(null)).toBe('Neden belirtilmedi');
  });

  it('labels every recorded resolution, including the closing ones', () => {
    expect(changeRequestResolutionLabels).toMatchObject({
      CORRECTED: 'Düzeltildi',
      RESCHEDULED: 'Yeniden planlandı',
      LINKED_JOB_CREATED: 'Bağlı yeni iş oluşturuldu',
      REJECTED: 'Reddedildi',
      CANCELLED: 'İptal ile kapatıldı',
      SUPERSEDED: 'Sonraki işlemle kapatıldı',
    });
    expect(changeRequestResolutionLabel('REJECTED')).toBe('Reddedildi');
    expect(changeRequestResolutionLabel('FUTURE_RESOLUTION')).toBe('İşlemle kapatıldı');
  });

  it('labels the two new activity events', () => {
    expect(jobActivityLabel('JOB_CHANGE_REQUESTED')).toBe('Personel düzenleme / sonlandırma önerisi gönderdi');
    expect(jobActivityLabel('JOB_CHANGE_REQUEST_RESOLVED')).toBe('Personel önerisi karara bağlandı');
  });
});
