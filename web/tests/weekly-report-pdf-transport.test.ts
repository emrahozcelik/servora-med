/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/services/api';
import { saveBlobAs } from '../src/services/file-download';
import { downloadWeeklyReportSubmissionPdf } from '../src/jobs/weekly-report-api';

/**
 * Transport-level coverage for the PDF download path: the real client builds the
 * URL and decodes the filename, and the real download trigger drives the DOM.
 * Only `fetch` and the object-URL API are stubbed.
 */
const PDF_URL = '/api/job-cards/job%2F1/weekly-report/submissions/2/pdf';

function stubFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn(() => Promise.resolve(typeof response === 'function' ? response() : response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function pdfResponse(disposition?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/pdf' };
  if (disposition !== undefined) headers['content-disposition'] = disposition;
  return new Response('%PDF-1.4', { status: 200, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('weekly report PDF download transport', () => {
  // T1
  it('requests the exact immutable submission path and keeps the server filename', async () => {
    const fetchMock = stubFetch(pdfResponse('attachment; filename="haftalik-rapor-2026-09-21-seq-2.pdf"'));

    const result = await downloadWeeklyReportSubmissionPdf('job/1', 2);

    expect(fetchMock).toHaveBeenCalledWith(PDF_URL, { credentials: 'include' });
    expect(result.fileName).toBe('haftalik-rapor-2026-09-21-seq-2.pdf');
    expect(result.blob.type).toBe('application/pdf');
    expect(result.blob.size).toBeGreaterThan(0);
  });

  // T2
  it('falls back to a deterministic filename when the server sends no disposition', async () => {
    stubFetch(pdfResponse());
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'haftalik-rapor-seq-2.pdf' });
  });

  // T3
  it('reduces a path-qualified filename to its basename and rejects non-ASCII names', async () => {
    stubFetch(pdfResponse('attachment; filename="../../etc/passwd"'));
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'passwd' });

    stubFetch(pdfResponse('attachment; filename="C:\\\\Windows\\\\rapor.pdf"'));
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'rapor.pdf' });

    // A latin-1 (but non-printable-ASCII) name is refused: it could not be a
    // safe ASCII basename.
    stubFetch(pdfResponse('attachment; filename="rapor\u00E7.pdf"'));
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'haftalik-rapor-seq-2.pdf' });

    // An RFC 5987 extended parameter is ignored rather than half-parsed.
    stubFetch(pdfResponse("attachment; filename*=UTF-8''rapor%20bir.pdf"));
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'haftalik-rapor-seq-2.pdf' });

    stubFetch(pdfResponse('attachment; filename=".."'));
    await expect(downloadWeeklyReportSubmissionPdf('job-1', 2))
      .resolves.toMatchObject({ fileName: 'haftalik-rapor-seq-2.pdf' });
  });

  // T4
  it('throws the decoded domain error instead of parsing a failed body as a PDF', async () => {
    stubFetch(() => new Response(
      JSON.stringify({ error: 'PDF üretilemedi.', code: 'WEEKLY_REPORT_SUBMISSION_NOT_FOUND' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));

    await expect(downloadWeeklyReportSubmissionPdf('job-1', 9)).rejects.toMatchObject({
      code: 'WEEKLY_REPORT_SUBMISSION_NOT_FOUND', status: 404, message: 'PDF üretilemedi.',
    });

    // A non-JSON failure body must not crash the decoder.
    stubFetch(() => new Response('<html>gateway</html>', { status: 502 }));
    const failure = await downloadWeeklyReportSubmissionPdf('job-1', 9).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
  });

  // T5
  it('saveBlobAs clicks a detached anchor and releases the object URL afterwards', async () => {
    const createObjectURL = vi.fn(() => 'blob:servora-1');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = realCreate(tag);
      if (tag === 'a') anchors.push(element as HTMLAnchorElement);
      return element;
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    saveBlobAs({ type: 'application/pdf', size: 8 } as unknown as Blob, 'haftalik-rapor-seq-2.pdf');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.download).toBe('haftalik-rapor-seq-2.pdf');
    expect(anchor.href).toBe('blob:servora-1');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Removed from the document, and the URL is still alive in this tick.
    expect(document.body.contains(anchor)).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:servora-1');
  });
});
