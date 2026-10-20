import { describe, expect, it } from 'vitest';

import { createCandidateIndex } from '../src/modules/crm/duplicate-candidates.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('CRM duplicate candidate enumeration', () => {
  it('PAIR-01/03: emits canonical, ordered, unique pairs across overlapping name and phone groups', () => {
    const index = createCandidateIndex([
      { id: id(3), name: 'Başka Klinik', phone: '05321234567', status: 'inactive' },
      { id: id(2), name: 'İSTANBUL KLİNİK', phone: '+905321234567', status: 'active' },
      { id: id(1), name: 'istanbul klinik', phone: '(0532) 123 45 67', status: 'prospect' },
    ]);
    expect([...index.pairs()]).toEqual([
      { customerAId: id(1), customerBId: id(2) },
      { customerAId: id(1), customerBId: id(3) },
      { customerAId: id(2), customerBId: id(3) },
    ]);
    expect(index.rawPairCount).toBe('3');
  });

  it('PAIR-04/06: pages an anchor through lower and higher UUID partners without unrelated pairs', () => {
    const index = createCandidateIndex([1, 2, 3, 4].map((n) => ({
      id: id(n), name: 'Ortak Klinik', phone: null, status: 'active' as const,
    })));
    expect([...index.pairs({ anchorCustomerId: id(2) })]).toEqual([
      { customerAId: id(1), customerBId: id(2) },
      { customerAId: id(2), customerBId: id(3) },
      { customerAId: id(2), customerBId: id(4) },
    ]);
    expect([...index.pairs({ anchorCustomerId: id(2), after: { customerAId: id(2), customerBId: id(3) } })])
      .toEqual([{ customerAId: id(2), customerBId: id(4) }]);
    expect([...index.pairs({ after: { customerAId: id(3), customerBId: id(4) } })]).toEqual([]);
  });
});
