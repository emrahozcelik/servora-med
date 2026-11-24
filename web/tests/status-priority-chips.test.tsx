import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PriorityChip } from '../src/ui/PriorityChip';
import { StatusChip } from '../src/ui/StatusChip';

describe('status and priority chips', () => {
  it('renders every canonical status with shape icon and Turkish label', () => {
    const expected: Array<[Parameters<typeof StatusChip>[0]['status'], string]> = [
      ['NEW', 'Atandı'],
      ['ACCEPTED', 'Kabul edildi'],
      ['IN_PROGRESS', 'Uygulanıyor'],
      ['WAITING_APPROVAL', 'Yönetici kontrolünde'],
      ['REVISION_REQUESTED', 'Düzeltme istendi'],
      ['COMPLETED', 'Tamamlandı'],
      ['CANCELLED', 'İptal edildi'],
      ['INVALIDATED', 'Geçersiz'],
    ];
    for (const [status, label] of expected) {
      const html = renderToStaticMarkup(<StatusChip status={status} />);
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(`status-chip--${status.toLowerCase()}`);
      expect(html).toContain(label);
      expect(html).toContain('status-chip-shape');
      expect(html).toContain('<svg');
      expect(html).toContain('aria-hidden="true"');
    }
  });

  it('renders every priority with icon and non-color-only label', () => {
    const expected: Array<[Parameters<typeof PriorityChip>[0]['priority'], string]> = [
      ['low', 'Düşük öncelik'],
      ['normal', 'Normal öncelik'],
      ['high', 'Yüksek öncelik'],
      ['urgent', 'Acil öncelik'],
    ];
    for (const [priority, label] of expected) {
      const html = renderToStaticMarkup(<PriorityChip priority={priority} longLabel />);
      expect(html).toContain(`data-priority="${priority}"`);
      expect(html).toContain(`priority-chip--${priority}`);
      expect(html).toContain('priority-chip-icon');
      expect(html).toContain('<svg');
      expect(html).toContain(label);
    }
  });
});
