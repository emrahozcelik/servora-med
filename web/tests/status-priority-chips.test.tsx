import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PriorityChip } from '../src/ui/PriorityChip';
import { StatusChip } from '../src/ui/StatusChip';

describe('status and priority chips', () => {
  it('renders status with shape and Turkish label', () => {
    const html = renderToStaticMarkup(<StatusChip status="WAITING_APPROVAL" />);
    expect(html).toContain('data-status="WAITING_APPROVAL"');
    expect(html).toContain('Yönetici kontrolünde');
    expect(html).toContain('status-chip-shape');
    expect(html).toContain('aria-hidden="true"');
  });

  it('renders priority with non-color-only label', () => {
    const html = renderToStaticMarkup(<PriorityChip priority="urgent" longLabel />);
    expect(html).toContain('data-priority="urgent"');
    expect(html).toContain('Acil öncelik');
    expect(html).toContain('priority-chip--urgent');
  });
});
