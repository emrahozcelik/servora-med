import { useEffect, useState, type ReactNode } from 'react';
import { Steps } from 'antd';

export type WorkflowStepState = 'complete' | 'current' | 'upcoming' | 'skipped' | 'attention';

export type WorkflowStepItem = Readonly<{
  key: string;
  label: string;
  state: WorkflowStepState;
}>;

const STATE_TEXT: Record<WorkflowStepState, string> = {
  complete: 'Tamamlandı',
  current: 'Şu an',
  upcoming: 'Sırada',
  skipped: 'Atlandı',
  attention: 'Dikkat gerekiyor',
};

const ANT_STATUS: Record<WorkflowStepState, 'finish' | 'process' | 'wait' | 'error'> = {
  complete: 'finish',
  current: 'process',
  upcoming: 'wait',
  skipped: 'wait',
  attention: 'error',
};

function useDesktopShell() {
  const query = '(min-width: 64rem)';
  const [desktop, setDesktop] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
    setDesktop(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return desktop;
}

export function WorkflowSteps({ items, currentKey }: {
  items: readonly WorkflowStepItem[];
  currentKey: string | null;
}): ReactNode {
  const desktop = useDesktopShell();
  return <div className="servora-workflow-steps" role="list" aria-label="İş süreci">
    <Steps
      responsive={false}
      orientation={desktop ? 'horizontal' : 'vertical'}
      current={items.findIndex((item) => item.key === currentKey)}
      items={items.map((item) => ({
        key: item.key,
        status: ANT_STATUS[item.state],
        className: `servora-workflow-step servora-workflow-step--${item.state}`,
        title: <span aria-current={item.key === currentKey ? 'step' : undefined}>{item.label}</span>,
        content: <span className="servora-workflow-step-state">{STATE_TEXT[item.state]}</span>,
      }))}
    />
  </div>;
}
