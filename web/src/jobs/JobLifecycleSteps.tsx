import type { ReactNode } from 'react';

import type { JobWorkflowPresentation, WorkflowPhaseState } from './job-workflow-presentation';

const PHASE_STATE_TEXT: Record<WorkflowPhaseState, string> = {
  complete: 'Tamamlandı',
  current: 'Şu an',
  upcoming: 'Sırada',
  skipped: 'Atlandı',
  attention: 'Dikkat gerekiyor',
};

const PHASE_STATE_ICON: Record<WorkflowPhaseState, string> = {
  complete: '✓',
  current: '●',
  upcoming: '○',
  skipped: '–',
  attention: '!',
};

export function JobLifecycleSteps({
  phaseItems,
  currentPhase,
}: {
  phaseItems: JobWorkflowPresentation['phaseItems'];
  currentPhase: JobWorkflowPresentation['currentPhase'];
}): ReactNode {
  return (
    <ol className="job-lifecycle-steps" aria-label="İş süreci">
      {phaseItems.map((item) => {
        const isCurrent = currentPhase !== null && item.phase === currentPhase
          && (item.state === 'current' || item.state === 'attention');
        return (
          <li
            key={item.phase}
            className={`job-lifecycle-step job-lifecycle-step-${item.state}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span className="job-lifecycle-step-icon" aria-hidden="true">
              {PHASE_STATE_ICON[item.state]}
            </span>
            <span className="job-lifecycle-step-body">
              <span className="job-lifecycle-step-label">{item.label}</span>
              <span className="job-lifecycle-step-state">{PHASE_STATE_TEXT[item.state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
