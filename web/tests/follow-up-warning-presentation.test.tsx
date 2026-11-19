/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FollowUpProposalSection } from '../src/jobs/FollowUpProposalSection';
import type { CustomerScheduleEvaluation } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const warningEvaluation: CustomerScheduleEvaluation = {
  level: 'WARNING',
  safeMessage: 'Son 30 günde bu müşteriye üç takip ziyareti planlandı; yeni bir takip eklemeden önce teması doğrulayın.',
  conflicts: [],
  recentVisit: null,
  suggestedAlternativeAt: null,
};

function render(mode: 'manager' | 'staff', evaluation: CustomerScheduleEvaluation | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<FollowUpProposalSection
      mode={mode}
      draft={{
        scheduledAt: '2026-11-06T10:00:00.000Z',
        type: 'PRODUCT_DELIVERY',
        assignedTo: 'staff-1',
        followUpInstructions: 'Teslimat sonrası klinik ziyareti',
      }}
      origin={null}
      evaluation={evaluation}
      assigneeName="Ayşe Yılmaz"
      assignees={[{ id: 'staff-1', name: 'Ayşe Yılmaz' }]}
      allowTypeEdit={mode === 'manager'}
      inlineError={null}
      onChange={() => {}}
    />);
  });
  return host;
}

describe('Follow-up frequency warning presentation (C1 follow-up)', () => {
  it('labels the manager warning in text, not colour alone', () => {
    const host = render('manager', warningEvaluation);
    const warning = host.querySelector('.follow-up-frequency-warning');
    expect(warning).not.toBeNull();
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.querySelector('.follow-up-frequency-warning-label')?.textContent).toBe('Uyarı');
    expect(warning?.textContent).toContain('Son 30 günde bu müşteriye üç takip ziyareti planlandı');
    // The same advisory must not masquerade as a blocking field error.
    expect(host.querySelector('.field-error')).toBeNull();
  });

  it('does not render the frequency warning for a CLEAR evaluation', () => {
    const host = render('manager', { ...warningEvaluation, level: 'CLEAR', safeMessage: null });
    expect(host.querySelector('.follow-up-frequency-warning')).toBeNull();
  });
});
