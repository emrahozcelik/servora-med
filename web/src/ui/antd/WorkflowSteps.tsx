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
  return (
    <section
      className="servora-workflow-steps"
      aria-labelledby="job-workflow-title"
    >
      <h2 id="job-workflow-title" className="sr-only">
        İş süreci
      </h2>

      {/* Native list for screen readers — Ant Steps root/items are divs without listitem. */}
      <ol className="sr-only" aria-label="İş süreci">
        {items.map((item) => (
          <li
            key={item.key}
            aria-current={item.key === currentKey ? 'step' : undefined}
          >
            {item.label}: {STATE_TEXT[item.state]}
          </li>
        ))}
      </ol>

      <div aria-hidden="true">
        <Steps
          responsive={false}
          orientation={desktop ? 'horizontal' : 'vertical'}
          current={items.findIndex((item) => item.key === currentKey)}
          items={items.map((item) => ({
            key: item.key,
            status: ANT_STATUS[item.state],
            className: `servora-workflow-step servora-workflow-step--${item.state}`,
            title: item.label,
            content: (
              <span className="servora-workflow-step-state">
                {STATE_TEXT[item.state]}
              </span>
            ),
          }))}
        />
      </div>
    </section>
  );
}
