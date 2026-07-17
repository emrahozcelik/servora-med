import type { CompactWorkflowSummary as CompactWorkflowSummaryModel } from './job-workflow-presentation';

export function CompactWorkflowSummary({
  summary,
  assigneeName,
}: {
  summary: CompactWorkflowSummaryModel;
  assigneeName: string;
}) {
  const secondary = summary.attention
    ? 'Yönetici notu mevcut'
    : summary.expectedRole === 'MANAGEMENT'
      ? 'İşlem beklenen: Yönetici'
      : summary.expectedRole === 'STAFF'
        ? `İşlem beklenen: ${assigneeName}`
        : 'İşlem beklenmiyor';

  return (
    <div className={`compact-workflow${summary.attention ? ' compact-workflow--attention' : ''}`}>
      <p>
        {summary.ordinal !== null && (
          <>
            <strong>{summary.ordinal} / {summary.total}</strong>
            {' · '}
          </>
        )}
        {summary.label}
      </p>
      <span>{secondary}</span>
    </div>
  );
}
