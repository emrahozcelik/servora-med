import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import {
  buildWeeklyReportPdfDocumentModel,
  sanitizePdfText,
} from '../src/modules/weekly-reports/pdf/document-model.js';
import { weeklyReportPdfFileName } from '../src/modules/weekly-reports/pdf/file-name.js';
import { renderWeeklyReportPdf } from '../src/modules/weekly-reports/pdf/renderer.js';
import type {
  WeeklyReportRow,
  WeeklyReportSubmissionRow,
} from '../src/modules/weekly-reports/repository.js';
import type { WeeklyReportSubmission } from '../src/modules/weekly-reports/types.js';

import { pdfCMapText, pdfDecodedText, pdfObjectText } from './support/pdf-text.js';

const PERIOD_START = new Date(2026, 8, 21);
const PERIOD_END = new Date(2026, 8, 27);

function submission(overrides: Partial<WeeklyReportSubmission> = {}): WeeklyReportSubmission {
  return {
    id: 'sub-2', organizationId: 'org-1', weeklyReportId: 'report-1', jobCardId: 'job-1',
    seqNo: 2, submittedBy: 'staff-1', submittedAt: '2026-09-25T06:15:00.000Z',
    periodStart: '2026-09-21', periodEnd: '2026-09-27',
    body: {
      summary: 'Dondurulmuş özet', blockers: null, nextWeekPlan: 'Dondurulmuş plan',
      highlights: null, fieldObservations: null, supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Soru?' }],
    answers: [{ questionKey: 'q1', answer: 'Dondurulmuş yanıt' }],
    // Two frozen items carrying DIFFERENT recorded statuses. The pair is what
    // makes the status projection discriminating: a projection that collapses
    // both to one value (or drops the column) cannot satisfy both assertions.
    sourceWork: [
      {
        jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Klinik ziyareti',
        customerName: 'Klinik', staffCompletedAt: '2026-09-24T09:00:00.000Z',
        statusAtSnapshot: 'COMPLETED',
      },
      {
        jobCardId: 'job-10', type: 'PRODUCT_DELIVERY', title: 'Teslimat',
        customerName: null, staffCompletedAt: '2026-09-25T09:00:00.000Z',
        statusAtSnapshot: 'WAITING_APPROVAL',
      },
    ],
    jobVersion: 4, sourceActivityId: 'act-1', createdAt: '2026-09-25T06:15:00.000Z',
    ...overrides,
  };
}

const TURKISH_CODE_POINTS: Record<string, number> = {
  'ç': 0x00e7, 'Ç': 0x00c7, 'ğ': 0x011f, 'Ğ': 0x011e, 'ı': 0x0131, 'İ': 0x0130,
  'ö': 0x00f6, 'Ö': 0x00d6, 'ş': 0x015f, 'Ş': 0x015e, 'ü': 0x00fc, 'Ü': 0x00dc,
};

describe('Weekly Report PDF — deterministic attachment name', () => {
  it('builds an ASCII-safe name from the period and the immutable seq', () => {
    expect(weeklyReportPdfFileName('2026-09-21', 2)).toBe('haftalik-rapor-2026-09-21-seq-2.pdf');
    expect(weeklyReportPdfFileName('2026-09-21', 11)).toBe('haftalik-rapor-2026-09-21-seq-11.pdf');
  });

  it('never lets a malformed period or seq carry a path or header break', () => {
    for (const hostile of ['../../etc/passwd', '2026-09-21"\r\nX-Evil: 1', '', 'not-a-date']) {
      const name = weeklyReportPdfFileName(hostile, 1);
      expect(name).toBe('haftalik-rapor-tarihsiz-seq-1.pdf');
    }
    expect(weeklyReportPdfFileName('2026-09-21', 0)).toBe('haftalik-rapor-2026-09-21-seq-1.pdf');
    expect(weeklyReportPdfFileName('2026-09-21', Number.NaN)).toBe('haftalik-rapor-2026-09-21-seq-1.pdf');
    expect(/^[A-Za-z0-9._-]+$/.test(weeklyReportPdfFileName('2026-09-21', 2))).toBe(true);
  });
});

describe('Weekly Report PDF — document model', () => {
  it('carries the frozen sections, answers and source-work snapshot', () => {
    const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    expect(model.reportId).toBe('report-1');
    expect(model.seqNo).toBe(2);
    expect(model.periodStart).toBe('2026-09-21');
    expect(model.sections.map((section) => section.label)).toEqual([
      'Haftanın özeti', 'Sorunlar / engeller', 'Gelecek hafta planı',
      'Öne çıkan çalışmalar', 'Müşteri / saha gözlemleri', 'Yöneticiden destek beklenen konular',
    ]);
    expect(model.sections[0]!.value).toBe('Dondurulmuş özet');
    expect(model.sections[1]!.value).toBeNull();
    expect(model.answers).toEqual([{ prompt: 'Soru?', answer: 'Dondurulmuş yanıt' }]);
    // Both frozen items survive the projection, and each keeps the status that
    // was recorded at submission time. A projection that drops or collapses the
    // field cannot satisfy this shape.
    expect(model.sourceWork).toEqual([
      {
        title: 'Klinik ziyareti', type: 'GENERAL_TASK', customerName: 'Klinik',
        staffCompletedAt: '2026-09-24T09:00:00.000Z',
        statusAtSnapshot: 'COMPLETED',
      },
      {
        title: 'Teslimat', type: 'PRODUCT_DELIVERY', customerName: null,
        staffCompletedAt: '2026-09-25T09:00:00.000Z',
        statusAtSnapshot: 'WAITING_APPROVAL',
      },
    ]);
    expect(model.submittedBy).toBe('staff-1');
  });

  it('preserves two DIFFERENT frozen statuses instead of one live/constant value', () => {
    const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    expect(model.sourceWork.map((item) => item.statusAtSnapshot)).toEqual([
      'COMPLETED',
      'WAITING_APPROVAL',
    ]);
    // The two statuses must be genuinely distinct values, not a single constant.
    const [first, second] = model.sourceWork;
    expect(first!.statusAtSnapshot).not.toBe(second!.statusAtSnapshot);
  });

  it('treats an empty optional section as absent and a question key as its own label', () => {
    const model = buildWeeklyReportPdfDocumentModel({
      submission: submission({
        body: {
          summary: 'Özet', blockers: '   ', nextWeekPlan: 'Plan',
          highlights: null, fieldObservations: null, supportNeeded: null,
        },
        answers: [{ questionKey: 'orphan', answer: 'Yanıt' }],
      }),
      staffName: 'Ayşe',
    });
    expect(model.sections[1]!.value).toBeNull();
    expect(model.answers).toEqual([{ prompt: 'orphan', answer: 'Yanıt' }]);
  });

  it('normalizes text to inert plain text', () => {
    expect(sanitizePdfText('a\u0000b\r\n\r\n\r\nc  ')).toBe('ab\n\nc');
    expect(sanitizePdfText('x\u0007y')).toBe('xy');
    expect(sanitizePdfText('   ')).toBe('');
  });

  it('is a pure function of the model input', () => {
    const first = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    const second = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('Weekly Report PDF — rendering', () => {
  it('produces a real multi-page PDF for a long frozen body', async () => {
    const model = buildWeeklyReportPdfDocumentModel({
      submission: submission({
        body: {
          summary: 'Özet', blockers: null,
          nextWeekPlan: 'Plan. '.repeat(400),
          highlights: 'Öne çıkanlar. '.repeat(400),
          fieldObservations: null, supportNeeded: null,
        },
      }),
      staffName: 'Ayşe Çağlar',
    });
    const buffer = await renderWeeklyReportPdf(model);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pageCount = Number((buffer.toString('latin1').match(/\/Count (\d+)/) ?? [])[1]);
    expect(pageCount).toBeGreaterThan(1);
  });

  it('embeds a Type0 font covering the full Turkish set', async () => {
    const model = buildWeeklyReportPdfDocumentModel({
      submission: submission({
        body: {
          summary: Object.keys(TURKISH_CODE_POINTS).join(' '), blockers: null,
          nextWeekPlan: 'Plan', highlights: null, fieldObservations: null, supportNeeded: null,
        },
      }),
      staffName: 'Ayşe Çağlar',
    });
    const buffer = await renderWeeklyReportPdf(model);
    const raw = buffer.toString('latin1');
    expect(raw).toContain('/Type0');
    expect(raw).toContain('/Identity-H');
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('/ToUnicode');
    const haystack = pdfCMapText(buffer).toUpperCase();
    for (const [char, codePoint] of Object.entries(TURKISH_CODE_POINTS)) {
      const hex = codePoint.toString(16).padStart(4, '0').toUpperCase();
      expect(haystack.includes(hex), `${char} (U+${hex})`).toBe(true);
    }
  });

  it('emits no script, launch, URI or embedded-file action', async () => {
    const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    const objects = pdfObjectText(await renderWeeklyReportPdf(model));
    for (const forbidden of ['/JavaScript', '/JS', '/Launch', '/URI', '/EmbeddedFile', '/OpenAction']) {
      expect(objects.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('renders with zero network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    try {
      const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
      const buffer = await renderWeeklyReportPdf(model);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('renders without any host font dependency', async () => {
    const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    const buffer = await renderWeeklyReportPdf(model);
    // Roboto is embedded from the package, so the PDF carries its own font.
    expect(buffer.toString('latin1')).toContain('/FontFile2');
  });

  it('draws the frozen status of every source-work item as a localized label', async () => {
    // The fixture carries one COMPLETED and one WAITING_APPROVAL item, so a
    // mapping that collapses both to one constant cannot draw both labels.
    const model = buildWeeklyReportPdfDocumentModel({ submission: submission(), staffName: 'Ayşe' });
    const text = pdfDecodedText(await renderWeeklyReportPdf(model));
    expect(text).toContain('Durum');
    expect(text).toContain('Tamamlandı');
    expect(text).toContain('Onay bekliyor');
    // The raw enum codes are internal and must never surface in the document.
    expect(text).not.toContain('COMPLETED');
    expect(text).not.toContain('WAITING_APPROVAL');
  });
});

describe('Weekly Report PDF — immutability', () => {
  const actor: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };

  function jobCard(): JobCard {
    return {
      id: 'job-1', organizationId: 'org-1', type: 'WEEKLY_REPORT', status: 'WAITING_APPROVAL',
      version: 9, title: 'Haftalık Rapor', description: null, customerId: null, contactId: null,
      assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: '2026-09-28',
      scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
    };
  }

  function reportRow(): WeeklyReportRow {
    // Live, mutable state. 'Ğ' appears here and NOWHERE in the frozen content,
    // so its presence in the PDF would prove the live draft leaked in.
    return {
      id: 'report-1', organization_id: 'org-1', job_card_id: 'job-1', staff_user_id: 'staff-1',
      period_start: PERIOD_START, period_end: PERIOD_END,
      draft_summary: 'CANLI TASLAK Ğ', draft_blockers: 'CANLI ENGEL',
      draft_next_week_plan: 'CANLI PLAN', draft_highlights: 'CANLI ÖNE ÇIKAN',
      draft_field_observations: 'CANLI GÖZLEM', draft_support_needed: 'CANLI DESTEK',
      manager_questions: [{ key: 'q1', prompt: 'Canlı soru?' }],
      manager_answers: [{ questionKey: 'q1', answer: 'CANLI YANIT' }],
      version: 42, created_at: new Date('2026-09-20T06:00:00.000Z'),
      updated_at: new Date('2026-09-26T06:00:00.000Z'),
    };
  }

  function submissionRow(): WeeklyReportSubmissionRow {
    return {
      id: 'sub-1', organization_id: 'org-1', weekly_report_id: 'report-1', job_card_id: 'job-1',
      seq_no: 1, submitted_by: 'staff-1', submitted_at: new Date('2026-09-25T06:15:00.000Z'),
      period_start: PERIOD_START, period_end: PERIOD_END,
      frozen_body: {
        summary: 'DONDURULMUŞ ÖZET', blockers: null, nextWeekPlan: 'DONDURULMUŞ PLAN',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      frozen_questions: [{ key: 'q1', prompt: 'Dondurulmuş soru?' }],
      frozen_answers: [{ questionKey: 'q1', answer: 'DONDURULMUŞ YANIT' }],
      frozen_source_work: [],
      job_version: 4, source_activity_id: 'act-1', created_at: new Date('2026-09-25T06:15:00.000Z'),
    };
  }

  function service(repository: Record<string, unknown>) {
    return new JobCardService(repository as never);
  }

  it('projects the frozen submission, never the live draft or live answers', async () => {
    const repository = {
      findJobCard: vi.fn().mockResolvedValue(jobCard()),
      getWeeklyReportByJobId: vi.fn().mockResolvedValue(reportRow()),
      getWeeklyReportSubmissionBySeq: vi.fn().mockResolvedValue(submissionRow()),
      getUserDisplayName: vi.fn().mockResolvedValue('Ayşe'),
    };
    const result = await service(repository).weeklyReportSubmissionPdf(actor, 'job-1', 1);
    const objects = pdfObjectText(result.buffer);
    const haystack = pdfCMapText(result.buffer).toUpperCase();

    // The frozen content is present... (haystack is upper-cased, so compare upper-case hex)
    expect(haystack.includes('00D6')).toBe(true); // 'Ö' from 'DONDURULMUŞ ÖZET'
    // ...and the live draft is not. 'Ğ' exists only in the live draft/answers.
    expect(haystack.includes('011E')).toBe(false);
    expect(objects.includes('/JavaScript')).toBe(false);
    expect(result.fileName).toBe('haftalik-rapor-2026-09-21-seq-1.pdf');
  });

  it('selects the requested immutable version by explicit seq', async () => {
    const repository = {
      findJobCard: vi.fn().mockResolvedValue(jobCard()),
      getWeeklyReportByJobId: vi.fn().mockResolvedValue(reportRow()),
      getWeeklyReportSubmissionBySeq: vi.fn().mockResolvedValue(submissionRow()),
      getUserDisplayName: vi.fn().mockResolvedValue('Ayşe'),
    };
    await service(repository).weeklyReportSubmissionPdf(actor, 'job-1', 3);
    expect(repository.getWeeklyReportSubmissionBySeq).toHaveBeenCalledWith('org-1', 'report-1', 3);
  });

  it('does not change the PDF when the live report row changes afterwards', async () => {
    const build = () => ({
      findJobCard: vi.fn().mockResolvedValue(jobCard()),
      getWeeklyReportByJobId: vi.fn().mockResolvedValue(reportRow()),
      getWeeklyReportSubmissionBySeq: vi.fn().mockResolvedValue(submissionRow()),
      getUserDisplayName: vi.fn().mockResolvedValue('Ayşe'),
    });
    const first = await service(build()).weeklyReportSubmissionPdf(actor, 'job-1', 1);
    const mutated = build();
    mutated.getWeeklyReportByJobId.mockResolvedValue({
      ...reportRow(), version: 99, draft_summary: 'TAMAMEN FARKLI CANLI METİN',
    });
    const second = await service(mutated).weeklyReportSubmissionPdf(actor, 'job-1', 1);
    expect(pdfCMapText(second.buffer)).toBe(pdfCMapText(first.buffer));
  });

  it('keeps the immutable submitter identity stable across a display-name rename', async () => {
    // The display name is resolved live from `users.name` and is presentation
    // metadata: a rename legitimately changes it. The frozen `submitted_by`
    // value is the stable traceability identity and must survive the rename.
    // This is deliberately NOT a byte-for-byte reproducibility claim.
    const build = (name: string) => ({
      findJobCard: vi.fn().mockResolvedValue(jobCard()),
      getWeeklyReportByJobId: vi.fn().mockResolvedValue(reportRow()),
      getWeeklyReportSubmissionBySeq: vi.fn().mockResolvedValue(submissionRow()),
      getUserDisplayName: vi.fn().mockResolvedValue(name),
    });
    const before = pdfDecodedText(
      (await service(build('Ayşe Personel')).weeklyReportSubmissionPdf(actor, 'job-1', 1)).buffer,
    );
    const after = pdfDecodedText(
      (await service(build('Ayşe Yeni Soyad')).weeklyReportSubmissionPdf(actor, 'job-1', 1)).buffer,
    );

    expect(before).toContain('Gönderen kimliği');
    expect(before).toContain('Ayşe Personel');
    expect(after).toContain('Ayşe Yeni Soyad');
    // The stable identity is unchanged by the rename.
    expect(before).toContain('staff-1');
    expect(after).toContain('staff-1');
  });
});

afterEach(() => { vi.restoreAllMocks(); });
