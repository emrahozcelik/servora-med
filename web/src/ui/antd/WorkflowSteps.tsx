import { useEffect, useState, type ReactNode } from 'react';
import { Steps } from 'antd';

import { SignalGlyph } from '../signal-icons';

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

/**
 * Revision-loop attention is an attention state, not a failure. Critical Red and
 * Ant's `error` status stay reserved for errors and destructive outcomes
 * (DESIGN.md semantic colors, DECISIONS.md UI-005); the amber color and the
 * explicit state text carry the meaning instead.
 */
const ANT_STATUS: Record<WorkflowStepState, 'finish' | 'process' | 'wait'> = {
  complete: 'finish',
  current: 'process',
  upcoming: 'wait',
  skipped: 'wait',
  attention: 'process',
};

const STATE_ICON: Partial<Record<WorkflowStepState, string>> = {
  attention: '⚠',
};

/**
 * Revision attention replaces Ant's numeric `process` icon with an owned amber
 * marker. Ant paints the `process` icon shell with the primary color at a
 * specificity that a stylesheet override cannot beat without `!important`, so the
 * awareness state owns the whole icon surface instead (DECISIONS.md UI-005).
 */
function attentionIcon(): ReactNode {
  return (
    <span className="servora-workflow-attention-icon" aria-hidden="true">!</span>
  );
}

/**
 * UI-005 compact strip: five small phase markers joined by a line. The markers
 * are decorative (the ordered list below carries the phase names), so they stay
 * `aria-hidden`; complete is a filled check, current a ring, upcoming hollow,
 * attention Delay Amber with its own `!` glyph.
 */
function StageMarkers({ items }: { items: readonly WorkflowStepItem[] }): ReactNode {
  return (
    <span className="servora-workflow-stages" aria-hidden="true" data-workflow-stages="true">
      {items.map((item) => (
        <span
          key={item.key}
          className={`servora-workflow-stage servora-workflow-stage--${item.state}`}
          data-stage-state={item.state}
        >
          {item.state === 'complete' && (
            <SignalGlyph name="check" className="servora-workflow-stage-glyph" size={10} />
          )}
          {item.state === 'attention' && (
            <span className="servora-workflow-stage-attention-glyph">!</span>
          )}
        </span>
      ))}
    </span>
  );
}

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
  const currentIndex = items.findIndex((item) => item.key === currentKey);
  const currentItem = currentIndex >= 0 ? items[currentIndex] : undefined;

  const steps = (
    <div aria-hidden="true">
      <Steps
        responsive={false}
        orientation={desktop ? 'horizontal' : 'vertical'}
        current={currentIndex}
        items={items.map((item) => ({
          key: item.key,
          status: ANT_STATUS[item.state],
          className: `servora-workflow-step servora-workflow-step--${item.state}`,
          title: item.label,
          icon: item.state === 'attention' ? attentionIcon() : undefined,
          content: (
            <span className="servora-workflow-step-state">
              {STATE_ICON[item.state]
                ? <span className="servora-workflow-step-state-icon">{STATE_ICON[item.state]}</span>
                : null}
              {STATE_TEXT[item.state]}
            </span>
          ),
        }))}
      />
    </div>
  );

  return (
    <section
      className={desktop
        ? 'servora-workflow-steps'
        : 'servora-workflow-steps servora-workflow-steps--compact'}
      aria-labelledby="job-workflow-title"
    >
      <h2 id="job-workflow-title" className="sr-only">
        İş süreci
      </h2>

      {/* Native list for screen readers — Ant Steps root/items are divs without listitem.
          It stays outside the mobile disclosure so the full phase list is always
          available without expanding the visual stepper. */}
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

      {desktop ? steps : (
        <details className="servora-workflow-steps-disclosure" data-workflow-compact="true">
          <summary
            className={currentItem?.state === 'attention'
              ? 'servora-workflow-steps-summary servora-workflow-steps-summary--attention'
              : 'servora-workflow-steps-summary'}
          >
            <StageMarkers items={items} />
            <span className="servora-workflow-steps-summary-phase">
              {currentItem ? (
                <>
                  <strong>{currentIndex + 1} / {items.length}</strong>
                  {' · '}
                  {/* Attention trades the phase name for its explicit state word
                      so the one-row strip still says why it is amber; the phase
                      name stays in the markers and the ordered list. */}
                  {currentItem.state === 'attention' ? STATE_TEXT.attention : currentItem.label}
                </>
              ) : 'İş süreci'}
            </span>
          </summary>
          {steps}
        </details>
      )}
    </section>
  );
}
