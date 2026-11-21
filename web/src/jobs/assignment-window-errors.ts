import { ApiError } from '../services/api';

/**
 * JOB-010 release 2b: server codes the assignment window answers with. The
 * server owns every rule and every state check; the web only turns the code
 * into a sentence an operator can act on. Unknown codes keep the server text.
 */
const ASSIGNMENT_WINDOW_MESSAGES: Record<string, string> = {
  ACCEPTANCE_WINDOW_CLOSED:
    'Kabul süresi doldu. İş yöneticinin listesine düştü; yönetici yeni bir atama teklifi açabilir.',
  ASSIGNMENT_WINDOW_TOO_SHORT:
    'Planlanan zaman aralığı atama için çok kısa. Yöneticinin teslim veya görüşme zamanını ileri alması gerekir.',
  CUSTOMER_TIME_MANAGEMENT_ONLY:
    'Müşteri zamanını yalnızca yönetici değiştirebilir. Planlanan zaman için yöneticinizle görüşün.',
  ASSIGNMENT_OFFER_ALREADY_OPEN:
    'Bu iş için süresi geçmemiş bir atama teklifi var. Önce personelin yanıtı beklenir.',
  ASSIGNMENT_OFFER_NOT_OPEN:
    'Yanıtlanacak açık bir atama teklifi yok. İş güncellenmiş olabilir; en güncel durumu yükleyin.',
  ASSIGNMENT_WINDOW_DISABLED:
    'Atama kabul penceresi şu anda etkin değil.',
};

/**
 * A rejected answer means the offer moved on the server (deadline passed or
 * another actor acted), so the detail must reload instead of keeping a stale
 * offer and stale buttons on screen.
 */
const ASSIGNMENT_WINDOW_STALE_CODES: readonly string[] = [
  'ACCEPTANCE_WINDOW_CLOSED',
  'ASSIGNMENT_OFFER_NOT_OPEN',
  'ASSIGNMENT_OFFER_ALREADY_OPEN',
  'CUSTOMER_TIME_MANAGEMENT_ONLY',
];

export function isAssignmentWindowStaleError(caught: unknown): boolean {
  return caught instanceof ApiError && ASSIGNMENT_WINDOW_STALE_CODES.includes(caught.code);
}

export function assignmentWindowErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    return ASSIGNMENT_WINDOW_MESSAGES[caught.code] ?? caught.message;
  }
  return caught instanceof Error ? caught.message : fallback;
}
