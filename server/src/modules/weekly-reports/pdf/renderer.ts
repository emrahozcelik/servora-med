import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import pdfMake from 'pdfmake';

import type {
  WeeklyReportPdfDocumentModel,
  WeeklyReportSourceWorkStatus,
} from './document-model.js';

const require = createRequire(import.meta.url);

/**
 * Roboto ships inside the `pdfmake` package. Registering those bytes in
 * pdfmake's virtual file system is what keeps PDF rendering free of any
 * host-font dependency: nothing is read from the operating system, and the
 * container image does not need fontconfig or a font package.
 *
 * Roboto covers the full Turkish set (ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü).
 */
const FONT_FILES = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
} as const;

let configured = false;

function configurePdfMake(): void {
  if (configured) return;
  const packageRoot = dirname(require.resolve('pdfmake/package.json'));
  const fontsDirectory = join(packageRoot, 'fonts', 'Roboto');
  for (const fileName of Object.values(FONT_FILES)) {
    pdfMake.virtualfs.writeFileSync(fileName, readFileSync(join(fontsDirectory, fileName)));
  }
  pdfMake.setFonts({
    Roboto: {
      normal: FONT_FILES.normal,
      bold: FONT_FILES.bold,
      italics: FONT_FILES.italics,
      bolditalics: FONT_FILES.bolditalics,
    },
  });
  // Closed by default: a document can neither fetch a URL nor read a local
  // file, so rendering can never reach the network or the filesystem even if a
  // future document definition tries to.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(() => false);
  configured = true;
}

function metadataRow(label: string, value: string): unknown {
  return {
    columns: [
      { width: 130, text: label, bold: true, color: '#444444' },
      { width: '*', text: value },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 2],
  };
}

function sectionBlock(label: string, value: string | null): unknown[] {
  return [
    { text: label, bold: true, fontSize: 11, margin: [0, 10, 0, 2] },
    { text: value ?? '—', preserveLeadingSpaces: true },
  ];
}

/**
 * Turkish wording for the frozen source-work status.
 *
 * `Record` over the union derived from the submission SSOT is deliberate: it is
 * what makes the mapping exhaustive at compile time. If
 * `SourceWorkSnapshotItem['statusAtSnapshot']` ever gains a member, this map
 * stops compiling instead of silently rendering an undefined cell in an
 * archival document.
 */
const SOURCE_WORK_STATUS_LABELS: Record<WeeklyReportSourceWorkStatus, string> = {
  WAITING_APPROVAL: 'Onay bekliyor',
  COMPLETED: 'Tamamlandı',
};

function sourceWorkTable(model: WeeklyReportPdfDocumentModel): unknown {
  if (model.sourceWork.length === 0) {
    return { text: 'Bu gönderimde dondurulmuş çalışma listesi boş.', italics: true, margin: [0, 4, 0, 0] };
  }
  const header = ['Başlık', 'Tür', 'Müşteri', 'Durum', 'Tamamlanma']
    .map((text) => ({ text, bold: true }));
  const rows = model.sourceWork.map((item) => [
    { text: item.title },
    { text: item.type },
    { text: item.customerName ?? '—' },
    // The status recorded when the report was frozen, never the live one.
    { text: SOURCE_WORK_STATUS_LABELS[item.statusAtSnapshot] },
    { text: item.staffCompletedAt },
  ]);
  return {
    margin: [0, 4, 0, 0],
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [header, ...rows],
    },
    layout: 'lightHorizontalLines',
  };
}

function documentDefinition(model: WeeklyReportPdfDocumentModel) {
  const content: unknown[] = [
    { text: 'Haftalık Rapor', fontSize: 18, bold: true },
    {
      text: `${model.periodStart} – ${model.periodEnd} · Gönderim #${model.seqNo}`,
      fontSize: 11,
      color: '#555555',
      margin: [0, 2, 0, 10],
    },
    // Two different guarantees, deliberately both shown: `staffName` is the
    // current display name (presentation metadata, changes on rename) while
    // `submittedBy` is the immutable identity captured by the submission and
    // never changes for a given version.
    metadataRow('Personel', model.staffName),
    metadataRow('Gönderen kimliği', model.submittedBy),
    metadataRow('Rapor dönemi', `${model.periodStart} – ${model.periodEnd}`),
    metadataRow('Gönderim sırası', `#${model.seqNo}`),
    metadataRow('Gönderim zamanı', model.submittedAt),
    metadataRow('Rapor kimliği', model.reportId),
    metadataRow('İş kaydı', model.jobCardId),
  ];

  for (const section of model.sections) {
    content.push(...sectionBlock(section.label, section.value));
  }

  if (model.answers.length > 0) {
    content.push({ text: 'Yönetici soruları', fontSize: 13, bold: true, margin: [0, 16, 0, 2] });
    for (const answer of model.answers) {
      content.push({ text: answer.prompt, bold: true, fontSize: 11, margin: [0, 8, 0, 2] });
      content.push({ text: answer.answer, preserveLeadingSpaces: true });
    }
  }

  content.push({ text: 'Gönderimde dondurulan çalışma listesi', fontSize: 13, bold: true, margin: [0, 16, 0, 2] });
  content.push(sourceWorkTable(model));

  content.push({
    text: 'Bu belge, gönderim anında dondurulan içerikten üretilmiştir; sonraki '
      + 'değişikliklerden etkilenmez.',
    fontSize: 8,
    color: '#666666',
    margin: [0, 18, 0, 0],
  });

  return {
    info: {
      title: `Haftalık Rapor ${model.periodStart} - ${model.periodEnd}`,
      subject: `Gönderim #${model.seqNo}`,
      creator: 'Servora-Med',
      producer: 'Servora-Med',
    },
    pageSize: 'A4',
    pageMargins: [48, 52, 48, 52] as [number, number, number, number],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.3 },
    footer: (currentPage: number, pageCount: number) => ({
      text: `Servora-Med · Haftalık Rapor · ${model.periodStart} · Sayfa ${currentPage}/${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#888888',
      margin: [0, 12, 0, 0],
    }),
    content,
  };
}

/**
 * Render one frozen submission to a PDF. Pure with respect to the model: no
 * clock, no filesystem, no network, no database. The only inputs are the model
 * fields, so a given model always produces the same document content (byte
 * layout may vary, so callers must compare model content, not binary hashes).
 */
export async function renderWeeklyReportPdf(model: WeeklyReportPdfDocumentModel): Promise<Buffer> {
  configurePdfMake();
  return pdfMake.createPdf(documentDefinition(model)).getBuffer();
}
