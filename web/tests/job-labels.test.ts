import { describe, expect, it } from 'vitest';

import {
  assignmentOfferCloseReasonLabel,
  assignmentOfferCloseReasonLabels,
  assignmentOfferStateLabel,
  assignmentOfferStateLabels,
  assignmentOfferUrgentReasonLabel,
  assignmentOfferUrgentReasonLabels,
  assignmentReasonLabel,
  assignmentReasonLabels,
  changeRequestReasonLabel,
  changeRequestReasonLabels,
  changeRequestResolutionLabel,
  changeRequestResolutionLabels,
  jobActivityLabel,
  jobTypeLabel,
  jobTypeLabels,
  pastStartAcknowledgementLabel,
  pastStartAcknowledgementLabels,
} from '../src/jobs/job-labels';
import {
  ASSIGNMENT_OFFER_CLOSE_REASONS,
  ASSIGNMENT_REASON_CODES,
  CHANGE_REQUEST_REASON_CODES,
  PAST_START_ACKNOWLEDGEMENT_CODES,
} from '../src/jobs/jobs-api';

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

describe('JOB-010 release 2b assignment offer copy', () => {
  it('labels every offer state', () => {
    expect(assignmentOfferStateLabels).toEqual({
      OPEN: 'Yanıt bekliyor',
      ACCEPTED: 'Kabul edildi',
      DECLINED: 'Reddedildi',
      RELEASED: 'Geri bırakıldı',
      EXPIRED: 'Yanıtlanmadı',
      WITHDRAWN: 'Geri çekildi',
    });
    expect(assignmentOfferStateLabel('EXPIRED')).toBe('Yanıtlanmadı');
  });

  it('labels the two urgent reasons and the empty case', () => {
    expect(assignmentOfferUrgentReasonLabels).toEqual({
      SHORT_NOTICE: 'Kısa süre',
      START_PASSED: 'Başlangıç geçti',
    });
    expect(assignmentOfferUrgentReasonLabel('START_PASSED')).toBe('Başlangıç geçti');
    expect(assignmentOfferUrgentReasonLabel(null)).toBeNull();
  });

  it('labels every decline/release reason', () => {
    expect(Object.keys(assignmentReasonLabels).sort()).toEqual([...ASSIGNMENT_REASON_CODES].sort());
    expect(assignmentReasonLabel('MISSING_STOCK_OR_EQUIPMENT')).toBe('Stok veya ekipman eksik');
    expect(assignmentReasonLabel(null)).toBe('Neden belirtilmedi');
  });

  it('labels every recorded close reason, including the management closers', () => {
    expect(Object.keys(assignmentOfferCloseReasonLabels).sort())
      .toEqual([...ASSIGNMENT_OFFER_CLOSE_REASONS].sort());
    expect(assignmentOfferCloseReasonLabel('PLANNED_WINDOW_PASSED'))
      .toBe('Planlanan zaman penceresi geçti');
    expect(assignmentOfferCloseReasonLabel('OFFBOARDING_TRANSFER')).toBe('Personel devri');
    expect(assignmentOfferCloseReasonLabel(null)).toBeNull();
  });

  it('labels every acknowledgement code', () => {
    expect(Object.keys(pastStartAcknowledgementLabels).sort())
      .toEqual([...PAST_START_ACKNOWLEDGEMENT_CODES].sort());
    expect(pastStartAcknowledgementLabel('CUSTOMER_WAITING')).toBe('Müşteri bekliyor');
    expect(pastStartAcknowledgementLabel(null)).toBe('Onay nedeni belirtilmedi');
  });

  it('labels the five new activity events', () => {
    expect(jobActivityLabel('JOB_ASSIGNMENT_OFFER_OPENED')).toBe('Görev için kabul teklifi açıldı');
    expect(jobActivityLabel('JOB_ASSIGNMENT_DECLINED')).toBe('Personel görevi reddetti');
    expect(jobActivityLabel('JOB_ASSIGNMENT_RELEASED')).toBe('Personel görevi geri bıraktı');
    expect(jobActivityLabel('JOB_ASSIGNMENT_OFFER_EXPIRED')).toBe('Kabul süresi yanıtsız geçti');
    expect(jobActivityLabel('JOB_ASSIGNMENT_OFFER_WITHDRAWN')).toBe('Kabul teklifi geri çekildi');
  });
});

describe('OVR-5a deadline-extension activity copy', () => {
  it('labels the ending event with the canonical Turkish wording', () => {
    expect(jobActivityLabel('JOB_OVERDUE_ENDED_BY_EXTENSION'))
      .toBe('Gecikme, tarih uzatılmasıyla sonlandırıldı');
  });
});
